import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { installPaths } from './installer.mjs';
const exec = promisify(execFile);
const IMAGE = /^sha256:[0-9a-f]{64}$/i;

export async function uninstallApplication({ home, dataHome, binHome, docker = 'docker', execFile: run = exec, invocation } = {}) {
  const { appRoot, launcher } = installPaths({ home, dataHome, binHome });
  const app = join(appRoot, 'app');
  const expected = join(app, 'src', 'cli.mjs');
  if (invocation && resolve(await realpath(invocation)) !== resolve(expected)) throw new Error('refusing uninstall: not invoked through the installed launcher');
  const launcherInfo = await lstat(launcher).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!launcherInfo || !launcherInfo.isSymbolicLink() || resolve(dirname(launcher), await readlink(launcher)) !== resolve(expected)) throw new Error('refusing uninstall: not invoked through the installed launcher');
  const imagePath = join(appRoot, 'image.json');
  let imageId = null;
  try { const value = JSON.parse(await readFile(imagePath, 'utf8')); imageId = value?.imageId; } catch (error) { if (error.code !== 'ENOENT') throw new Error('refusing uninstall: malformed image metadata'); }
  if (imageId !== null) {
    if (!IMAGE.test(imageId)) throw new Error('refusing uninstall: invalid image metadata');
    await run(docker, ['image', 'rm', imageId], { maxBuffer: 16 * 1024 });
  }
  const appInfo = await lstat(app).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (appInfo && (!appInfo.isDirectory() || appInfo.isSymbolicLink())) throw new Error('refusing uninstall: unsafe app path');
  await rm(launcher, { force: false });
  if (appInfo) await rm(app, { recursive: true, force: false });
  await rm(imagePath, { force: false });
  return { launcher, appRoot, imageId };
}
