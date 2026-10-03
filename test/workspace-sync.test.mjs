import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedWorkspace, publishWorkspace, inspectPublication, recoverPublicationState, discardPublication } from '../src/workspace-sync.mjs';

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

test('workspace staging preserves writable directory modes after a restrictive helper umask', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-sync-'));
  const source = join(root, 'source'); const staged = join(root, 'staged');
  try {
    await mkdir(source); await chmod(source, 0o777); await mkdir(join(source, '.yolo'), { recursive: true });
    await chmod(join(source, '.yolo'), 0o777);
    await seedWorkspace(source, staged);
    assert.equal((await stat(staged)).mode & 0o777, 0o777);
    assert.equal((await stat(join(staged, '.yolo'))).mode & 0o777, 0o777);
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

test('workspace publication uses the seed manifest as a three-way baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-sync-'));
  const source = join(root, 'source'); const staged = join(root, 'staged');
  try {
    await mkdir(source); await writeFile(join(source, 'unchanged'), 'base'); await writeFile(join(source, 'replace'), 'base'); await writeFile(join(source, 'delete'), 'base'); await writeFile(join(source, 'host-only'), 'host');
    await seedWorkspace(source, staged); await writeFile(join(staged, 'new-output'), 'new'); await writeFile(join(staged, 'replace'), 'staged'); await rm(join(staged, 'delete')); await writeFile(join(source, 'host-only'), 'host-edit');
    await publishWorkspace(staged, source);
    assert.equal(await readFile(join(source, 'new-output'), 'utf8'), 'new'); assert.equal(await readFile(join(source, 'replace'), 'utf8'), 'staged'); assert.equal(await exists(join(source, 'delete')), false); assert.equal(await readFile(join(source, 'host-only'), 'utf8'), 'host-edit');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace publication rejects concurrent create and both-sides edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-sync-'));
  const source = join(root, 'source'); const staged = join(root, 'staged');
  try {
    await mkdir(source); await writeFile(join(source, 'base'), 'base'); await seedWorkspace(source, staged); await writeFile(join(staged, 'new'), 'staged'); await writeFile(join(source, 'new'), 'host');
    await assert.rejects(publishWorkspace(staged, source), /workspace publication conflict: new/);
    await rm(join(source, 'new')); await writeFile(join(staged, 'base'), 'staged'); await writeFile(join(source, 'base'), 'host');
    await assert.rejects(publishWorkspace(staged, source), /workspace publication conflict: base/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace publication never publishes harness-owned receipt state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-sync-'));
  const source = join(root, 'source'); const staged = join(root, 'staged');
  try {
    await mkdir(join(source, '.yolo'), { recursive: true }); await writeFile(join(source, '.yolo', 'last-receipt.json'), 'host'); await seedWorkspace(source, staged); await writeFile(join(staged, '.yolo', 'last-receipt.json'), 'staged');
    await publishWorkspace(staged, source); assert.equal(await readFile(join(source, '.yolo', 'last-receipt.json'), 'utf8'), 'host');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace publication retains a durable journal and provider-free recovery handles a rename fault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-sync-'));
  const source = join(root, 'source'); const staged = join(root, 'staged');
  try {
    await mkdir(source); await writeFile(join(source, 'result'), 'before'); await seedWorkspace(source, staged); await writeFile(join(staged, 'result'), 'after');
    process.env.YOLO_PUBLICATION_FAULT = 'after-source-rename';
    await assert.rejects(publishWorkspace(staged, source), /publication interrupted/);
    delete process.env.YOLO_PUBLICATION_FAULT;
    assert.equal((await inspectPublication(source)).phase, 'source-renamed');
    assert.equal(await recoverPublicationState(source), true);
    assert.equal(await readFile(join(source, 'result'), 'utf8'), 'before');
    assert.equal((await inspectPublication(source)).retained, false);
  } finally { delete process.env.YOLO_PUBLICATION_FAULT; await rm(root, { recursive: true, force: true }); }
});

test('publication discard removes retained state without changing the source when no destructive phase ran', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-sync-'));
  const source = join(root, 'source'); const staged = join(root, 'staged');
  try {
    await mkdir(source); await writeFile(join(source, 'result'), 'before'); await seedWorkspace(source, staged); await writeFile(join(staged, 'result'), 'after');
    process.env.YOLO_PUBLICATION_FAULT = 'after-journal';
    await assert.rejects(publishWorkspace(staged, source), /publication interrupted/);
    delete process.env.YOLO_PUBLICATION_FAULT;
    assert.equal(await discardPublication(source), true);
    assert.equal(await readFile(join(source, 'result'), 'utf8'), 'before');
    assert.equal((await inspectPublication(source)).retained, false);
  } finally { delete process.env.YOLO_PUBLICATION_FAULT; await rm(root, { recursive: true, force: true }); }
});
