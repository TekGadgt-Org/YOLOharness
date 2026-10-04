import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkill, listSkills, uninstallSkill } from '../src/skills.mjs';
import { installSkillSource } from '../src/skill-installer.mjs';

const temp = () => mkdtemp(join(tmpdir(), 'yolo-skills-management-'));
const execFile = promisify(execFileCallback);

test('installs a local skill atomically and uninstalls only the shared skill', async () => {
  const root = await temp();
  const source = await temp();
  await writeFile(join(source, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\nUse demo');
  await mkdir(join(source, 'resources'));
  await writeFile(join(source, 'resources', 'guide.md'), 'guide');
  const installed = await installSkill(source, root);
  assert.equal(installed.name, 'demo');
  assert.deepEqual(await listSkills(root), [{ name: 'demo', source: 'shared', description: 'Demo' }]);
  const cwd = await temp();
  await mkdir(join(cwd, '.agents', 'skills', 'demo'), { recursive: true });
  await writeFile(join(cwd, '.agents', 'skills', 'demo', 'SKILL.md'), 'local');
  await uninstallSkill('demo', root);
  await assert.rejects(() => lstat(join(root, 'demo')));
  assert.equal(await readFile(join(cwd, '.agents', 'skills', 'demo', 'SKILL.md'), 'utf8'), 'local');
});

test('rejects unsafe local skill sources before creating destination', async () => {
  const root = await temp();
  const source = await temp();
  await writeFile(join(source, 'SKILL.md'), '---\nname: bad\ndescription: Bad\n---\nbad');
  await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'nested', 'x'), 'x');
  await assert.rejects(() => installSkill(source, root, { name: '../escape' }), /name|invalid/i);
  await assert.rejects(() => lstat(join(root, 'bad')));
});

test('rejects non-portable archive member names before persistent installation', async () => {
  const root = await temp();
  for (const [label, member] of [['backslash', 'package/resources\\\\escape'], ['control', 'package/resources/line\nfeed'], ['punctuation', 'package/resources/space name']]) {
    const source = await temp();
    await mkdir(join(source, 'package', 'resources'), { recursive: true });
    await writeFile(join(source, 'package', 'package.json'), '{}');
    await writeFile(join(source, 'package', 'SKILL.md'), '---\nname: package\ndescription: Package\n---\nbody');
    await writeFile(join(source, member.replace(/^package\//, 'package/')), 'bad');
    const archive = join(source, `${label}.tgz`);
    await execFile('tar', ['-czf', archive, '-C', source, 'package']);
    await assert.rejects(() => installSkillSource(archive, root), /unsafe|invalid|unsupported/i);
    await assert.rejects(() => lstat(join(root, 'package')));
  }
});
