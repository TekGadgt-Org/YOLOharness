import { resolve } from 'node:path';
import { installSkill } from './skills.mjs';

function isLocalPath(source) {
  return source === '.' || source === '..' || source.startsWith('/') || source.startsWith('./') || source.startsWith('../') || source.includes('/');
}

export async function installSkillSource(source, sharedRoot) {
  if (typeof source !== 'string' || !source) throw new TypeError('skill source is required');
  if (source.endsWith('.tgz')) throw new TypeError('local .tgz skill archives are not supported; unpack the skill directory first');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) throw new TypeError('skill source must be a local file or directory');
  if (!isLocalPath(source)) throw new TypeError('npm skill package specs are not supported; use a local skill file or directory');
  return installSkill(resolve(source), sharedRoot);
}
