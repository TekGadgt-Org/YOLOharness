import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigStore, DEFAULT_EPHEMERAL_PATHS, ConfigError, validateEphemeralPath, validateEphemeralPaths } from '../src/config.mjs';
import { volumeSubpath } from '../src/scratch-path.mjs';

test('v2 storage policy is usable before model setup and preserves paths', async () => {
  const dir = await mkdtemp('/tmp/yoloharness-config-v2-');
  const path = join(dir, 'config.json');
  const store = new ConfigStore(path);
  const saved = await store.saveDocument({ model: null, ephemeralPaths: ['a/b', 'a__b'] });
  assert.equal(saved.model, null);
  assert.deepEqual((await store.load()).ephemeralPaths, ['a/b', 'a__b']);
  assert.notEqual(volumeSubpath('a/b'), volumeSubpath('a__b'));
  await store.saveDocument({ model: 'exact/model', ephemeralPaths: saved.ephemeralPaths });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 2, model: 'exact/model', ephemeralPaths: ['a/b', 'a__b'] });
});

test('v1 model configuration migrates losslessly to default storage paths', async () => {
  const dir = await mkdtemp('/tmp/yoloharness-config-v1-');
  const path = join(dir, 'config.json');
  const store = new ConfigStore(path);
  await store.save('exact/model');
  const legacy = await store.load();
  assert.equal(legacy.version, 1);
  const migrated = await store.saveDocument({ model: legacy.model, ephemeralPaths: legacy.ephemeralPaths ?? DEFAULT_EPHEMERAL_PATHS });
  assert.deepEqual(migrated.ephemeralPaths, [...DEFAULT_EPHEMERAL_PATHS]);
});

test('ephemeral path controls reject unsafe and overlapping schemas while preserving explicit options', async () => {
  for (const value of ['', '.', './x', 'a/./b', 'a,b', 'a/b,c', '/absolute', '../escape', 'a/../b', '.git', '.yolo', 'a/.git/b', 'a\u0000b', 'a\u000ab']) assert.throws(() => validateEphemeralPath(value), ConfigError);
  for (const values of [['a', 'a'], ['a', 'a/b'], ['a/b', 'a'], ['a/b', 'a/./b'], ['a\\b', 'a/b']]) assert.throws(() => validateEphemeralPaths(values), ConfigError);
  assert.equal(validateEphemeralPath('a\\b'), 'a/b');
  assert.deepEqual(validateEphemeralPaths(['a/b', 'a__b', 'vendor', '.godot', 'target', 'bin', 'obj', 'nested/path']), ['a/b', 'a__b', 'vendor', '.godot', 'target', 'bin', 'obj', 'nested/path']);
  const dir = await mkdtemp('/tmp/yoloharness-config-controls-'); const old = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = dir;
  const { main } = await import('../src/cli.mjs'); const output = []; const io = { stdout: { write(value) { output.push(value); } }, stderr: { write() {} } };
  try {
    assert.equal(await main(['config', 'ephemeral-path', 'list'], io), 0);
    assert.deepEqual(output.slice(-5), DEFAULT_EPHEMERAL_PATHS.map(value => `${value}\n`));
    assert.equal(await main(['config', 'ephemeral-path', 'add', 'bin'], io), 0);
    assert.equal(await main(['config', 'ephemeral-path', 'remove', 'vendor'], io), 0);
    assert.deepEqual((await new ConfigStore(join(dir, 'yoloharness', 'config.json')).load()).ephemeralPaths, ['node_modules', '.venv', '.godot', 'target', 'bin']);
    assert.equal(await main(['config', 'ephemeral-path', 'reset'], io), 0);
    assert.deepEqual((await new ConfigStore(join(dir, 'yoloharness', 'config.json')).load()).ephemeralPaths, [...DEFAULT_EPHEMERAL_PATHS]);
  } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
});

test('v2 direct edits reject dot components and Docker mount delimiters', async () => {
  for (const ephemeralPaths of [['nested/./path'], ['nested,path']]) {
    const dir = await mkdtemp('/tmp/yoloharness-config-malformed-');
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ version: 2, model: null, ephemeralPaths }));
    await assert.rejects(new ConfigStore(path).load(), ConfigError);
  }
});

test('ephemeral-path add rejects dot components and commas without changing config bytes', async () => {
  const dir = await mkdtemp('/tmp/yoloharness-config-cli-reject-');
  const old = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = dir;
  const path = join(dir, 'yoloharness', 'config.json');
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  try {
    await new ConfigStore(path).saveDocument({ model: null, ephemeralPaths: ['nested/path'] });
    const before = await readFile(path);
    const { main } = await import('../src/cli.mjs');
    for (const value of ['nested/./path', 'nested,path']) {
      assert.equal(await main(['config', 'ephemeral-path', 'add', value], io), 1);
      assert.deepEqual(await readFile(path), before);
    }
  } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
});
