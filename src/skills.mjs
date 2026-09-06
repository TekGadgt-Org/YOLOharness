import { access, chmod, cp, lstat, mkdir, open, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const APP = 'yoloharness';
const MAX_SKILL_BUNDLE = 64 * 1024;
const MAX_SKILL_FILE = 64 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
async function regular(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError(`${label} must be a regular file`);
  if (info.size > MAX_SKILL_FILE) throw new RangeError(`${label} exceeds size limit`);
  return info;
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
    catalog[name] = { name, source, path: file, size: (await lstat(file)).size };
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
    output[rel] = (await readFile(path)).toString('utf8');
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
  return { name: entry.name, instructions, resource: resource === undefined ? undefined : files[resource], resources: Object.keys(files).filter(key => key !== 'SKILL.md') };
}
export async function snapshotSkills(cwd = process.cwd(), sharedRoot = sharedSkillsRoot()) {
  const catalog = await collectSkills(cwd, sharedRoot);
  const snapshot = {};
  let size = 0;
  for (const [name, entry] of Object.entries(catalog)) {
    const loaded = await loadSkill(entry, { root: sharedRoot, cwd });
    const value = { name, source: entry.source, instructions: loaded.instructions, resources: {} };
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
  if (resource === undefined) return { name, instructions: skill.instructions, resources: Object.keys(skill.resources ?? {}) };
  if (typeof resource !== 'string' || resource.includes('..') || resource.startsWith('/') || typeof skill.resources?.[resource] !== 'string') throw new TypeError('invalid skill resource');
  return { name, resource, content: skill.resources[resource] };
}
export { MAX_SKILL_BUNDLE };
