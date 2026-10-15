import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderCause, normalizeReceipt, safeFailureSummary } from '../src/receipt-contract.mjs';
import { validateReceipt } from '../src/docker-executor.mjs';

test('failure summaries reject adversarial provider text without terminal controls or secrets', () => {
  for (const value of [
    'https://provider.invalid/token',
    'Bearer secret-token',
    'line one\nline two',
    '\u001b[31mred\u001b[0m',
    'bell\u0007',
    '\u202ehidden',
    'x'.repeat(10000),
    '/srv/private/output.txt',
  ]) {
    const summary = safeFailureSummary(value);
    assert.ok(summary.length <= 256);
    assert.doesNotMatch(summary, /https?:\/\/|Bearer|\u001b|\u0007|\u202e|\n|\/srv/iu);
  }
  assert.equal(safeFailureSummary('fetch failed'), 'fetch failed');
});

test('provider cause classification degrades safely for throwing getters', () => {
  const cause = new Proxy({}, { get() { throw new Error('getter trap'); } });
  assert.deepEqual(classifyProviderCause(cause), { classification: 'unavailable' });
});

test('legacy receipt adapts to complete v2 and v2 fields are preserved', () => {
  const legacy = { version: 1, run_id: 'r1', status: 'failed', effect_state: 'uncertain', result: 'partial', evidence: ['e'], artifacts: ['a'], errors: ['failed'] };
  const adapted = normalizeReceipt(legacy, { status: 'cleanup_unknown', error: 'cleanup unknown' });
  assert.equal(adapted.version, 2);
  assert.equal(adapted.run_id, 'r1');
  assert.deepEqual(adapted.evidence, ['e']);
  assert.equal(adapted.failure.version, 1);
  const v2 = { version: 2, run_id: 'r2', status: 'deadline', effect_state: 'uncertain', result: 'v2 result', evidence: ['v2 evidence'], artifacts: ['v2 artifact'], publication_evidence: { status: 'published', created_entry_count: 1 }, failure: { version: 1, terminal: { phase: 'runtime', message: 'deadline' }, recovered: [] }, errors: ['deadline'] };
  assert.deepEqual(normalizeReceipt(v2), v2);
});

test('termination validation is closed and consistent', () => {
  const base = { version: 1, ok: false, call_id: 'c', code: 137, output: '', error: 'killed' };
  assert.equal(validateReceipt({ ...base, termination: { code: 137, classification: 'sigkill_compatible' } }, 'c'), true);
  assert.equal(validateReceipt({ ...base, termination: { code: 137, classification: 'oom', nested: {} } }, 'c'), false);
  assert.equal(validateReceipt({ ...base, termination: { code: 1, classification: 'signal' } }, 'c'), false);
  assert.equal(validateReceipt({ ...base, termination: { code: 137, classification: 'timeout_or_output_limit' } }, 'c'), false);
  assert.equal(validateReceipt({ ...base, termination: { code: 137, classification: 'sigkill_compatible', classification2: 'x' } }, 'c'), false);
});

test('v2 normalization is closed, bounded, and sanitizes hostile nested fields', () => {
  const hostile = normalizeReceipt({ version: 2, run_id: 'r', status: 'failed', effect_state: 'none', unknown: 'marker', result: 'https://secret.invalid/token', evidence: [{ marker: 'secret', nested: { leak: true } }], artifacts: [{ path: '/srv/private/token' }], publication_evidence: { status: 'published', relationship: 'https://secret.invalid', marker: 'leak', created_entry_count: '1' }, failure: { version: 1, terminal: { phase: 'runtime', message: 'https://secret.invalid/token', marker: 'leak' }, recovered: [{ phase: 'tool', message: '\u202ehidden' }], marker: 'leak' }, errors: ['https://secret.invalid/token'], cleanup_unknown: 'leak' });
  assert.equal(hostile.unknown, undefined);
  assert.equal(hostile.cleanup_unknown, undefined);
  assert.doesNotMatch(JSON.stringify(hostile), /secret\.invalid|marker|\u202e|\/srv\/private/);
  assert.ok(hostile.errors.length <= 64);
  assert.ok(Object.keys(hostile.failure).every(key => ['version', 'terminal', 'recovered'].includes(key)));
});
