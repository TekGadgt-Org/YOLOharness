import { resolve } from 'node:path';
import { installSkill } from './skills.mjs';

export async function installSkillSource(source, sharedRoot) {
  if (typeof source !== 'string' || !source) throw new TypeError('skill source is required');
  if (source.endsWith('.tgz')) throw new TypeError('local .tgz skill archives are not supported; unpack the skill directory first');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) throw new TypeError('skill source must be a local file or directory');
  return installSkill(resolve(source), sharedRoot);
}
