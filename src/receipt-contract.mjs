const MAX_SUMMARY = 256;
const MAX_CAUSE = 64;
const SIGNALS = new Set(['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGSTOP', 'SIGTERM', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGUSR1', 'SIGUSR2', 'SIGWINCH']);
const STATUSES = new Set(['running', 'completed', 'failed', 'interrupted', 'deadline', 'step_limit', 'cleanup_unknown', 'publication_incomplete', 'receipt_conflict']);
const EFFECTS = new Set(['none', 'uncertain', 'unknown']);

function read(value, key) { try { return value?.[key]; } catch { return undefined; } }
function safeArray(value, fallback = []) { return Array.isArray(value) ? value : fallback; }
function scalarString(value, max = MAX_CAUSE) { return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined; }

export function safeFailureSummary(value, fallback = 'operation failed') {
  let text;
  try { text = String(value ?? ''); } catch { return fallback; }
  const dangerous = text.length > MAX_SUMMARY || /[\u0000-\u001f\u007f\u0080-\u009f\u202a-\u202e\u2066-\u2069]/u.test(text) || /(?:https?:\/\/|www\.|\b(?:bearer|token|authorization|api[_ -]?key|secret|password)\b|(?:^|[\s(])[A-Za-z]:[\\/]|(?:^|[\s(])\/(?:[^\s/]+\/)+|\b(?:localhost|127\.0\.0\.1|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\b)/iu.test(text);
  if (dangerous || !text.trim()) {
    const prefix = text.split(':', 1)[0].trim();
    const pathLike = /(?:https?:\/\/|www\.|(?:^|[\s(])[A-Za-z]:[\\/]|(?:^|[\s(])\/(?:[^\s/]+\/)+|\b(?:localhost|127\.0\.0\.1|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\b)/iu.test(text);
    return pathLike && prefix && /^[A-Za-z][A-Za-z0-9 ()_-]{1,120}$/.test(prefix) ? prefix : fallback;
  }
  return text.trim();
}

export function classifyProviderCause(cause) {
  if (!cause || (typeof cause !== 'object' && typeof cause !== 'function')) return { classification: 'unavailable' };
  try {
    const code = read(cause, 'code');
    const syscall = read(cause, 'syscall');
    const errno = read(cause, 'errno');
    const result = {};
    if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) result.code = code;
    if (typeof syscall === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(syscall)) result.syscall = syscall;
    if (Number.isInteger(errno) && errno >= -2147483648 && errno <= 2147483647) result.errno = errno;
    return Object.keys(result).length ? result : { classification: 'unavailable' };
  } catch { return { classification: 'unavailable' }; }
}

export function normalizeReceipt(input, { status = 'cleanup_unknown', error = null } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const version = read(source, 'version');
  const sourceStatus = read(source, 'status');
  const normalizedStatus = STATUSES.has(sourceStatus) ? sourceStatus : status;
  const base = {
    version: 2,
    run_id: typeof read(source, 'run_id') === 'string' ? read(source, 'run_id') : null,
    status: normalizedStatus,
    effect_state: EFFECTS.has(read(source, 'effect_state')) ? read(source, 'effect_state') : 'uncertain',
    result: read(source, 'result') ?? null,
    evidence: safeArray(read(source, 'evidence')),
    artifacts: safeArray(read(source, 'artifacts')),
    publication_evidence: read(source, 'publication_evidence') && typeof read(source, 'publication_evidence') === 'object' ? read(source, 'publication_evidence') : { status: 'unknown', relationship: 'publication was not independently enumerated' },
    errors: safeArray(read(source, 'errors')).map(value => safeFailureSummary(value, 'operation failed')),
    failure: read(source, 'failure') && typeof read(source, 'failure') === 'object' ? read(source, 'failure') : { version: 1, terminal: null, recovered: [] },
  };
  if (Array.isArray(read(source, 'cleanup_history'))) base.cleanup_history = read(source, 'cleanup_history');
  for (const key of ['created_entries', 'created_entry_paths', 'publication_result', 'exporter_exit']) {
    const value = read(source, key);
    if (value !== undefined) base[key] = value;
  }
  if (version === 2) {
    for (const key of ['cleanup_history', 'execution_deadline', 'cleanup_deadline', 'cleanup_grace_ms']) {
      const value = read(source, key);
      if (value !== undefined) base[key] = value;
    }
    if (error) base.errors.push(safeFailureSummary(error, 'cleanup could not be proven'));
    return { ...source, ...base, version: 2 };
  }
  if (version === 1 || version === undefined) {
    const message = safeFailureSummary(error ?? read(source, 'errors')?.[0], normalizedStatus === 'interrupted' ? 'run interrupted' : 'cleanup could not be proven');
    const failure = base.failure?.terminal || normalizedStatus === 'completed' ? base.failure : { version: 1, terminal: { phase: 'recovery', message }, recovered: [] };
    return { ...base, failure };
  }
  return { ...base, errors: [...base.errors, 'unsupported receipt version'] };
}

export function hasReceiptShape(value) {
  const version = read(value, 'version');
  return version === 1 || version === 2;
}

export function classifyTermination(code, signal = null) {
  if (signal !== null && (!SIGNALS.has(signal) || code !== null && code !== 128 + signalNumber(signal))) return null;
  if (signal === 'SIGKILL' || code === 137) return { ...(code !== null ? { code } : {}), ...(signal ? { signal } : {}), classification: 'sigkill_compatible' };
  if (code === 124) return { code, classification: 'timeout_or_output_limit' };
  if (signal) return { signal, classification: 'signal' };
  return null;
}
function signalNumber(signal) { return { SIGABRT: 6, SIGALRM: 14, SIGBUS: 7, SIGFPE: 8, SIGHUP: 1, SIGILL: 4, SIGINT: 2, SIGKILL: 9, SIGPIPE: 13, SIGQUIT: 3, SIGSEGV: 11, SIGTERM: 15 }[signal] ?? -1; }
