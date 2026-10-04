import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkill } from './skills.mjs';
const exec = promisify(execFile);
const NPM_NAME = /^(?:@[^/\s]+\/)?[^/@\s]+(?:@(?:[A-Za-z0-9._-]+|\^[^\s]+|~[^\s]+|\d[^\s]*))?$/;

export async function installSkillSource(source, sharedRoot) {
  if (typeof source !== 'string' || !source) throw new TypeError('skill source is required');
  if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) return installSkill(resolve(source), sharedRoot);
  if (source.endsWith('.tgz')) return installTgz(resolve(source), sharedRoot);
  if (!NPM_NAME.test(source) || /^(?:https?:|git(?:\+|:)|file:|workspace:)/i.test(source)) throw new TypeError('unsupported npm skill source');
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-npm-'));
  try {
    const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', root, source], { maxBuffer: 64 * 1024 });
    const files = (await readdir(root)).filter(value => value.endsWith('.tgz'));
    if (files.length !== 1 || !stdout.includes(files[0])) throw new Error('npm did not produce exactly one package archive');
    return await installTgz(join(root, files[0]), sharedRoot);
  } finally { await rm(root, { recursive: true, force: true }).catch(() => {}); }
}

async function installTgz(archive, sharedRoot) {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-tgz-'));
  try {
    await exec('tar', ['-tzf', archive], { maxBuffer: 64 * 1024 });
    await exec('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', root], { maxBuffer: 64 * 1024 });
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) throw new Error('package archive must contain one package root');
    const packageRoot = join(root, entries[0].name);
    const packageJson = join(packageRoot, 'package.json');
    const stat = await lstat(packageJson).catch(() => null);
    if (!stat?.isFile()) throw new Error('package archive must contain package.json');
    JSON.parse(await (await import('node:fs/promises')).readFile(packageJson, 'utf8'));
    const skillText = await (await import('node:fs/promises')).readFile(join(packageRoot, 'SKILL.md'), 'utf8');
    const skillName = /^name:[ \t]*(.+)$/m.exec(skillText)?.[1]?.trim();
    return await installSkill(packageRoot, sharedRoot, { name: skillName, packageSource: true });
  } finally { await rm(root, { recursive: true, force: true }).catch(() => {}); }
}
