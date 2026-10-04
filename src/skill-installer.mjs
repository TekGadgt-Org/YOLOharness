import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkill } from './skills.mjs';
const exec = promisify(execFile);
const NPM_NAME = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:@(?:[0-9][A-Za-z0-9._*-]*|[~^][0-9][A-Za-z0-9._*-]*))?$/;

export async function installSkillSource(source, sharedRoot) {
  if (typeof source !== 'string' || !source) throw new TypeError('skill source is required');
  if (source.endsWith('.tgz')) return installTgz(resolve(source), sharedRoot);
  if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) return installSkill(resolve(source), sharedRoot);
  if (!NPM_NAME.test(source)) throw new TypeError('unsupported npm skill source');
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-npm-'));
  try {
    const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', root, '--', source], { maxBuffer: 64 * 1024 });
    const files = (await readdir(root)).filter(value => value.endsWith('.tgz'));
    if (files.length !== 1 || !stdout.includes(files[0])) throw new Error('npm did not produce exactly one package archive');
    return await installTgz(join(root, files[0]), sharedRoot);
  } finally { await rm(root, { recursive: true, force: true }).catch(() => {}); }
}

async function installTgz(archive, sharedRoot) {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-tgz-'));
  try {
    const archiveInfo = await lstat(archive);
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size > 64 * 1024) throw new RangeError('package archive exceeds size limit');
    const { stdout: manifest } = await exec('tar', ['-tvzf', archive], { maxBuffer: 64 * 1024 });
    const names = new Set();
    let total = 0;
    for (const line of manifest.split(/\r?\n/).filter(Boolean)) {
      const type = line[0];
      if (type !== '-' && type !== 'd') throw new TypeError('package archive contains an unsafe entry');
      const match = /^(.{10})\s+\S+\s+(\d+)\s+[^ ]+\s+\d+:\d+\s+(.+)$/.exec(line);
      if (!match) throw new TypeError('package archive has an invalid manifest');
      const name = match[3].replace(/\/$/, '');
      if (!name || name.startsWith('/') || name.split('/').some(part => !part || part === '..' || part === '.')) throw new TypeError('package archive contains an unsafe path');
      const normalized = name.split('/').join('/');
      if (names.has(normalized)) throw new TypeError('package archive contains duplicate paths');
      names.add(normalized);
      if (names.size > 256) throw new RangeError('package archive contains too many entries');
      if (type === '-') { total += Number(match[2]); if (!Number.isSafeInteger(total) || total > 64 * 1024) throw new RangeError('package archive exceeds bundle size limit'); }
    }
    await exec('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', root], { maxBuffer: 64 * 1024 });
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) throw new Error('package archive must contain one package root');
    const packageRoot = join(root, entries[0].name);
    const packageJson = join(packageRoot, 'package.json');
    const stat = await lstat(packageJson).catch(() => null);
    if (!stat?.isFile()) throw new Error('package archive must contain package.json');
    JSON.parse(await readFile(packageJson, 'utf8'));
    const skillText = await readFile(join(packageRoot, 'SKILL.md'), 'utf8');
    const skillName = /^name:[ \t]*(.+)$/m.exec(skillText)?.[1]?.trim();
    return await installSkill(packageRoot, sharedRoot, { name: skillName, packageSource: true });
  } finally { await rm(root, { recursive: true, force: true }).catch(() => {}); }
}
