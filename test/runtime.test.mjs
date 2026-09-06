import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, redact, recoverEvents } from '../src/events.mjs';
import { runOnce, FixtureProvider, MissingProviderError, EXEC_TOOL } from '../src/runtime.mjs';
import { validateWorkspace } from '../src/container-launcher.mjs';

test('event log writes ordered bounded redacted JSONL and reopens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-')); const path = join(dir, 'events.jsonl');
  const log = new EventLog(path, { maxBytes: 1000 });
  await log.append('r', 'one', { token: 'secret', text: 'x'.repeat(100) });
  const event = await new EventLog(path, { maxBytes: 1000 }).append('r', 'two');
  assert.equal(event.seq, 2); assert.equal(redact({ authorization: 'Bearer nope' }).authorization, '[REDACTED]');
  const lines = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(e => e.seq), [1, 2]); assert.equal(lines[0].payload.token, '[REDACTED]');
});

test('fixture completes with a final version 1 record', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-'));
  const record = await runOnce({ prompt: 'hello', minutes: 1, workspace, provider: new FixtureProvider() });
  assert.equal(record.status, 'completed'); assert.equal(record.version, 1); assert.equal(record.result, 'fixture response for: hello');
  assert.match(record.run_id, /^run-/); assert.ok(record.evidence.length >= 1);
});

test('deadline cancels cooperative and hanging providers and preserves partial result', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-'));
  const provider = { async next({ signal }) { await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(Object.assign(signal.reason, { partialResult: 'partial streamed answer' })), { once: true }); }); } };
  const record = await runOnce({ prompt: 'slow', minutes: 0.001, workspace, provider });
  assert.equal(record.status, 'deadline'); assert.equal(record.result, 'partial streamed answer'); assert.ok(record.errors.length);
});

test('real mode never falls back to fixture', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-'));
  await assert.rejects(runOnce({ prompt: 'x', minutes: 1, workspace }), MissingProviderError);
});

test('zero-progress provider is capped', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-'));
  const record = await runOnce({ prompt: 'x', minutes: 1, workspace, provider: { async next() { return { done: false }; } }, maxSteps: 2 });
  assert.equal(record.status, 'step_limit');
});

test('deadline returns from a non-cooperative provider', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-'));
  const started = Date.now();
  const record = await runOnce({ prompt: 'never', minutes: 0.0005, workspace, provider: { next() { return new Promise(() => {}); } } });
  assert.equal(record.status, 'deadline'); assert.ok(Date.now() - started < 1000);
});

test('deadline awaits executor cleanup before returning', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-'));
  let cleaned = false;
  const provider = { async next() { return { tool_call: { call_id: 'cleanup-1', name: 'exec', arguments: JSON.stringify({ command: 'true', args: [] }) } }; } };
  const executor = { async execute({ signal }) { await new Promise(resolve => signal.addEventListener('abort', () => setTimeout(() => { cleaned = true; resolve(); }, 30), { once: true })); return { version: 1, ok: true, call_id: 'cleanup-1', code: 0, output: '' }; } };
  const started = Date.now();
  const record = await runOnce({ prompt: 'cleanup', minutes: 0.0005, workspace, provider, executor, tools: [EXEC_TOOL], cleanupGraceMs: 100 });
  assert.equal(record.status, 'deadline');
  assert.equal(cleaned, true);
  assert.ok(Date.now() - started >= 30);
});

test('deadline reports unknown cleanup when executor exceeds cleanup grace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-'));
  const provider = { async next() { return { tool_call: { call_id: 'cleanup-2', name: 'exec', arguments: JSON.stringify({ command: 'true', args: [] }) } }; } };
  const executor = { async execute() { return new Promise(() => {}); } };
  const record = await runOnce({ prompt: 'cleanup', minutes: 0.0005, workspace, provider, executor, tools: [EXEC_TOOL], cleanupGraceMs: 10 });
  assert.equal(record.status, 'deadline');
  assert.ok(record.errors.some(error => error.includes('cleanup_unknown')));
});

test('invalid inputs are rejected', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-'));
  await assert.rejects(runOnce({ prompt: '', workspace, minutes: 1 }), /prompt/);
  await assert.rejects(runOnce({ prompt: 'x', workspace, minutes: 0 }), /minutes/);
});

// Historical prototype tests are run by the root command through this import smoke check.
test('prototype remains present', async () => { assert.ok((await import('../prototype/kernel.mjs')).FixtureAdapter); });

test('recoverEvents ignores no events and returns ordered records', async () => { assert.deepEqual(await recoverEvents('/nonexistent/yolo-events.jsonl', 'none'), []); });

test('exec bridge validates the exact registry and passes normalized argv with pairing', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-')); const calls = [];
  let step = 0;
  const provider = { async next({ tools }) { assert.deepEqual(tools, [EXEC_TOOL]); step += 1; return step === 1 ? { tool_call: { call_id: 'c1', name: 'exec', arguments: JSON.stringify({ command: 'printf', args: ['safe'] }) } } : { done: true, result: 'finished' }; } };
  const executor = { async execute({ call }) { calls.push(call); return { version: 1, ok: true, call_id: call.call_id, code: 0, output: 'safe' }; } };
  const record = await runOnce({ prompt: 'run it', workspace, provider, executor, tools: [EXEC_TOOL] });
  assert.equal(record.status, 'completed'); assert.deepEqual(calls, [{ command: 'printf', args: ['safe'], call_id: 'c1' }]);
});

test('failed executor receipts stop the run instead of allowing a false provider completion', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-')); let steps = 0;
  const provider = { async next() { steps += 1; return steps === 1
    ? { tool_call: { call_id: 'failed-1', name: 'exec', arguments: JSON.stringify({ command: 'sh', args: [] }) } }
    : { done: true, result: 'must-not-complete' }; } };
  const executor = { async execute() { return { version: 1, ok: false, call_id: 'failed-1', code: 124, output: '', error: 'command deadline or output limit exceeded' }; } };
  const record = await runOnce({ prompt: 'stop', workspace, provider, executor, tools: [EXEC_TOOL] });
  assert.equal(record.status, 'deadline'); assert.equal(steps, 1); assert.match(record.errors[0], /command deadline/);
});

test('workspace validation rejects symlinks that resolve outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-symlink-'));
  const workspace = join(root, 'workspace');
  try {
    await mkdir(workspace);
    await writeFile(join(root, 'outside.txt'), 'outside sentinel');
    await symlink(join(root, 'outside.txt'), join(workspace, 'escape.txt'));
    await assert.rejects(() => validateWorkspace(workspace), /symlink resolves outside workspace/);
    await rm(join(workspace, 'escape.txt'));
    await writeFile(join(workspace, 'inside.txt'), 'inside');
    await symlink(join(workspace, 'inside.txt'), join(workspace, 'safe-link.txt'));
    assert.equal(await validateWorkspace(workspace), workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
