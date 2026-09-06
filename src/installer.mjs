import { access, cp, lstat, mkdir, rename, rm, readlink, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const APP = 'yoloharness';
function absolute(value, fallback) { return typeof value === 'string' && isAbsolute(value) ? value : fallback; }
async function safeDirectory(path, create = false) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe symlink or non-directory destination: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}
async function atomicCopy(source, target) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
  try { await rename(temporary, target); } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}
export async function installPackage(packageRoot, { home = homedir(), dataHome = process.env.XDG_DATA_HOME, binHome } = {}) {
  if (!isAbsolute(packageRoot) || !isAbsolute(home)) throw new TypeError('package and home paths must be absolute');
  const data = absolute(dataHome, join(home, '.local', 'share'));
  const bin = absolute(binHome, join(home, '.local', 'bin'));
  const appRoot = join(data, APP);
  await safeDirectory(data, true); await safeDirectory(bin, true);
  await safeDirectory(appRoot, true);
  const sourceInfo = await lstat(packageRoot); if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new TypeError('package root must be a real directory');
  const runtime = join(appRoot, 'app');
  const staging = join(appRoot, `.app-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await cp(packageRoot, staging, { recursive: true, filter: source => !source.includes('/.git') && !source.includes('/node_modules') });
    if (await exists(runtime)) { const old = `${runtime}.old-${randomUUID()}`; await rename(runtime, old); await rename(staging, runtime); await rm(old, { recursive: true, force: true }); }
    else await rename(staging, runtime);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  const launcher = join(bin, 'yolo');
  try { const info = await lstat(launcher); if (info.isSymbolicLink()) { if (await readlink(launcher) !== join(runtime, 'src', 'cli.mjs')) throw new Error(`unsafe symlink destination: ${launcher}`); } else if (!info.isFile()) throw new Error(`unsafe non-file destination: ${launcher}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tmpLauncher = `${launcher}.${randomUUID()}.tmp`;
  await symlink(join(runtime, 'src', 'cli.mjs'), tmpLauncher);
  await rename(tmpLauncher, launcher); return { appRoot, launcher };
}
async function exists(path) { try { await access(path, constants.F_OK); return true; } catch { return false; } }
export function installPaths({ home = homedir(), dataHome = process.env.XDG_DATA_HOME, binHome } = {}) {
  const data = absolute(dataHome, join(home, '.local', 'share')); const bin = absolute(binHome, join(home, '.local', 'bin'));
  return { appRoot: join(data, APP), launcher: join(bin, 'yolo') };
}
if (process.argv[1]?.endsWith('/install.mjs')) {
  const result = await installPackage(resolve(dirname(process.argv[1])));
  process.stdout.write(`installed ${result.launcher}\nAdd ${dirname(result.launcher)} to PATH, then run yolo setup\n`);
}
