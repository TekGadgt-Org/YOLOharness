import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, recoverState, run, authorizeEffect, FixtureAdapter } from '../kernel.mjs';

test('bounded step loop stops at the configured budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yoloharness-'));
  const log = new EventLog(join(dir, 'events.jsonl'));
  const result = await run({ runId: 'budget-run', log, adapter: new FixtureAdapter(), maxSteps: 2 });
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.steps, 2);
  const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 4); // started, two steps, stopped
  assert.equal(JSON.parse(lines.at(-1)).type, 'run_stopped');
});

test('replay recovers state from append-only events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yoloharness-'));
  const path = join(dir, 'events.jsonl');
  const log = new EventLog(path);
  await run({ runId: 'replay-run', log, adapter: new FixtureAdapter(), maxSteps: 3 });
  const state = await recoverState(path, 'replay-run');
  assert.equal(state.status, 'budget_exhausted');
  assert.equal(state.steps, 3);
  assert.equal(state.lastAction, 'fixture:step-3');
  assert.equal(state.seq, 5);
});

test('reopened event log continues a run sequence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yoloharness-'));
  const path = join(dir, 'events.jsonl');
  await new EventLog(path).append('resume-run', 'run_started');
  const event = await new EventLog(path).append('resume-run', 'step', { step: 1 });
  assert.equal(event.seq, 2);
});

test('reopened event log continues each run after a multi-line log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yoloharness-'));
  const path = join(dir, 'events.jsonl');
  const firstLog = new EventLog(path);
  await firstLog.append('first-run', 'run_started');
  await firstLog.append('first-run', 'step', { step: 1 });
  await firstLog.append('second-run', 'run_started');

  const firstContinuation = await new EventLog(path).append('first-run', 'step', { step: 2 });
  const secondContinuation = await new EventLog(path).append('second-run', 'step', { step: 1 });
  assert.equal(firstContinuation.seq, 3);
  assert.equal(secondContinuation.seq, 2);
});

test('policy denies shell and network effects by default', () => {
  assert.deepEqual(authorizeEffect({ type: 'shell.exec', command: 'echo unsafe' }), { allowed: false, reason: 'external side effects are denied by default' });
  assert.equal(authorizeEffect({ type: 'network.request', url: 'https://example.test' }).allowed, false);
});

test('policy permits workspace-scoped file writes only', () => {
  assert.equal(authorizeEffect({ type: 'file.write', path: 'notes.txt' }, { workspaceRoot: '/workspace' }).allowed, true);
  assert.equal(authorizeEffect({ type: 'file.write', path: '/etc/passwd' }, { workspaceRoot: '/workspace' }).allowed, false);
});

test('policy rejects parent and root-relative paths outside the workspace', () => {
  const options = { workspaceRoot: '/workspace/project' };
  for (const path of ['..', '../escape', '.']) {
    assert.equal(authorizeEffect({ type: 'file.write', path }, options).allowed, path === '.' ? true : false, path);
  }
  assert.equal(authorizeEffect({ type: 'file.write', path: '/workspace/escape' }, options).allowed, false);
});
