import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readlink, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const MANIFEST = '.yoloharness-workspace-manifest.json';
function harnessOwned(key) { return key === '.yolo/last-receipt.json' || key === '.yolo/runs' || key.startsWith('.yolo/runs/'); }

function excluded(name, excludedNames) { return excludedNames.has(name); }
function normalizeExclusions(names) {
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name || name.includes('/') || name === '.' || name === '..')) throw new TypeError('invalid dependency directory names');
  return new Set(names);
}
async function digest(path, info) {
  info ??= await lstat(path);
  if (info.isFile()) return `file:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
  if (info.isSymbolicLink()) return `symlink:${await readlink(path)}`;
  if (!info.isDirectory()) throw new Error(`unsupported workspace entry type: ${path}`);
  const parts = [];
  for (const name of (await readdir(path)).sort()) parts.push(`${name}:${await digest(join(path, name))}`);
  return `dir:${createHash('sha256').update(parts.join('\n')).digest('hex')}`;
}
async function manifestFor(root, excludedNames, current = root) {
  const result = {};
  for (const name of (await readdir(current)).sort()) {
    if (current === root && name === MANIFEST || excluded(name, excludedNames)) continue;
    const path = join(current, name); const info = await lstat(path); const key = relative(root, path);
    if (harnessOwned(key)) continue;
    result[key] = await digest(path, info);
    if (info.isDirectory()) Object.assign(result, await manifestFor(root, excludedNames, path));
  }
  return result;
}
async function copyEntry(source, target) {
  const info = await lstat(source);
  await mkdir(dirname(target), { recursive: true });
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true, mode: info.mode & 0o7777 });
    for (const name of await readdir(source)) await copyEntry(join(source, name), join(target, name));
  } else if (info.isFile()) await copyFile(source, target);
  else if (info.isSymbolicLink()) await symlink(await readlink(source), target);
  else throw new Error(`unsupported workspace entry type: ${source}`);
  await chmod(target, info.mode & 0o7777).catch(() => {});
}
async function entries(root, excludedNames, current = root) {
  const result = [];
  for (const name of (await readdir(current)).sort()) {
    if (current === root && name === MANIFEST || excluded(name, excludedNames)) continue;
    const path = join(current, name); const info = await lstat(path); const key = relative(root, path);
    if (harnessOwned(key)) continue;
    result.push([key, path, info]);
    if (info.isDirectory()) result.push(...await entries(root, excludedNames, path));
  }
  return result;
}
async function copyTreeFiltered(source, target, excludedNames) {
  await mkdir(target, { recursive: true });
  for (const name of await readdir(source)) {
    if (name === MANIFEST || excluded(name, excludedNames)) continue;
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    const info = await lstat(sourcePath);
    if (info.isDirectory()) await copyTreeFiltered(sourcePath, targetPath, excludedNames);
    else await copyEntry(sourcePath, targetPath);
    if (info.isDirectory()) await chmod(targetPath, info.mode & 0o7777);
  }
}

export async function seedWorkspace(source, staged, dependencyNames = []) {
  const excludedNames = normalizeExclusions(dependencyNames);
  await rm(staged, { recursive: true, force: true }); await mkdir(staged, { recursive: true });
  await copyTreeFiltered(source, staged, excludedNames);
  const sourceInfo = await lstat(source); await chmod(staged, sourceInfo.mode & 0o7777);
  const manifest = await manifestFor(source, excludedNames);
  await writeFile(join(staged, MANIFEST), JSON.stringify({ version: 1, excluded: [...excludedNames], entries: manifest }) + '\n', { mode: 0o600 });
}

export async function publishWorkspace(staged, source, dependencyNames = []) {
  const excludedNames = normalizeExclusions(dependencyNames);
  let baseline;
  try { baseline = JSON.parse(await readFile(join(staged, MANIFEST), 'utf8')); } catch { baseline = { version: 1, entries: {} }; }
  if (baseline.version !== 1 || !baseline.entries || typeof baseline.entries !== 'object') throw new Error('workspace publication manifest is malformed');
  const currentHost = await manifestFor(source, excludedNames);
  const stagedEntries = await entries(staged, excludedNames);
  for (const [key, path] of stagedEntries) {
    if ((await lstat(path)).isDirectory()) continue;
    const target = join(source, key); const before = baseline.entries[key]; const targetExists = await lstat(target).then(() => true).catch(() => false);
    const after = await digest(path);
    if (targetExists) {
      const now = currentHost[key];
      if (before === undefined ? now !== after : (now !== before && after !== before && now !== after)) throw new Error(`workspace publication conflict: ${key}`);
      if (after === before) continue;
      await rm(target, { recursive: true, force: true });
    }
    await copyEntry(path, target);
  }
  for (const key of Object.keys(baseline.entries).sort((a, b) => b.length - a.length)) {
    if (Object.hasOwn(currentHost, key) && !stagedEntries.some(([name]) => name === key || name.startsWith(`${key}/`))) {
      const target = join(source, key);
      if ((await lstat(target).catch(() => null)) && currentHost[key] !== baseline.entries[key]) throw new Error(`workspace publication conflict: ${key}`);
      await rm(target, { recursive: true, force: true });
    }
  }
}

export { MANIFEST };
