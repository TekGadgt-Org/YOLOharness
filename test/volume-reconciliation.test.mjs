import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { reconcileVolume } from '../src/container-launcher.mjs';

const id = 'yoloharness-scratch-run';
const label = 'run';

function dockerMock({ inspect, remove = () => ({ output: '', code: 0 }) }) {
  let inspectCount = 0;
  let removeCount = 0;
  const operations = [];
  const spawn = (_command, args) => {
    const stream = new EventEmitter();
    const errors = new EventEmitter();
    const listeners = new Map();
    const op = args[1];
    operations.push(args);
    const result = { stdout: stream, stderr: errors, stdin: { end() {} }, kill() {}, once(event, fn) { listeners.set(event, fn); } };
    const spec = op === 'inspect' ? inspect(++inspectCount) : remove(++removeCount);
    if (spec.throw) throw spec.throw;
    setImmediate(() => {
      if (spec.output) stream.emit('data', spec.output);
      if (spec.error) errors.emit('data', spec.error);
      listeners.get('close')?.(spec.code ?? 0);
    });
    return result;
  };
  return { spawn, operations, counts: () => ({ inspect: inspectCount, remove: removeCount }) };
}

const owned = () => ({ output: JSON.stringify({ Name: id, Labels: { 'yoloharness.run': label } }) });
const absent = () => ({ output: '', error: `Error response from daemon: volume ${id} not found`, code: 1 });

 test('volume reconciliation retries transient inspect and then reaps before stable absence', async () => {
  const mock = dockerMock({ inspect: n => n === 1 ? { output: '', error: 'temporary transport failure', code: 1 } : n === 2 ? owned() : absent() });
  const history = await reconcileVolume('docker', id, label, mock.spawn, { deadline: Date.now() + 1800 });
  const actions = history.map(event => event.action);
  assert.deepEqual(actions.slice(0, 7), ['attempt', 'error', 'retry', 'attempt', 'attempt', 'remove_success', 'attempt']);
  assert.equal(history.find(event => event.action === 'error').classification, 'transient');
  assert.equal(actions.at(-1), 'stable_absence');
  assert.equal(mock.counts().remove, 1);
  assert.ok(history.every(event => Object.isFrozen(event)));
});

test('volume reconciliation preserves foreign same-prefix volume and terminates on ownership mismatch', async () => {
  const mock = dockerMock({ inspect: () => ({ output: JSON.stringify({ Name: `${id}-foreign`, Labels: { 'yoloharness.run': 'other' } }) }) });
  await assert.rejects(reconcileVolume('docker', id, label, mock.spawn, { deadline: Date.now() + 1000 }), error => {
    assert.equal(error.code, 'cleanup_ownership');
    assert.equal(error.cleanupHistory.at(-1).action, 'terminal');
    assert.equal(error.cleanupHistory.at(-1).classification, 'ownership');
    return true;
  });
  assert.equal(mock.counts().remove, 0);
});

test('volume reconciliation classifies parse permission exit and transport as terminal', async () => {
  for (const [name, spec] of [
    ['parse', { output: '{bad' }],
    ['permission', { output: '', error: 'permission denied', code: 1 }],
    ['exit', { output: '', error: 'daemon rejected request', code: 17 }],
    ['transport', { throw: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) }],
  ]) {
    const mock = dockerMock({ inspect: () => spec });
    await assert.rejects(reconcileVolume('docker', id, label, mock.spawn, { deadline: Date.now() + 1000 }), error => {
      assert.equal(error.cleanupHistory.at(-1).classification, name);
      return true;
    });
  }
});

test('volume reconciliation records deadline exhaustion as typed deadline history', async () => {
  const mock = dockerMock({ inspect: () => owned(), remove: () => ({ output: '', error: 'volume is busy', code: 1 }) });
  await assert.rejects(reconcileVolume('docker', id, label, mock.spawn, { deadline: Date.now() + 180 }), error => {
    assert.equal(error.code, 'cleanup_unknown');
    assert.equal(error.cleanupHistory.at(-1).action, 'deadline');
    assert.equal(error.cleanupHistory.at(-1).classification, 'timeout');
    return true;
  });
});
