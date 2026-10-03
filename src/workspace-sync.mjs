import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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
    await mkdir(target, { recursive: true, mode: info.mode & 0o777 });
    for (const name of await readdir(source)) await copyEntry(join(source, name), join(target, name));
  } else if (info.isFile()) {
    if (info.nlink > 1) throw new Error(`unsupported hardlink workspace entry: ${source}`);
    const temporary = `${target}.yoloharness-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await copyFile(source, temporary);
    await chmod(temporary, info.mode & 0o777);
    await rename(temporary, target);
  }
  else if (info.isSymbolicLink()) await symlink(await readlink(source), target);
  else throw new Error(`unsupported workspace entry type: ${source}`);
  if (!info.isSymbolicLink() && !info.isFile()) await chmod(target, info.mode & 0o777);
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
    if (name === MANIFEST || name.startsWith('.yoloharness-publication-') || excluded(name, excludedNames)) continue;
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    const info = await lstat(sourcePath);
    if (info.isDirectory()) await copyTreeFiltered(sourcePath, targetPath, excludedNames);
    else await copyEntry(sourcePath, targetPath);
    if (info.isDirectory()) await chmod(targetPath, info.mode & 0o777);
  }
}

export async function seedWorkspace(source, staged, dependencyNames = [], baselinePath = join(staged, MANIFEST)) {
  const excludedNames = normalizeExclusions(dependencyNames);
  await rm(staged, { recursive: true, force: true }); await mkdir(staged, { recursive: true });
  await copyTreeFiltered(source, staged, excludedNames);
  const sourceInfo = await lstat(source); await chmod(staged, sourceInfo.mode & 0o777);
  const manifest = await manifestFor(source, excludedNames);
  await writeFile(baselinePath, JSON.stringify({ version: 1, excluded: [...excludedNames], entries: manifest }) + '\n', { mode: 0o600 });
  if (baselinePath !== join(staged, MANIFEST)) await rm(join(staged, MANIFEST), { force: true });
}

async function safeTarget(source, key) {
  const parts = key.split('/'); let current = source;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part); const info = await lstat(current).catch(() => null);
    if (info && !info.isDirectory()) throw new Error(`unsafe workspace publication target: ${key}`);
  }
}

const JOURNAL_VERSION = 2;
const MAX_JOURNAL_BYTES = 16 * 1024;
function journalName(source) { return `${source.split('/').pop()}.yoloharness-publication.json`; }
function procPath(handle, name) { return `/proc/self/fd/${handle.fd}/${name}`; }
function baseName(source) { return source.split('/').pop(); }
function validateJournal(state, source) {
  const sourceName = baseName(source);
  const candidateName = state?.candidateName;
  const backupName = state?.backupName;
  const validName = value => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);
  const validCandidate = value => validName(value) && value.startsWith('.yoloharness-publication-');
  const validBackup = value => validName(value) && value.startsWith(`${sourceName}.yoloharness-backup-`);
  if (!state || state.version !== JOURNAL_VERSION || state.sourceName !== sourceName ||
      !validCandidate(candidateName) || !validBackup(backupName) || candidateName === backupName ||
      !['prepared', 'source-renamed', 'candidate-renamed', 'backup-removed'].includes(state.phase) ||
      (['prepared', 'candidate-renamed'].includes(state.phase) !== state.candidateInSource) ||
      (state.phase === 'backup-removed' && state.backupPresent !== false)) {
    throw new Error('workspace publication journal is malformed');
  }
  return state;
}
async function readJournal(source, parentHandle) {
  const path = procPath(parentHandle, journalName(source));
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.size > MAX_JOURNAL_BYTES) throw new Error('workspace publication journal is invalid');
  return validateJournal(JSON.parse(await readFile(path, 'utf8')), source);
}
async function writeJournal(source, state, parentHandle) {
  validateJournal(state, source);
  const path = procPath(parentHandle, journalName(source));
  const handle = await open(path, 'w', 0o600);
  try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync(); } finally { await handle.close(); }
  await parentHandle.sync();
}
async function removeJournal(source, parentHandle) {
  await rm(procPath(parentHandle, journalName(source)), { force: true });
  await parentHandle.sync();
}

async function recoverPublication(source) {
  const parentHandle = await open(dirname(source), fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try {
    const state = await readJournal(source, parentHandle); if (!state) return false;
    const root = name => procPath(parentHandle, name);
    const sourcePath = root(state.sourceName); const backupPath = root(state.backupName);
    let candidatePath = ['prepared', 'candidate-renamed'].includes(state.phase) ? join(sourcePath, state.candidateName) : join(backupPath, state.candidateName);
    const sourceInfo = await lstat(sourcePath).catch(() => null);
    const backupInfo = await lstat(backupPath).catch(() => null);
    if (!sourceInfo && backupInfo) { await rename(backupPath, sourcePath); await parentHandle.sync(); candidatePath = join(sourcePath, state.candidateName); }
    else if (sourceInfo && backupInfo) { await rm(backupPath, { recursive: true, force: true }); await parentHandle.sync(); }
    else if (!sourceInfo) throw new Error('workspace publication recovery is incomplete');
    await rm(candidatePath, { recursive: true, force: true }); await parentHandle.sync();
    await removeJournal(source, parentHandle); return true;
  } finally { await parentHandle.close(); }
}

export async function inspectPublication(source) {
  const absolute = source.startsWith('/') ? source : join(process.cwd(), source);
  const parentHandle = await open(dirname(absolute), fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  const state = await readJournal(absolute, parentHandle);
  if (!state) { await parentHandle.close(); return { version: 1, retained: false, source: absolute }; }
  const sourcePath = procPath(parentHandle, state.sourceName); const backupPath = procPath(parentHandle, state.backupName);
  const candidatePath = ['prepared', 'candidate-renamed'].includes(state.phase) ? join(sourcePath, state.candidateName) : join(backupPath, state.candidateName);
  const [sourceInfo, candidateInfo, backupInfo] = await Promise.all([lstat(sourcePath).catch(() => null), lstat(candidatePath).catch(() => null), lstat(backupPath).catch(() => null)]);
  await parentHandle.close();
  return { version: 1, retained: true, source: absolute, phase: state.phase, source_present: Boolean(sourceInfo), candidate_present: Boolean(candidateInfo), backup_present: Boolean(backupInfo) };
}
export async function recoverPublicationState(source) { const absolute = source.startsWith('/') ? source : join(process.cwd(), source); return recoverPublication(absolute); }
export async function discardPublication(source) {
  const absolute = source.startsWith('/') ? source : join(process.cwd(), source); const parentHandle = await open(dirname(absolute), fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try { const state = await readJournal(absolute, parentHandle); if (!state) return false;
    await rm(procPath(parentHandle, state.backupName), { recursive: true, force: true });
    await rm(join(procPath(parentHandle, state.sourceName), state.candidateName), { recursive: true, force: true });
    await rm(join(procPath(parentHandle, state.backupName), state.candidateName), { recursive: true, force: true });
    await parentHandle.sync(); await removeJournal(absolute, parentHandle); return true;
  } finally { await parentHandle.close(); }
}

export async function publishWorkspace(staged, source, dependencyNames = [], baselinePath = join(staged, MANIFEST)) {
  const excludedNames = normalizeExclusions(dependencyNames);
  await recoverPublication(source);
  let baseline;
  try { baseline = JSON.parse(await readFile(baselinePath, 'utf8')); } catch { baseline = { version: 1, entries: {} }; }
  if (baseline.version !== 1 || !baseline.entries || typeof baseline.entries !== 'object') throw new Error('workspace publication manifest is malformed');
  const currentHost = await manifestFor(source, excludedNames);
  const stagedEntries = await entries(staged, excludedNames);
  // Complete validation happens before creating or mutating the publication tree.
  for (const [key, path, info] of stagedEntries) {
    if (info.isSymbolicLink()) {
      const unchanged = baseline.entries[key] === await digest(path) && currentHost[key] === baseline.entries[key];
      if (!unchanged) throw new Error(`unsupported staged workspace entry type: ${key}`);
      continue;
    }
    if (!info.isFile() && !info.isDirectory()) throw new Error(`unsupported staged workspace entry type: ${key}`);
    if (info.isFile() && info.nlink > 1) throw new Error(`unsupported hardlink workspace entry: ${key}`);
    await safeTarget(source, key);
  }
  for (const [key, path, info] of stagedEntries) {
    if (info.isSymbolicLink() || info.isDirectory()) continue;
    const after = await digest(path);
    const before = baseline.entries[key];
    const now = currentHost[key];
    if (before === undefined ? now !== undefined && now !== after : now !== before && after !== before && now !== after) {
      throw new Error(`workspace publication conflict: ${key}`);
    }
  }
  const stagedKeys = new Set(stagedEntries.map(([key]) => key));
  for (const key of Object.keys(baseline.entries).sort((a, b) => b.length - a.length)) {
    if (Object.hasOwn(currentHost, key) && !stagedEntries.some(([name]) => name === key || name.startsWith(`${key}/`))) {
      await safeTarget(source, key);
      const targetInfo = await lstat(join(source, key)).catch(() => null);
      if (targetInfo?.isSymbolicLink()) throw new Error(`unsafe workspace publication target: ${key}`);
      if (targetInfo && currentHost[key] !== baseline.entries[key]) throw new Error(`workspace publication conflict: ${key}`);
    }
  }

  // Build an entire replacement tree off to the side. Host state is not touched
  // until every conflict and staged type has passed validation.
  const parent = dirname(source);
  // The helper has a read-only root and only /source is writable.  Keep the
  // candidate below source so it is writable and remains on the same mount.
  const parentHandle = await open(parent, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  const anchored = value => procPath(parentHandle, value.slice(parent === '/' ? 1 : parent.length + 1));
  const sourceName = baseName(source);
  const candidateName = `.yoloharness-publication-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const candidate = join(source, candidateName);
  const backupName = `${sourceName}.yoloharness-backup-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let phase = 'prepared';
  try {
    await mkdir(anchored(candidate), { mode: 0o700 });
    await copyTreeFiltered(anchored(source), anchored(candidate), new Set());
    for (const [key, path] of stagedEntries) {
      const stagedInfo = await lstat(path);
      if (stagedInfo.isSymbolicLink() || stagedInfo.isDirectory()) continue;
      if (baseline.entries[key] === await digest(path)) continue;
      const target = join(candidate, key);
      await safeTarget(candidate, key);
      const targetInfo = await lstat(target).catch(() => null);
      if (targetInfo) await rm(target, { recursive: true, force: true });
      await copyEntry(path, target);
    }
    for (const key of Object.keys(baseline.entries).sort((a, b) => b.length - a.length)) {
      if (Object.hasOwn(currentHost, key) && !stagedKeys.has(key) && !stagedEntries.some(([name]) => name.startsWith(`${key}/`))) {
        await rm(join(candidate, key), { recursive: true, force: true });
      }
    }
    await writeJournal(source, { version: JOURNAL_VERSION, sourceName, candidateName, backupName, phase, candidateInSource: true, backupPresent: true }, parentHandle);
    if (process.env.YOLO_PUBLICATION_FAULT === 'after-journal') throw new Error('publication interrupted after journal');
    await rename(anchored(source), anchored(join(parent, backupName))); await parentHandle.sync();
    phase = 'source-renamed'; await writeJournal(source, { version: JOURNAL_VERSION, sourceName, candidateName, backupName, phase, candidateInSource: false, backupPresent: true }, parentHandle);
    if (process.env.YOLO_PUBLICATION_FAULT === 'after-source-rename') throw new Error('publication interrupted after source rename');
    await rename(anchored(join(parent, backupName, candidateName)), anchored(source)); await parentHandle.sync();
    phase = 'candidate-renamed'; await writeJournal(source, { version: JOURNAL_VERSION, sourceName, candidateName, backupName, phase, candidateInSource: true, backupPresent: true }, parentHandle);
    if (process.env.YOLO_PUBLICATION_FAULT === 'after-candidate-rename') throw new Error('publication interrupted after candidate rename');
    await rm(anchored(join(parent, backupName)), { recursive: true, force: true }); await parentHandle.sync();
    phase = 'backup-removed'; await writeJournal(source, { version: JOURNAL_VERSION, sourceName, candidateName, backupName, phase, candidateInSource: false, backupPresent: false }, parentHandle);
    if (process.env.YOLO_PUBLICATION_FAULT === 'after-backup-remove') throw new Error('publication interrupted after backup removal');
    await removeJournal(source, parentHandle);
  } catch (error) {
    // A journal is intentionally retained after any destructive phase.  The
    // provider is not involved in recovery; the next explicit recovery can
    // safely reconcile the anchored names.
    if (phase === 'prepared') await rm(candidate, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally { await parentHandle.close(); }
}

export { MANIFEST };
