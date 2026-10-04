import { access, chmod, cp, lstat, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const APP = 'yoloharness';
const MAX_SKILL_BUNDLE = 64 * 1024;
const MAX_SKILL_FILE = 64 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OWNED = '.yolo-skill-owned';

function rootFor(value, fallback) {
  if (typeof value === 'string' && isAbsolute(value)) return value;
  return fallback;
}
export function sharedSkillsRoot(env = process.env) {
  const home = rootFor(env.HOME, homedir());
  return join(rootFor(env.XDG_DATA_HOME, join(home, '.local', 'share')), APP, 'skills');
}
function localSkillsRoot(cwd) { return join(cwd, '.agents', 'skills'); }
function safeName(name) { if (!NAME.test(name)) throw new TypeError(`invalid skill name: ${name}`); }
function decode(bytes, label) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new TypeError(`${label} is not valid UTF-8`); } }
async function regular(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new TypeError(`${label} must be a regular file`);
  if (info.size > MAX_SKILL_FILE) throw new RangeError(`${label} exceeds size limit`);
  return info;
}
function metadata(text, name) {
  if (!text.startsWith('---\n')) return { name, description: null };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) throw new TypeError(`${name}/SKILL.md has malformed frontmatter`);
  const values = {};
  const seen = new Set();
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^(name|description):[ \t]*(.*)$/.exec(line);
    if (!match || !match[2].trim()) throw new TypeError(`${name}/SKILL.md has invalid frontmatter`);
    if (seen.has(match[1])) throw new TypeError(`${name}/SKILL.md has duplicate frontmatter`);
    seen.add(match[1]);
    values[match[1]] = match[2].trim();
  }
  if (seen.size !== 2 || values.name !== name || !NAME.test(values.name) || !values.description || values.description.length > 512) throw new TypeError(`${name}/SKILL.md metadata does not match skill`);
  return values;
}
async function findSkillNames(...roots) {
  const result = new Set();
  for (const root of roots) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink() && NAME.test(entry.name)) result.add(entry.name);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [...result].sort();
}
export async function collectSkills(cwd = process.cwd(), sharedRoot = sharedSkillsRoot()) {
  const local = localSkillsRoot(cwd);
  const shared = sharedRoot;
  const catalog = {};
  for (const name of await findSkillNames(local, shared)) {
    const localFile = join(local, name, 'SKILL.md');
    const sharedFile = join(shared, name, 'SKILL.md');
    let file; let source;
    try { await regular(localFile, `${name}/SKILL.md`); file = localFile; source = 'local'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await regular(sharedFile, `${name}/SKILL.md`); file = sharedFile; source = 'shared'; }
    const text = decode(await readFile(file), `${name}/SKILL.md`);
    catalog[name] = { ...metadata(text, name), source, path: file, size: (await lstat(file)).size };
  }
  return catalog;
}
async function snapshot(root, base, total = { size: 0 }, output = {}) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    const rel = relative(base, path);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new TypeError(`skill resource is not a regular file: ${rel}`);
    if (entry.isDirectory()) { await snapshot(path, base, total, output); continue; }
    const info = await regular(path, rel); total.size += info.size;
    if (total.size > MAX_SKILL_BUNDLE) throw new RangeError('skill resources exceed bundle size limit');
    output[rel] = decode(await readFile(path), rel);
  }
  return output;
}
export async function loadSkill(entry, { root, cwd = process.cwd(), resource } = {}) {
  if (!entry?.name || !entry.path) throw new TypeError('skill catalog entry is required');
  const base = entry.source === 'local' ? localSkillsRoot(cwd) : root;
  const skillRoot = resolve(base, entry.name);
  if (!skillRoot.startsWith(`${resolve(base)}/`)) throw new TypeError('skill path escapes skill root');
  const instructions = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
  const files = await snapshot(skillRoot, skillRoot);
  if (resource !== undefined) {
    if (typeof resource !== 'string' || resource.includes('..') || resource.startsWith('/') || !(resource in files)) throw new TypeError('invalid skill resource');
  }
  return { name: entry.name, source: entry.source, description: entry.description ?? null, instructions, resource: resource === undefined ? undefined : files[resource], resources: Object.keys(files).filter(key => key !== 'SKILL.md') };
}
export async function snapshotSkills(cwd = process.cwd(), sharedRoot = sharedSkillsRoot()) {
  const catalog = await collectSkills(cwd, sharedRoot);
  const snapshot = {};
  let size = 0;
  for (const [name, entry] of Object.entries(catalog)) {
    const loaded = await loadSkill(entry, { root: sharedRoot, cwd });
    const value = { name, source: entry.source, description: entry.description ?? null, instructions: loaded.instructions, resources: {} };
    for (const resource of loaded.resources) {
      const item = await loadSkill(entry, { root: sharedRoot, cwd, resource });
      value.resources[resource] = item.resource;
    }
    size += Buffer.byteLength(JSON.stringify(value));
    if (size > MAX_SKILL_BUNDLE) throw new RangeError('skill bundle exceeds size limit');
    snapshot[name] = value;
  }
  return snapshot;
}
// Container-side progressive loader for the bounded bootstrap snapshot. Skill
// text is untrusted instruction/data and never changes the authority policy.
export function skill_load(skills, name, resource) {
  safeName(name);
  const skill = skills?.[name];
  if (!skill || typeof skill.instructions !== 'string') throw new TypeError('skill is not in the catalog');
  if (resource === undefined) return { name, ...(skill.source === undefined ? {} : { source: skill.source }), instructions: skill.instructions, resources: Object.keys(skill.resources ?? {}) };
  if (typeof resource !== 'string' || resource.includes('..') || resource.startsWith('/') || typeof skill.resources?.[resource] !== 'string') throw new TypeError('invalid skill resource');
  return { name, ...(skill.source === undefined ? {} : { source: skill.source }), resource, content: skill.resources[resource] };
}
export { MAX_SKILL_BUNDLE };

