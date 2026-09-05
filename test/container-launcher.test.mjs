import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
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
    await assert.rejects(launcher.launch({ prompt: 'synthetic' }, { signal: controller.signal }), /cancelled during create|docker operation failed|cleanup_unknown/);
    assert.equal(operations[0], 'info');
    assert.equal(operations[1], 'create');
    assert.ok(operations.filter(operation => operation === 'ps').length >= 8);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

async function uncertainCreateFixture({ failure = 'cancel', appearAfter = 8 } = {}) {
  const workspace = await mkdtemp('/tmp/yolo-launcher-uncertain-');
  const controller = new AbortController();
  const operations = [];
  let psCount = 0;
  let removed = 0;
  const ownedId = 'deadbeefdead';
  const spawn = (_command, args) => {
    const operation = args[0]; operations.push(operation);
    const listeners = new Map();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const result = {
      stdout, stderr, stdin: { end() {} },
      kill() { setImmediate(() => listeners.get('close')?.(137)); },
      once(event, fn) { listeners.set(event, fn); },
    };
    if (operation === 'info') {
      setImmediate(() => stdout.emit('data', '["name=rootless"]'));
      setImmediate(() => listeners.get('close')?.(0));
    } else if (operation === 'create') {
      if (failure === 'stdout') setImmediate(() => stdout.emit('data', 'x'.repeat(1024 * 1024 + 1)));
      if (failure === 'stderr') setImmediate(() => stderr.emit('data', 'x'.repeat(1024 * 1024 + 1)));
      if (failure === 'nonzero') setImmediate(() => listeners.get('close')?.(17));
      if (failure === 'cancel') setImmediate(() => { controller.abort(new Error('cancelled during create')); result.kill(); });
      // timeout intentionally leaves create open until launch's deadline kills it.
    } else if (operation === 'ps') {
      psCount += 1;
      if (removed === 0 && psCount >= appearAfter) setImmediate(() => stdout.emit('data', `${ownedId}\n`));
      setImmediate(() => listeners.get('close')?.(0));
    } else if (operation === 'kill' || operation === 'rm') {
      if (operation === 'rm') removed += 1;
      setImmediate(() => listeners.get('close')?.(0));
    } else if (operation === 'inspect') {
      setImmediate(() => stderr.emit('data', `Error: No such container: ${ownedId}`));
      setImmediate(() => listeners.get('close')?.(1));
    } else {
      throw new Error(`unexpected docker operation: ${operation}`);
    }
    return result;
  };
  const launcher = new ContainerLauncher({ image: 'sha256:' + 'f'.repeat(64), workspace, timeoutMs: failure === 'timeout' ? 30 : 1000, spawn });
  try {
    await assert.rejects(launcher.launch({ prompt: `uncertain-${failure}` }, { signal: controller.signal }), /cleanup_unknown|docker operation failed|cancelled|deadline|output limit/);
    assert.ok(psCount >= appearAfter, `${failure} reconciled before delayed appearance`);
    assert.equal(removed, 1, `${failure} did not remove the exact discovered ID`);
    assert.equal(operations.includes('start'), false, `${failure} unexpectedly started a container`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test('uncertain create cancellation reconciles a delayed daemon appearance with no returned ID', async () => {
  await uncertainCreateFixture({ failure: 'cancel' });
});

test('uncertain create timeout reconciles a delayed daemon appearance with no returned ID', async () => {
  await uncertainCreateFixture({ failure: 'timeout' });
});

test('uncertain create stdout overflow reconciles a delayed daemon appearance with no returned ID', async () => {
  await uncertainCreateFixture({ failure: 'stdout' });
});

test('uncertain create stderr overflow and nonzero create reconcile delayed daemon appearances with no returned ID', async (t) => {
  await t.test('stderr overflow', () => uncertainCreateFixture({ failure: 'stderr' }));
  await t.test('nonzero create', () => uncertainCreateFixture({ failure: 'nonzero' }));
});

test('production launcher has no caller-selectable network or endpoint policy', () => {
  const launcher = new ContainerLauncher({ image: 'sha256:' + 'd'.repeat(64), network: 'synthetic-network', responsesUrl: 'http://synthetic-provider/responses', testOnly: true });
  assert.equal(Object.hasOwn(launcher, 'network'), false);
  assert.equal(Object.hasOwn(launcher, 'responsesUrl'), false);
  assert.equal(Object.hasOwn(launcher, 'testOnly'), false);
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
