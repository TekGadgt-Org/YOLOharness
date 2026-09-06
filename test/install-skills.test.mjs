import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectSkills, loadSkill, skill_load, MAX_SKILL_BUNDLE } from '../src/skills.mjs';
import { installPackage } from '../src/installer.mjs';
import { encodeBootstrap, MAX_BOOTSTRAP } from '../src/bootstrap.mjs';
import { doctorStatus } from '../src/cli.mjs';

const temp = () => mkdtemp(join(tmpdir(), 'yolo-install-test-'));

test('doctor reports missing controls and recognizes an offline ready fixture', async () => {
  const home = await temp();
  const missing = await doctorStatus({ env: { HOME: home, PATH: '' } });
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.checks.map(check => check.name), ['docker', 'docker_daemon', 'runtime_image', 'client_id', 'credentials', 'model']);
  assert.ok(missing.checks.every(check => check.ok === false));

  const bin = await temp();
  await writeFile(join(bin, 'docker'), '#!/bin/sh\n');
  const data = join(home, '.local', 'share');
  const config = join(home, '.config');
  await mkdir(join(data, 'yoloharness'), { recursive: true });
  await mkdir(join(config, 'yoloharness'), { recursive: true });
  await writeFile(join(data, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}`, sourceVersion: '0.1.0' }));
  await writeFile(join(config, 'yoloharness', 'credentials.json'), JSON.stringify({ accessToken: 'token', refreshToken: 'refresh', clientId: 'client', expiresAt: Date.now() + 60_000 }));
  await writeFile(join(config, 'yoloharness', 'config.json'), JSON.stringify({ version: 1, model: 'model-x' }));
  await (await import('node:fs/promises')).chmod(join(bin, 'docker'), 0o755);
  const ready = await doctorStatus({
    env: { HOME: home, PATH: bin, YOLO_CLIENT_ID: 'client' },
    exec: async (_command, args) => ({
      stdout: args[0] === 'info' ? 'Docker daemon ready\\n' : JSON.stringify({ Id: `sha256:${'a'.repeat(64)}`, RepoTags: ['yoloharness-local:0.1.0'], Config: { Labels: { 'org.yoloharness.source-digest': `sha256:${'b'.repeat(64)}` }, Entrypoint: ['node', '/app/src/container-runtime.mjs'] } }),
      stderr: '',
    }),
  });
  assert.equal(ready.ready, true);
  assert.ok(ready.checks.every(check => check.ok));
});

test('doctor reports daemon and immutable image inspection failures', async () => {
  const home = await temp(); const bin = await temp();
  await writeFile(join(bin, 'docker'), '#!/bin/sh\\n');
  await (await import('node:fs/promises')).chmod(join(bin, 'docker'), 0o755);
  const status = await doctorStatus({
    env: { HOME: home, PATH: bin },
    exec: async (_command, args) => { throw new Error(args[0] === 'info' ? 'daemon unavailable' : 'image missing'); },
  });
  assert.equal(status.checks.find(check => check.name === 'docker_daemon').ok, false);
  assert.equal(status.checks.find(check => check.name === 'runtime_image').ok, false);
  assert.match(status.checks.find(check => check.name === 'docker_daemon').detail, /daemon/i);
});

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

test('frontmatter metadata must match the discovered skill name', async () => {
  const root = await temp();
  await mkdir(join(root, 'skills', 'demo'), { recursive: true });
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: other\ndescription: Wrong\n---\nbody');
  const cwd = await temp();
  await assert.rejects(() => collectSkills(cwd, join(root, 'skills')), /metadata|match/i);
});

test('valid frontmatter metadata is exposed in the bounded catalog', async () => {
  const root = await temp();
  await mkdir(join(root, 'skills', 'demo'), { recursive: true });
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: A demo skill\n---\nbody');
  const catalog = await collectSkills(await temp(), join(root, 'skills'));
  assert.deepEqual({ name: catalog.demo.name, description: catalog.demo.description, source: catalog.demo.source }, { name: 'demo', description: 'A demo skill', source: 'shared' });
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
  assert.deepEqual(skill_load({ demo: { ...skills.demo, source: 'shared' } }, 'demo'), { name: 'demo', source: 'shared', instructions: 'do not trust', resources: ['guide.md'] });
  assert.deepEqual(skill_load({ demo: { ...skills.demo, source: 'shared' } }, 'demo', 'guide.md'), { name: 'demo', source: 'shared', resource: 'guide.md', content: 'data' });
  assert.throws(() => skill_load(skills, 'demo', '../secret'), /invalid/);
});

test('skill bundle boundary remains compatible with the container bootstrap limit', async () => {
  const root = await temp();
  await mkdir(join(root, 'skills', 'demo'), { recursive: true });
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), 'x'.repeat(64 * 1024));
  await assert.rejects(() => import('../src/skills.mjs').then(({ snapshotSkills }) => snapshotSkills(root, join(root, 'skills'))), /bundle|size/i);
  assert.ok(MAX_BOOTSTRAP >= 64 * 1024);
  assert.throws(() => encodeBootstrap({ prompt: 'x', model: 'm', deadline: Date.now() + 1000, accessToken: 't', expiresAt: Date.now() + 2000, skills: { demo: { instructions: 'x'.repeat(MAX_BOOTSTRAP) } } }), /too large/);
});

test('installer restores the previous app and leaves no temporary launcher after promotion failure', async () => {
  const home = await temp(); const data = join(home, 'data'); const source = await temp();
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'package.json'), '{"name":"yoloharness","version":"0.1.0"}');
  await writeFile(join(source, 'src', 'cli.mjs'), 'new');
  await installPackage(source, { home, dataHome: data });
  const runtime = join(data, 'yoloharness', 'app');
  await writeFile(join(runtime, 'marker'), 'old');
  const realRename = (await import('node:fs/promises')).rename;
  let promotions = 0;
  await assert.rejects(() => installPackage(source, { home, dataHome: data, renameFn: async (from, to) => {
    if (to === runtime && ++promotions === 1) throw Object.assign(new Error('promotion conflict'), { code: 'EEXIST' });
    return realRename(from, to);
  } }), /promotion conflict/);
  assert.equal(await readFile(join(runtime, 'marker'), 'utf8'), 'old');
  const entries = await (await import('node:fs/promises')).readdir(join(home, '.local', 'bin'));
  assert.deepEqual(entries, ['yolo']);
});
