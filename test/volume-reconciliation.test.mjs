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
const normalizeHistory = history => history.map(({ at, ...event }) => event);
const deterministicClock = () => {
  let value = Date.now();
  return { now: () => value, sleep: ms => { value += ms; } };
};
const exactHistory = (history, expected) => {
  assert.deepEqual(normalizeHistory(history), expected);
  assert.equal(history.every(event => Object.isFrozen(event)), true);
};

 test('volume reconciliation retries transient inspect and then reaps before stable absence', async () => {
  const clock = deterministicClock();
  const mock = dockerMock({ inspect: n => n === 1 ? { output: '', error: 'temporary transport failure', code: 1 } : n === 2 ? owned() : absent() });
  const history = await reconcileVolume('docker', id, label, mock.spawn, { deadline: clock.now() + 1800, now: clock.now, sleep: clock.sleep });
  const expected = [
    { name: id, action: 'attempt', operation: 'inspect' },
    { name: id, action: 'error', operation: 'inspect', classification: 'transient', error: 'scratch volume inspect failed' },
    { name: id, action: 'retry', classification: 'transient' },
    { name: id, action: 'attempt', operation: 'inspect' },
    { name: id, action: 'attempt', operation: 'remove' },
    { name: id, action: 'remove_success', operation: 'remove' },
    { name: id, action: 'attempt', operation: 'inspect' },
    { name: id, action: 'error', operation: 'inspect', classification: 'not-found', error: 'scratch volume inspect failed' },
    { name: id, action: 'absence', classification: 'not-found' },
    ...Array.from({ length: 10 }, () => [
      { name: id, action: 'attempt', operation: 'inspect' },
      { name: id, action: 'error', operation: 'inspect', classification: 'not-found', error: 'scratch volume inspect failed' },
      { name: id, action: 'absence', classification: 'not-found' },
    ]).flat(),
    { name: id, action: 'stable_absence', classification: 'not-found' },
  ];
  exactHistory(history, expected);
  assert.equal(mock.counts().remove, 1);
});

test('volume reconciliation preserves foreign same-prefix volume and terminates on ownership mismatch', async () => {
  const mock = dockerMock({ inspect: () => ({ output: JSON.stringify({ Name: `${id}-foreign`, Labels: { 'yoloharness.run': 'other' } }) }) });
  await assert.rejects(reconcileVolume('docker', id, label, mock.spawn, { deadline: Date.now() + 1000 }), error => {
    assert.equal(error.code, 'cleanup_ownership');
    assert.equal(error.cleanupHistory.at(-1).action, 'terminal');
    assert.equal(error.cleanupHistory.at(-1).classification, 'ownership');
    exactHistory(error.cleanupHistory, [
      { name: id, action: 'attempt', operation: 'inspect' },
      { name: id, action: 'error', operation: 'inspect', classification: 'ownership', error: 'scratch volume ownership mismatch (name=yoloharness-scratch-run-foreign, label=other)' },
      { name: id, action: 'terminal', classification: 'ownership' },
    ]);
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
      const message = name === 'parse' ? 'scratch volume inspect returned malformed JSON' : 'scratch volume inspect failed';
      exactHistory(error.cleanupHistory, [
        { name: id, action: 'attempt', operation: 'inspect' },
        { name: id, action: 'error', operation: 'inspect', classification: name, error: message },
        { name: id, action: 'terminal', classification: name },
      ]);
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

test('volume reconciliation retries a busy remove and records immutable retry history', async () => {
  const mock = dockerMock({ inspect: n => n === 1 ? owned() : absent(), remove: n => n === 1 ? { output: '', error: 'volume is busy', code: 1 } : { output: '', code: 0 } });
  const history = await reconcileVolume('docker', id, label, mock.spawn, { deadline: Date.now() + 1800 });
  assert.ok(history.some(event => event.action === 'retry' && event.classification === 'busy'));
  assert.ok(history.some(event => event.action === 'remove_success'));
  assert.equal(history.at(-1).action, 'stable_absence');
  assert.equal(mock.counts().remove, 2);
  assert.ok(history.every(Object.isFrozen));
});

test('volume reconciliation waits through delayed same-identity appearance and removal', async () => {
  const mock = dockerMock({ inspect: n => n < 3 ? absent() : n === 3 ? owned() : absent() });
  const history = await reconcileVolume('docker', id, label, mock.spawn, { deadline: Date.now() + 1800 });
  assert.ok(history.some(event => event.action === 'absence'));
  assert.ok(history.some(event => event.action === 'remove_success'));
  assert.equal(history.at(-1).action, 'stable_absence');
});

test('volume reconciliation distinguishes exact-name wrong-label from same-prefix wrong-name', async () => {
  for (const inspected of [
    { Name: id, Labels: { 'yoloharness.run': 'other' } },
    { Name: `${id}-foreign`, Labels: { 'yoloharness.run': label } },
  ]) {
    const mock = dockerMock({ inspect: () => ({ output: JSON.stringify(inspected) }) });
    await assert.rejects(reconcileVolume('docker', id, label, mock.spawn, { deadline: Date.now() + 1000 }), error => {
      assert.equal(error.code, 'cleanup_ownership');
      assert.equal(error.cleanupHistory.at(-1).classification, 'ownership');
      return true;
    });
    assert.equal(mock.counts().remove, 0);
  }
});

test('volume reconciliation preserves direct normal control and repeated absence events', async () => {
  const mock = dockerMock({ inspect: () => absent() });
  const history = await reconcileVolume('docker', id, label, mock.spawn, { deadline: Date.now() + 1800 });
  assert.ok(history.filter(event => event.action === 'absence').length >= 2);
  assert.equal(history.at(-1).action, 'stable_absence');
  assert.equal(mock.counts().remove, 0);
});
