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

test('normalized failure preserves only the canonical provider cause projection', () => {
  const normalized = normalizeReceipt({ version: 2, status: 'failed', failure: { terminal: {
    phase: 'provider', message: 'provider failed',
    cause: { code: 'ECONNRESET', syscall: 'read', errno: -104, message: 'https://secret.invalid/token', nested: { leak: true } },
  } } });
  assert.deepEqual(normalized.failure.terminal.cause, { code: 'ECONNRESET', syscall: 'read', errno: -104 });
});

test('normalized failure preserves unavailable projection for explicitly unsupported causes', () => {
  for (const cause of [null, 'provider cause', 42, true, () => {}]) {
    const normalized = normalizeReceipt({ version: 2, status: 'failed', failure: { terminal: { phase: 'provider', message: 'failed', cause } } });
    assert.deepEqual(normalized.failure.terminal.cause, { classification: 'unavailable' });
  }
});

test('property-bearing function causes never cross the provider-cause boundary', () => {
  function plainCause() {}
  async function asyncCause() {}
  class classCause {}
  const callableCause = new Proxy(function callableCause() {}, {});
  for (const cause of [plainCause, asyncCause, classCause, callableCause]) {
    Object.assign(cause, { code: 'EXFILTRATE_7f9a4c2d', syscall: 'attacker_controlled', errno: 31337 });
    assert.deepEqual(classifyProviderCause(cause), { classification: 'unavailable' });
    const normalized = normalizeReceipt({ version: 2, status: 'failed', failure: { terminal: { phase: 'provider', message: 'failed', cause } } });
    assert.deepEqual(normalized.failure.terminal.cause, { classification: 'unavailable' });
    assert.doesNotMatch(JSON.stringify(normalized), /EXFILTRATE|attacker_controlled|31337/);
  }
});

test('normalized failure keeps absent cause absent while preserving canonical cause fields', () => {
  const absent = normalizeReceipt({ version: 2, status: 'failed', failure: { terminal: { phase: 'provider', message: 'failed' } } });
  assert.equal(Object.hasOwn(absent.failure.terminal, 'cause'), false);
  const canonical = normalizeReceipt({ version: 2, status: 'failed', failure: { terminal: { phase: 'provider', message: 'failed', cause: { code: 'ECONNRESET', syscall: 'read', errno: -104, hostile: 'drop' } } } });
  assert.deepEqual(canonical.failure.terminal.cause, { code: 'ECONNRESET', syscall: 'read', errno: -104 });
});

test('failure prose rejects separator-delimited credential markers while preserving benign diagnostics', () => {
  for (const marker of [
    'TOKEN_MARKER_8B_secret',
    'access_token=secret-value',
    'refresh-token: secret-value',
    'auth token secret-value',
    'client_secret=secret-value',
  ]) assert.equal(safeFailureSummary(marker), 'operation failed', marker);
  assert.equal(safeFailureSummary('connection refused'), 'connection refused');
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
  assert.equal(validateReceipt({ ...base, code: 1, termination: { classification: 'sigkill_compatible' } }, 'c'), false);
  assert.equal(validateReceipt({ ...base, code: 1, termination: { classification: 'timeout_or_output_limit' } }, 'c'), false);
  assert.equal(validateReceipt({ ...base, code: 124, termination: { classification: 'signal' } }, 'c'), false);
  assert.equal(validateReceipt({ ...base, code: 136, signal: 'SIGFPE', termination: { classification: 'signal' } }, 'c'), true);
  assert.equal(validateReceipt({ ...base, code: 137, termination: { classification: 'sigkill_compatible' } }, 'c'), true);
  assert.equal(validateReceipt({ ...base, code: 124, termination: { classification: 'timeout_or_output_limit' } }, 'c'), true);
});

