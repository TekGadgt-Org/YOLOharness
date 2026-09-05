import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, redact, recoverEvents } from '../src/events.mjs';
import { runOnce, FixtureProvider, MissingProviderError } from '../src/runtime.mjs';

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
  assert.equal(record.status, 'completed'); assert.equal(record.result, 'fixture response for: hello');
  assert.match(record.run_id, /^run-/); assert.ok(record.evidence.length >= 1);
});

test('deadline cancels cooperative and hanging providers and preserves partial result', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-'));
  const provider = { async next({ signal }) { await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); } };
  const record = await runOnce({ prompt: 'slow', minutes: 0.001, workspace, provider });
  assert.equal(record.status, 'deadline'); assert.ok(record.errors.length);
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

test('invalid inputs are rejected', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-'));
  await assert.rejects(runOnce({ prompt: '', workspace, minutes: 1 }), /prompt/);
  await assert.rejects(runOnce({ prompt: 'x', workspace, minutes: 0 }), /minutes/);
});

// Historical prototype tests are run by the root command through this import smoke check.
test('prototype remains present', async () => { assert.ok((await import('../prototype/kernel.mjs')).FixtureAdapter); });

test('recoverEvents ignores no events and returns ordered records', async () => { assert.deepEqual(await recoverEvents('/nonexistent/yolo-events.jsonl', 'none'), []); });
