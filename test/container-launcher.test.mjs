import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ContainerLauncher, validateWorkspace } from '../src/container-launcher.mjs';
import { configuredImage, runtimeSourceIdentity } from '../src/cli.mjs';

const child = (onCreate) => {
  const listeners = new Map();
  const value = {
    stdout: { on() {} }, stderr: { on() {} }, stdin: { end() {} },
    kill() { setImmediate(() => listeners.get('close')?.(137)); },
    once(event, fn) { listeners.set(event, fn); },
  };
  onCreate?.(value);
  return value;
};

test('launcher never starts a container after create is cancelled', async () => {
  const workspace = await mkdtemp('/tmp/yolo-launcher-cancel-');
  const controller = new AbortController();
  const operations = [];
  try {
    const launcher = new ContainerLauncher({ image: 'sha256:' + 'a'.repeat(64), workspace, timeoutMs: 1000, spawn: (_command, args) => {
      operations.push(args[0]);
      if (args[0] === 'info') return { stdout: { on(event, fn) { if (event === 'data') setImmediate(() => fn('["name=rootless"]')); } }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { if (event === 'close') setImmediate(() => fn(0)); } };
      if (args[0] === 'ps') return { stdout: { on() {} }, stderr: { on() {} }, once(event, fn) { if (event === 'close') setImmediate(() => fn(0)); } };
      if (args[0] === 'create') {
        const created = child();
        setImmediate(() => { controller.abort(new Error('cancelled during create')); created.kill('SIGKILL'); });
        return created;
      }
      throw new Error('start must not run after cancellation');
    } });
    await assert.rejects(launcher.launch({ prompt: 'synthetic' }, { signal: controller.signal }), /cancelled during create|docker operation failed/);
    assert.equal(operations[0], 'info');
    assert.equal(operations[1], 'create');
    assert.ok(operations.filter(operation => operation === 'ps').length >= 8);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('production launcher rejects injected network and endpoint overrides', async () => {
  assert.throws(() => new ContainerLauncher({
    image: 'sha256:' + 'd'.repeat(64),
    network: 'synthetic-network',
    responsesUrl: 'http://synthetic-provider/responses',
  }), /test-only/);
  assert.doesNotThrow(() => new ContainerLauncher({
    image: 'sha256:' + 'd'.repeat(64),
    testOnly: true,
    network: 'synthetic-network',
    responsesUrl: 'http://synthetic-provider/responses',
  }));
});

test('uncertain create waits for stable absence and removes a delayed daemon container', async () => {
  const workspace = await mkdtemp('/tmp/yolo-launcher-delayed-create-');
  const operations = [];
  let psCount = 0;
  try {
    const launcher = new ContainerLauncher({ image: 'sha256:' + 'c'.repeat(64), workspace, timeoutMs: 1000, spawn: (_command, args) => {
      const quick = (code = 0) => ({ stdout: { on() {} }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { if (event === 'close') setImmediate(() => fn(code)); } });
      operations.push(args[0]);
      if (args[0] === 'info') return { stdout: { on(event, fn) { if (event === 'data') setImmediate(() => fn('["name=rootless"]')); } }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { if (event === 'close') setImmediate(() => fn(0)); } };
      if (args[0] === 'create') { const created = child(); setImmediate(() => created.kill('SIGKILL')); return created; }
      if (args[0] === 'ps') {
        const listeners = new Map();
        const result = { stdout: { on() {} }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { listeners.set(event, fn); } };
        psCount += 1;
        result.stdout.on = (event, fn) => { if (event === 'data' && psCount === 2) setImmediate(() => fn('deadbeefdead')); };
        setTimeout(() => listeners.get('close')?.(0), 5); return result;
      }
      if (args[0] === 'kill' || args[0] === 'rm') return quick();
      if (args[0] === 'inspect') {
        const listeners = new Map();
        const result = { stdout: { on(event, fn) { if (event === 'data') setImmediate(() => fn('Error: No such container: deadbeefdead')); } }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { listeners.set(event, fn); } };
        setImmediate(() => listeners.get('close')?.(1)); return result;
      }
      throw new Error(`unexpected docker operation: ${args[0]}`);
    } });
    await assert.rejects(launcher.launch({ prompt: 'delayed' }), /docker operation failed|cleanup_unknown|cancelled|deadline/);
    assert.ok(psCount >= 2);
    assert.ok(operations.includes('rm'), operations.join(','));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('uncertain create does not declare absence before the full reconciliation grace', async () => {
  const workspace = await mkdtemp('/tmp/yolo-launcher-full-grace-');
  let firstPsAt;
  let lastPsAt;
  try {
    const launcher = new ContainerLauncher({ image: 'sha256:' + 'e'.repeat(64), workspace, timeoutMs: 1000, spawn: (_command, args) => {
      const listeners = new Map();
      const quick = (code = 0, output = '') => ({ stdout: { on(event, fn) { if (event === 'data' && output) setImmediate(() => fn(output)); } }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { listeners.set(event, fn); if (event === 'close') setImmediate(() => fn(code)); } });
      if (args[0] === 'info') return quick(0, '["name=rootless"]');
      if (args[0] === 'create') return { stdout: { on() {} }, stderr: { on() {} }, stdin: { end() {} }, kill() { setImmediate(() => listeners.get('close')?.(137)); }, once(event, fn) { listeners.set(event, fn); } };
      if (args[0] === 'ps') { const now = Date.now(); firstPsAt ??= now; lastPsAt = now; return quick(); }
      throw new Error(`unexpected docker operation: ${args[0]}`);
    } });
    await assert.rejects(launcher.launch({ prompt: 'grace' }), /cleanup_unknown|docker operation failed|cancelled|deadline/);
    assert.ok(lastPsAt - firstPsAt >= 450, `reconciliation lasted ${lastPsAt - firstPsAt}ms`);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('workspace validation rejects nested mount points and multiply-linked files', async () => {
  const workspace = await mkdtemp('/tmp/yolo-workspace-check-');
  const outside = await mkdtemp('/tmp/yolo-workspace-outside-');
  try {
    const file = join(outside, 'outside.txt'); await writeFile(file, 'sentinel');
    await link(file, join(workspace, 'alias.txt'));
    await assert.rejects(validateWorkspace(workspace), /multiply-linked/);
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('runtime source identity is a versioned sha256 digest', async () => {
  const identity = await runtimeSourceIdentity();
  assert.match(identity.sourceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(identity.sourceVersion, '0.1.0');
});

test('configured image requires the complete versioned source-identity metadata', async () => {
  const data = await mkdtemp('/tmp/yolo-image-metadata-');
  const old = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  try {
    await mkdir(join(data, 'yoloharness'), { recursive: true });
    await writeFile(join(data, 'yoloharness', 'image.json'), JSON.stringify({
      version: 1,
      imageId: `sha256:${'a'.repeat(64)}`,
      sourceDigest: `sha256:${'b'.repeat(64)}`,
      sourceVersion: '0.1.0',
    }));
    assert.equal(await configuredImage(), `sha256:${'a'.repeat(64)}`);
  } finally {
    if (old === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = old;
    await rm(data, { recursive: true, force: true });
  }
});

test('launcher uses one absolute deadline and does not create after slow preflight', async () => {
  const workspace = await mkdtemp('/tmp/yolo-workspace-deadline-');
  const operations = [];
  try {
    const launcher = new ContainerLauncher({ image: 'sha256:' + 'b'.repeat(64), workspace, timeoutMs: 10, spawn: (_command, args) => {
      operations.push(args[0]);
      const listeners = new Map();
      return { stdout: { on(event, fn) { if (event === 'data') setTimeout(() => fn('[\"name=rootless\"]'), 20); } }, stderr: { on() {} }, stdin: { end() {} }, kill() { setImmediate(() => listeners.get('close')?.(137)); }, once(event, fn) { listeners.set(event, fn); if (event === 'close') setTimeout(() => fn(0), 25); } };
    } });
    await assert.rejects(launcher.launch({ prompt: 'slow' }), /cleanup_unknown|deadline|operation/);
    assert.deepEqual(operations, ['info']);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
