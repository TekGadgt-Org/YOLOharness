import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkill, listSkills, uninstallSkill } from '../src/skills.mjs';
import { installSkillSource } from '../src/skill-installer.mjs';

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

test('installs a standalone local SKILL.md file', async () => {
  const root = await temp();
  const source = await temp();
  const file = join(source, 'review.md');
  await writeFile(file, '---\nname: review\ndescription: Review\n---\nUse review');
  const installed = await installSkillSource(file, root);
  assert.equal(installed.name, 'review');
  assert.equal(await readFile(join(root, 'review', 'SKILL.md'), 'utf8'), '---\nname: review\ndescription: Review\n---\nUse review');
});

test('accepts bare relative directory, Markdown file, and scoped-looking local sources', async () => {
  const root = await temp();
  const fileRoot = await temp();
  const scopedRoot = await temp();
  const cwd = await temp();
  const previousCwd = process.cwd();
  await mkdir(join(cwd, 'bare-dir'));
  await writeFile(join(cwd, 'bare-dir', 'SKILL.md'), '---\nname: bare\ndescription: Bare directory\n---\nUse bare directory');
  await writeFile(join(cwd, 'bare.md'), '---\nname: bare\ndescription: Bare file\n---\nUse bare file');
  await mkdir(join(cwd, '@scope', 'skill'), { recursive: true });
  await writeFile(join(cwd, '@scope', 'skill', 'SKILL.md'), '---\nname: skill\ndescription: Scoped local\n---\nUse scoped');
  process.chdir(cwd);
  try {
    assert.equal((await installSkillSource('bare-dir', root)).name, 'bare');
    assert.equal((await installSkillSource('bare.md', fileRoot)).name, 'bare');
    assert.equal((await installSkillSource('@scope/skill', scopedRoot)).name, 'skill');
  } finally {
    process.chdir(previousCwd);
  }
});

test('rejects package specs, URLs, archives, missing paths, and unsupported files before persistent installation', async () => {
  const root = await temp();
  const source = await temp();
  const unsupported = join(source, 'notes.txt');
  await writeFile(unsupported, 'not a skill');
  for (const value of ['lodash', '@scope/skill', 'https://example.test/skill.tgz', './skill.tgz', './missing-skill', unsupported]) {
    await assert.rejects(() => installSkillSource(value, root), /local|unsupported|URL|source|ENOENT|Markdown|SKILL/i);
    assert.deepEqual(await readdir(root), []);
  }
});
