import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ContainerLauncher, validateWorkspace } from '../src/container-launcher.mjs';
import { runtimeSourceIdentity } from '../src/cli.mjs';

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
    assert.deepEqual(operations, ['info', 'create', 'ps']);
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
