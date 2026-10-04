import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkill, listSkills, uninstallSkill } from '../src/skills.mjs';

const temp = () => mkdtemp(join(tmpdir(), 'yolo-skills-management-'));

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
