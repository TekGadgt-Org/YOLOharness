import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateEmptyWorkspace, seedWorkspace, publishWorkspace } from '../src/workspace-sync.mjs';

async function absent(path) { return assert.rejects(() => readFile(path), /ENOENT/); }

test('empty workspace policy accepts only a truly empty directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yolo-empty-'));
  try { assert.equal(await validateEmptyWorkspace(root), root); await writeFile(join(root, '.hidden'), 'x'); await assert.rejects(() => validateEmptyWorkspace(root), /initially empty/); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('create-only publication recursively excludes dependencies and preserves durable outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yolo-publish-')); const staged = join(root, 'staged'); const destination = join(root, 'destination');
  try {
    await mkdir(join(staged, 'src', 'node_modules', 'dep'), { recursive: true }); await mkdir(join(staged, 'packages', 'app', 'vendor', 'pkg'), { recursive: true });
    await writeFile(join(staged, 'src', 'main.js'), 'main'); await writeFile(join(staged, 'src', 'node_modules', 'dep', 'index.js'), 'secret');
    await writeFile(join(staged, 'packages', 'app', 'package-lock.json'), '{}'); await writeFile(join(staged, 'packages', 'app', 'vendor', 'pkg', 'index.js'), 'dependency');
    await mkdir(destination); await seedWorkspace(destination, join(root, 'baseline'), ['node_modules', 'vendor']); await publishWorkspace(staged, destination, ['node_modules', 'vendor']);
    assert.equal(await readFile(join(destination, 'src', 'main.js'), 'utf8'), 'main'); assert.equal(await readFile(join(destination, 'packages', 'app', 'package-lock.json'), 'utf8'), '{}');
    await absent(join(destination, 'src', 'node_modules', 'dep', 'index.js')); await absent(join(destination, 'packages', 'app', 'vendor', 'pkg', 'index.js'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('create-only publication fails on a destination conflict and retains prior output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yolo-conflict-')); const staged = join(root, 'staged'); const destination = join(root, 'destination');
  try { await mkdir(staged); await mkdir(destination); await writeFile(join(staged, 'result.txt'), 'generated'); await writeFile(join(destination, 'result.txt'), 'operator'); await assert.rejects(() => publishWorkspace(staged, destination, []), /publication destination is not empty/); assert.equal(await readFile(join(destination, 'result.txt'), 'utf8'), 'operator'); }
  finally { await rm(root, { recursive: true, force: true }); }
});
