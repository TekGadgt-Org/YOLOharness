import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigStore, DEFAULT_EPHEMERAL_PATHS } from '../src/config.mjs';
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