test('bounded ordinary receipt values preserve URLs and workspace paths while failure text stays redacted', () => {
  const url = 'https://example.invalid/result?token=public';
  const path = '/workspace/output/result.txt';
  const normalized = normalizeReceipt({
    version: 2,
    status: 'completed',
    result: url,
    evidence: [path, { output: url, path }],
    artifacts: [{ path, source: url }],
    publication_evidence: { status: 'published', relationship: url, entry_paths: [path] },
    failure: { terminal: { phase: 'runtime', message: `failed at ${url} ${path}` } },
    errors: [`failed at ${url} ${path}`],
  });
  assert.equal(normalized.result, url);
  assert.deepEqual(normalized.evidence, [path, { output: url, path }]);
  assert.deepEqual(normalized.artifacts, [{ path, source: url }]);
  assert.deepEqual(normalized.publication_evidence, { status: 'published', relationship: url, entry_paths: [path] });
  assert.doesNotMatch(JSON.stringify(normalized.failure), /example\.invalid|\/workspace\/output/);
  assert.doesNotMatch(JSON.stringify(normalized.errors), /example\.invalid|\/workspace\/output/);
});

test('v2 normalization is closed, bounded, and sanitizes hostile nested fields', () => {
  const hostile = normalizeReceipt({ version: 2, run_id: 'r', status: 'failed', effect_state: 'none', unknown: 'marker', result: 'https://secret.invalid/token', evidence: [{ marker: 'secret', nested: { leak: true } }], artifacts: [{ path: '/srv/private/token' }], publication_evidence: { status: 'published', relationship: 'https://secret.invalid', marker: 'leak', created_entry_count: '1' }, failure: { version: 1, terminal: { phase: 'runtime', message: 'https://secret.invalid/token', marker: 'leak' }, recovered: [{ phase: 'tool', message: '\u202ehidden' }], marker: 'leak' }, errors: ['https://secret.invalid/token'], cleanup_unknown: 'leak' });
  assert.equal(hostile.unknown, undefined);
  assert.equal(hostile.cleanup_unknown, undefined);
  assert.equal(hostile.result, 'https://secret.invalid/token');
  assert.equal(hostile.artifacts[0].path, '/srv/private/token');
  assert.equal(hostile.publication_evidence.relationship, 'https://secret.invalid');
  assert.doesNotMatch(JSON.stringify(hostile.failure), /secret\.invalid|marker|\u202e|\/srv\/private/);
  assert.doesNotMatch(JSON.stringify(hostile.errors), /secret\.invalid|marker|\u202e|\/srv\/private/);
  assert.equal(hostile.evidence[0].marker, undefined);
  assert.ok(hostile.errors.length <= 64);
  assert.ok(Object.keys(hostile.failure).every(key => ['version', 'terminal', 'recovered'].includes(key)));
});

test('failure structural fields reject hostile ordinary-looking strings while preserving canonical fields', () => {
  const hostile = 'https://failure.invalid/private/TOKEN_FAILURE';
  const normalized = normalizeReceipt({
    version: 2,
    status: 'failed',
    failure: {
      terminal: { phase: hostile, signal: hostile, call_id: hostile, termination: { classification: hostile }, message: 'failed' },
      recovered: [{ phase: '/srv/private/failure-token', signal: hostile, call_id: hostile, termination: { classification: hostile }, message: 'recovered' }],
    },
  });
  const rendered = JSON.stringify(normalized);
  assert.doesNotMatch(rendered, /failure\.invalid|TOKEN_FAILURE|\/srv\/private/);
  assert.deepEqual(normalized.failure.terminal, { message: 'failed' });
  assert.deepEqual(normalized.failure.recovered, [{ message: 'recovered' }]);

  const valid = normalizeReceipt({
    version: 2,
    status: 'failed',
    failure: {
      terminal: { phase: 'tool', signal: 'SIGFPE', code: 136, termination: { code: 136, signal: 'SIGFPE', classification: 'signal' }, message: 'failed' },
      recovered: [{ phase: 'tool', call_id: 'call-1', code: 137, termination: { code: 137, classification: 'sigkill_compatible' }, message: 'killed' }],
    },
  });
  assert.deepEqual(valid.failure.terminal, { phase: 'tool', code: 136, signal: 'SIGFPE', message: 'failed', termination: { code: 136, signal: 'SIGFPE', classification: 'signal' } });
  assert.deepEqual(valid.failure.recovered, [{ phase: 'tool', call_id: 'call-1', code: 137, message: 'killed', termination: { code: 137, classification: 'sigkill_compatible' } }]);
});
