import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectSkills, loadSkill, skill_load, MAX_SKILL_BUNDLE } from '../src/skills.mjs';
import { installPackage } from '../src/installer.mjs';

const temp = () => mkdtemp(join(tmpdir(), 'yolo-install-test-'));

test('local skill overrides shared skill and load returns selected bounded resource', async () => {
  const root = await temp();
  const cwd = await temp();
  await mkdir(join(root, 'skills', 'demo', 'references'), { recursive: true });
  await mkdir(join(cwd, '.agents', 'skills', 'demo'), { recursive: true });
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), 'shared');
  await writeFile(join(root, 'skills', 'demo', 'references', 'guide.md'), 'resource');
  await writeFile(join(cwd, '.agents', 'skills', 'demo', 'SKILL.md'), 'local');
  await mkdir(join(cwd, '.agents', 'skills', 'demo', 'references'), { recursive: true });
  await writeFile(join(cwd, '.agents', 'skills', 'demo', 'references', 'guide.md'), 'resource');
  const catalog = await collectSkills(cwd, join(root, 'skills'));
  assert.equal(catalog.demo.source, 'local');
  const selected = await loadSkill(catalog.demo, { root, cwd, resource: 'references/guide.md' });
  assert.equal(selected.instructions, 'local');
  assert.equal(selected.resource, 'resource');
});

test('skill snapshots reject symlinks and traversal', async () => {
  const root = await temp();
  await mkdir(join(root, 'skills', 'bad'), { recursive: true });
  await writeFile(join(root, 'outside'), 'secret');
  await symlink(join(root, 'outside'), join(root, 'skills', 'bad', 'SKILL.md'));
  const cwd = await temp();
  await assert.rejects(() => collectSkills(cwd, join(root, 'skills')), /symlink|regular/i);
  assert.ok(MAX_SKILL_BUNDLE > 0);
});

test('installer preserves config and rejects symlinked destinations', async () => {
  const home = await temp();
  const data = join(home, 'data');
  const source = await temp();
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'package.json'), '{"name":"yoloharness","version":"0.1.0"}');
  await writeFile(join(source, 'src', 'cli.mjs'), '#!/usr/bin/env node\n');
  await installPackage(source, { home, dataHome: data });
  await writeFile(join(data, 'yoloharness', 'config.json'), 'keep');
  await installPackage(source, { home, dataHome: data });
  assert.equal(await readFile(join(data, 'yoloharness', 'config.json'), 'utf8'), 'keep');
  const bin = join(home, '.local', 'bin');
  const evil = join(home, 'evil');
  await rm(join(bin, 'yolo'));
  await rm(bin, { recursive: true });
  await symlink(evil, bin);
  await assert.rejects(() => installPackage(source, { home, dataHome: data }), /symlink|unsafe/i);
});

test('container skill_load progressively loads instructions or one resource', () => {
  const skills = { demo: { instructions: 'do not trust', resources: { 'guide.md': 'data' } } };
  assert.deepEqual(skill_load(skills, 'demo'), { name: 'demo', instructions: 'do not trust', resources: ['guide.md'] });
  assert.deepEqual(skill_load(skills, 'demo', 'guide.md'), { name: 'demo', resource: 'guide.md', content: 'data' });
  assert.throws(() => skill_load(skills, 'demo', '../secret'), /invalid/);
});