async function validateTree(root, name) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('skill source must be a real directory');
  let total = 0;
  async function visit(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === OWNED) continue;
      const child = join(path, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new TypeError('skill source contains an unsafe entry');
      if (entry.isDirectory()) await visit(child, prefix ? `${prefix}/${entry.name}` : entry.name);
      else {
        const file = await regular(child, `skill resource ${entry.name}`);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (rel !== 'SKILL.md' && !rel.startsWith('resources/')) throw new TypeError('skill resources must be below resources/');
        total += file.size;
        if (total > MAX_SKILL_BUNDLE) throw new RangeError('skill bundle exceeds size limit');
      }
    }
  }
  const skillFile = join(root, 'SKILL.md');
  const stat = await regular(skillFile, `${name}/SKILL.md`);
  const text = decode(await readFile(skillFile), `${name}/SKILL.md`);
  const parsed = metadata(text, name);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name !== 'SKILL.md' && entry.name !== 'resources') throw new TypeError('skill directory has unsupported top-level entry');
    if (entry.name === 'resources' && !entry.isDirectory()) throw new TypeError('resources must be a directory');
  }
  await visit(root);
  return { ...parsed, size: stat.size };
}

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === OWNED) continue;
    const from = join(source, entry.name); const to = join(destination, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new TypeError('skill source contains an unsafe entry');
    if (entry.isDirectory()) await copyTree(from, to);
    else await cp(from, to, { errorOnExist: true, force: false });
  }
}

