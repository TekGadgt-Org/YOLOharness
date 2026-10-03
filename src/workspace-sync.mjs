import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const HARNESS_PREFIX = '.yolo';
function normalizeExclusions(names = []) { if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name || name.includes('/') || name === '.' || name === '..')) throw new TypeError('invalid dependency directory names'); return new Set(names); }
function ignored(name, key, exclusions) { return key === HARNESS_PREFIX || key.startsWith(`${HARNESS_PREFIX}/`) || exclusions.has(name); }
function ensureRelative(key) { if (!key || key.startsWith('/') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`unsafe publication path: ${key}`); }
async function ownerSafe(path) { const info = await lstat(path); if (info.uid !== undefined && info.uid !== process.getuid?.() && info.uid !== 0) throw new Error(`unsafe publication ownership: ${path}`); if (info.isFile() && info.nlink > 1) throw new Error(`unsupported hardlink publication entry: ${path}`); if (info.isSymbolicLink() || info.isBlockDevice() || info.isCharacterDevice() || info.isFIFO() || info.isSocket()) throw new Error(`unsafe publication entry type: ${path}`); return info; }
async function walk(root, exclusions, current = root, result = []) { for (const name of (await readdir(current)).sort()) { const key = relative(root, join(current, name)).split('\\').join('/'); if (ignored(name, key, exclusions)) continue; ensureRelative(key); const path = join(current, name); const info = await ownerSafe(path); result.push({ key, path, info }); if (info.isDirectory()) await walk(root, exclusions, path, result); } return result; }

export async function validateEmptyWorkspace(workspace = process.cwd()) { const absolute = resolve(workspace); const info = await lstat(absolute).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new TypeError('workspace must be a real directory'); if ((await readdir(absolute)).length !== 0) throw new Error('workspace must be initially empty; choose a fresh disposable directory'); return absolute; }

export async function seedWorkspace(source, staged, dependencyNames = []) { const exclusions = normalizeExclusions(dependencyNames); await rm(staged, { recursive: true, force: true }); await mkdir(staged, { recursive: true, mode: 0o700 }); const entries = await walk(source, exclusions); for (const entry of entries) { const target = join(staged, entry.key); if (entry.info.isDirectory()) await mkdir(target, { recursive: true, mode: entry.info.mode & 0o777 }); else { await mkdir(dirname(target), { recursive: true, mode: 0o700 }); const fh = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, entry.info.mode & 0o777); try { await fh.writeFile(await readFile(entry.path)); } finally { await fh.close(); } } } }

async function anchoredDir(base, parts, create = false) {
  const baseFlags = base.startsWith('/proc/self/fd/') ? fsConstants.O_RDONLY | fsConstants.O_DIRECTORY : fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  let fd = await open(base, baseFlags);
  try {
    for (const part of parts) {
      if (part === '.' || part === '..' || part.includes('/')) throw new Error(`unsafe publication path: ${parts.join('/')}`);
      const child = `/proc/self/fd/${fd.fd}/${part}`;
      if (create) await mkdir(child, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const next = await open(child, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      await fd.close(); fd = next;
    }
    return fd;
  } catch (error) { await fd.close().catch(() => {}); throw error; }
}
async function anchoredCreate(base, key, flags, mode) {
  const parts = key.split('/'); const leaf = parts.pop();
  const dir = await anchoredDir(base, parts, true);
  try { return await open(`/proc/self/fd/${dir.fd}/${leaf}`, flags | fsConstants.O_NOFOLLOW, mode); }
  finally { await dir.close(); }
}
export async function publishWorkspace(staged, destination, dependencyNames = []) {
  const exclusions = normalizeExclusions(dependencyNames); const dest = await anchoredDir(destination, []);
  try {
    const names = await readdir(`/proc/self/fd/${dest.fd}`); if (names.some(name => name !== HARNESS_PREFIX)) throw new Error('publication destination is not empty');
    const entries = await walk(staged, exclusions); let created = 0;
    try {
      for (const entry of entries) {
        const parts = entry.key.split('/'); const leaf = parts.pop(); const parent = await anchoredDir(`/proc/self/fd/${dest.fd}`, parts, true);
        try {
          const target = `/proc/self/fd/${parent.fd}/${leaf}`;
          if (entry.info.isDirectory()) { await mkdir(target, { mode: entry.info.mode & 0o777 }); created += 1; }
          else { const fh = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, entry.info.mode & 0o777); try { await fh.writeFile(await readFile(entry.path)); await fh.sync(); } finally { await fh.close(); } created += 1; }
        } finally { await parent.close(); }
      }
      return { version: 1, published: true, created, created_entries: created };
    } catch (error) {
      const receipt = Object.assign(new Error(`publication_incomplete: ${error.message}; inspect or delete the generated directory before retrying`), { code: 'publication_incomplete', created_entries: created });
      throw receipt;
    }
  } finally { await dest.close(); }
}
