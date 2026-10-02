import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedWorkspace, publishWorkspace } from '../src/workspace-sync.mjs';

async function exists(path) { return access(path).then(() => true).catch(() => false); }

test('workspace staging filters dependency directories at arbitrary depth while preserving durable files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-sync-'));
  const source = join(root, 'source'); const staged = join(root, 'staged');
  try {
    await mkdir(join(source, 'apps', 'web', 'node_modules', 'left-pad'), { recursive: true });
    await mkdir(join(source, 'services', 'api', '.venv', 'bin'), { recursive: true });
    await mkdir(join(source, 'vendor', 'custom-cache', 'pkg'), { recursive: true });
    await writeFile(join(source, 'apps', 'web', 'package.json'), '{}');
    await writeFile(join(source, 'services', 'api', 'requirements.txt'), 'flask');
    await writeFile(join(source, 'vendor', 'custom-cache', 'pkg', 'ignored'), 'dependency');
    await writeFile(join(source, 'README.md'), 'source');
    await seedWorkspace(source, staged, ['node_modules', '.venv', 'custom-cache']);
    assert.equal(await exists(join(staged, 'apps', 'web', 'node_modules')), false);
    assert.equal(await exists(join(staged, 'services', 'api', '.venv')), false);
    assert.equal(await exists(join(staged, 'vendor', 'custom-cache')), false);
    assert.equal(await readFile(join(staged, 'apps', 'web', 'package.json'), 'utf8'), '{}');
    assert.equal(await readFile(join(staged, 'README.md'), 'utf8'), 'source');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace publication copies outputs and applies supported deletions without touching excluded host content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-sync-'));
  const source = join(root, 'source'); const staged = join(root, 'staged');
  try {
    await mkdir(join(source, 'app', 'node_modules'), { recursive: true });
    await writeFile(join(source, 'app', 'node_modules', 'keep'), 'host dependency');
    await mkdir(join(staged, 'app'), { recursive: true });
    await writeFile(join(staged, 'app', 'package.json'), '{}');
    await writeFile(join(staged, 'app', 'dist.js'), 'built');
    await publishWorkspace(staged, source, ['node_modules']);
    assert.equal(await readFile(join(source, 'app', 'node_modules', 'keep'), 'utf8'), 'host dependency');
    assert.equal(await readFile(join(source, 'app', 'dist.js'), 'utf8'), 'built');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace publication fails closed when an existing durable file conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-sync-'));
  const source = join(root, 'source'); const staged = join(root, 'staged');
  try {
    await mkdir(source); await mkdir(staged);
    await writeFile(join(source, 'manifest.json'), 'host');
    await writeFile(join(staged, 'manifest.json'), 'generated');
    await assert.rejects(publishWorkspace(staged, source, []), /workspace publication conflict/);
    assert.equal(await readFile(join(source, 'manifest.json'), 'utf8'), 'host');
  } finally { await rm(root, { recursive: true, force: true }); }
});