export async function installSkill(source, sharedRoot = sharedSkillsRoot(), { name } = {}) {
  if (typeof source !== 'string' || !isAbsolute(source)) throw new TypeError('local skill source must be an absolute path');
  const sourceInfo = await lstat(source);
  const sourceRoot = sourceInfo.isDirectory() ? source : dirname(source);
  if (!sourceInfo.isDirectory()) {
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || sourceInfo.size > MAX_SKILL_FILE) throw new TypeError('skill source must be a real directory or SKILL.md file');
    if (sourceInfo.isFile() && source.endsWith('.md')) {
      const fileName = basename(source, '.md');
      safeName(name ?? fileName);
      const temp = `${source}.skill-${randomUUID()}`;
      await mkdir(temp, { mode: 0o700 });
      try { await cp(source, join(temp, 'SKILL.md')); return await installSkill(temp, sharedRoot, { name: name ?? fileName }); }
      finally { await rm(temp, { recursive: true, force: true }); }
    }
    throw new TypeError('skill source must be a real directory or SKILL.md file');
  }
  const inferred = name ?? (await (async () => { const text = await readFile(join(sourceRoot, 'SKILL.md'), 'utf8'); return text.startsWith('---\n') ? /^name:[ \t]*(.+)$/m.exec(text)?.[1]?.trim() : sourceRoot.split('/').pop(); })());
  safeName(inferred);
  const parsed = await validateTree(sourceRoot, inferred);
  if (parsed.name !== inferred) throw new TypeError('skill name does not match source metadata');
  await mkdir(sharedRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(sharedRoot); if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new TypeError('unsafe shared skills root');
  const anchoredRoot = resolve(sharedRoot);
  const destination = join(anchoredRoot, inferred); const staging = join(anchoredRoot, `.staging-${randomUUID()}`);
  if (!destination.startsWith(`${anchoredRoot}/`)) throw new TypeError('unsafe shared skill destination');
  try { await lstat(destination); throw new Error(`skill already installed: ${inferred}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    await copyTree(sourceRoot, staging);
    await writeFile(join(staging, OWNED), JSON.stringify({ version: 1, name: inferred }) + '\n', { flag: 'wx', mode: 0o600 });
    // Directory rename replaces an existing directory on Unix. Reserve the
    // destination with mkdir instead, so a concurrent creator wins or makes
    // this install fail; never merge into or replace its tree.
    await mkdir(destination, { mode: 0o700 });
    await copyTree(staging, destination);
    await writeFile(join(destination, OWNED), JSON.stringify({ version: 1, name: inferred }) + '\n', { flag: 'wx', mode: 0o600 });
    await rm(staging, { recursive: true, force: false });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') throw new Error(`skill already installed: ${inferred}`);
    throw error;
  }
  return { name: inferred, source: 'shared', description: parsed.description ?? null, path: destination };
}

export async function listSkills(sharedRoot = sharedSkillsRoot()) {
  const catalog = await collectSkills(process.cwd(), sharedRoot);
  return Object.values(catalog).map(({ name, source, description }) => ({ name, source, description: description ?? null }));
}

export async function uninstallSkill(name, sharedRoot = sharedSkillsRoot()) {
  safeName(name);
  let rootInfo;
  try { rootInfo = await lstat(sharedRoot); } catch (error) { if (error.code === 'ENOENT') return { name, removed: false, notInstalled: true }; throw error; }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new TypeError('unsafe shared skills root');
  const destination = join(sharedRoot, name); let info;
  try { info = await lstat(destination); } catch (error) { if (error.code === 'ENOENT') return { name, removed: false, notInstalled: true }; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError('shared skill is not a safely owned directory');
  let marker;
  try { marker = JSON.parse(await readFile(join(destination, OWNED), 'utf8')); } catch { throw new Error('refusing to remove an unowned shared skill'); }
  if (marker?.version !== 1 || marker.name !== name) throw new Error('refusing to remove an unowned shared skill');
  async function check(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === OWNED && path === destination) continue;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()) || (entry.isFile() && (await lstat(join(path, entry.name))).nlink > 1)) throw new Error('refusing to remove an unsafe shared skill');
      if (entry.isDirectory()) await check(join(path, entry.name));
    }
  }
  await check(destination);
  await rm(destination, { recursive: true, force: false });
  return { name, removed: true };
}
