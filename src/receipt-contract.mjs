const MAX_SUMMARY = 256;
const MAX_ITEMS = 64;
const MAX_KEYS = 16;
export const SIGNAL_NUMBERS = Object.freeze({ SIGABRT: 6, SIGALRM: 14, SIGBUS: 7, SIGCHLD: 17, SIGCONT: 18, SIGFPE: 8, SIGHUP: 1, SIGILL: 4, SIGINT: 2, SIGKILL: 9, SIGPIPE: 13, SIGQUIT: 3, SIGSEGV: 11, SIGSTOP: 19, SIGTERM: 15, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGUSR1: 10, SIGUSR2: 12, SIGWINCH: 28 });
export const SIGNALS = new Set(Object.keys(SIGNAL_NUMBERS));
const STATUSES = new Set(['running', 'completed', 'failed', 'interrupted', 'deadline', 'step_limit', 'cleanup_unknown', 'publication_incomplete', 'receipt_conflict']);
const EFFECTS = new Set(['none', 'uncertain', 'unknown']);
const OUTER_KEYS = new Set(['version', 'run_id', 'status', 'effect_state', 'result', 'evidence', 'artifacts', 'publication_evidence', 'errors', 'failure', 'cleanup_history', 'execution_deadline', 'cleanup_deadline', 'cleanup_grace_ms', 'created_entries', 'created_entry_paths', 'publication_result', 'exporter_exit']);
const FAILURE_KEYS = new Set(['version', 'terminal', 'recovered']);
const TERMINAL_KEYS = new Set(['phase', 'message', 'code', 'signal', 'cause', 'termination']);
const RECOVERED_KEYS = new Set(['phase', 'call_id', 'code', 'message', 'termination']);
const PUBLICATION_KEYS = new Set(['status', 'relationship', 'created_entry_count', 'created_entries', 'entry_paths', 'exporter_exit']);
const VALUE_KEYS = new Set(['name', 'source', 'instructions', 'resource', 'content', 'command', 'args', 'call_id', 'code', 'phase', 'message', 'signal', 'classification', 'output', 'error', 'path', 'status', 'relationship', 'created_entry_count', 'entry_paths', 'created_entries', 'exporter_exit', 'version', 'ok', 'termination', 'action', 'bytes', 'at', 'operation']);
const FAILURE_PHASES = new Set(['runtime', 'provider', 'tool', 'recovery']);
const TERMINATION_CLASSES = new Set(['signal', 'sigkill_compatible', 'timeout_or_output_limit']);
function read(value, key) { try { return value?.[key]; } catch { return undefined; } }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function boundedString(value, fallback = 'operation failed') { return typeof value === 'string' ? safeFailureSummary(value, fallback) : fallback; }
export function safeFailureSummary(value, fallback = 'operation failed') {
  let text; try { text = String(value ?? ''); } catch { return fallback; }
  const dangerous = text.length > MAX_SUMMARY || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(text) || /(?:https?:\/\/|www\.|\b(?:bearer|token|authorization|api[_ -]?key|secret|password)\b|(?:^|[\s(])[A-Za-z]:[\\/]|(?:^|[\s(])\/(?:[^\s/]+\/)+|\b(?:localhost|127\.0\.0\.1|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\b)/iu.test(text);
  if (dangerous || !text.trim()) { const prefix = text.split(':', 1)[0].trim(); return /^[A-Za-z][A-Za-z0-9 ()_-]{1,120}$/.test(prefix) && !/(?:https?|bearer|token|secret|password)/i.test(prefix) ? prefix : fallback; }
  return text.trim();
}
function ordinaryString(value) { return typeof value === 'string' && value.length <= MAX_SUMMARY && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) ? value : undefined; }
function cleanValue(value, key, depth = 0) {
  if (typeof value === 'string') return key === 'message' || key === 'error' ? boundedString(value) : ordinaryString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth > 2) return undefined;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(item => cleanValue(item, key, depth + 1)).filter(item => item !== undefined);
  const source = object(value); if (!source) return undefined;
  const out = {};
  for (const [name, item] of Object.entries(source).slice(0, MAX_KEYS)) if (VALUE_KEYS.has(name)) { const cleaned = cleanValue(item, name, depth + 1); if (cleaned !== undefined) out[name] = cleaned; }
  return out;
}
function cleanRecord(value, keys) { const source = object(value); if (!source) return null; const out = {}; for (const key of keys) if (Object.hasOwn(source, key)) { const cleaned = cleanValue(source[key], key); if (cleaned !== undefined) out[key] = cleaned; } return out; }
function validCallId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !/(?:https?|www|token|secret|bearer|password|api[_-]?key)/i.test(value) ? value : undefined; }
function validCode(value) { return Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined; }
function validSignal(value, code) { return typeof value === 'string' && SIGNALS.has(value) && (code === undefined || code === 128 + SIGNAL_NUMBERS[value]) ? value : undefined; }
function cleanTermination(value, code, signal) {
  const source = object(value); if (!source || typeof source.classification !== 'string' || !TERMINATION_CLASSES.has(source.classification)) return undefined;
  const terminationCode = validCode(source.code); const terminationSignal = validSignal(source.signal, code ?? terminationCode);
  const effectiveCode = code ?? terminationCode; const effectiveSignal = signal ?? terminationSignal;
  const canonical = classifyTermination(effectiveCode ?? null, effectiveSignal ?? null);
  if (!canonical || canonical.classification !== source.classification || terminationCode !== undefined && terminationCode !== effectiveCode || terminationSignal !== undefined && terminationSignal !== effectiveSignal) return undefined;
  return { ...(terminationCode === undefined ? {} : { code: terminationCode }), ...(terminationSignal === undefined ? {} : { signal: terminationSignal }), classification: canonical.classification };
}
function cleanFailureRecord(value, recovered) {
  const source = object(value); if (!source) return null; const out = {};
  if (FAILURE_PHASES.has(source.phase)) out.phase = source.phase;
  const code = validCode(source.code); if (code !== undefined) out.code = code;
  const signal = validSignal(source.signal, code); if (signal !== undefined) out.signal = signal;
  if (recovered) { const callId = validCallId(source.call_id); if (callId !== undefined) out.call_id = callId; }
  if (Object.hasOwn(source, 'message')) { const message = boundedString(source.message); if (message) out.message = message; }
  const termination = cleanTermination(source.termination, code, signal); if (termination) out.termination = termination;
  return out;
}
function cleanFailure(value) { const source = object(value); if (!source) return { version: 1, terminal: null, recovered: [] }; return { version: 1, terminal: cleanFailureRecord(source.terminal, false), recovered: Array.isArray(source.recovered) ? source.recovered.slice(0, MAX_ITEMS).map(item => cleanFailureRecord(item, true)).filter(Boolean) : [] }; }
function cleanPublication(value) { const out = cleanRecord(value, PUBLICATION_KEYS); return out ?? { status: 'unknown', relationship: 'publication was not independently enumerated' }; }
function cleanList(value) { return Array.isArray(value) ? value.slice(0, MAX_ITEMS).map(item => cleanValue(item, 'value')).filter(item => item !== undefined) : []; }
export function classifyProviderCause(cause) { if (!cause || (typeof cause !== 'object' && typeof cause !== 'function')) return { classification: 'unavailable' }; try { const result = {}; const code = read(cause, 'code'); const syscall = read(cause, 'syscall'); const errno = read(cause, 'errno'); if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) result.code = code; if (typeof syscall === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(syscall)) result.syscall = syscall; if (Number.isInteger(errno) && errno >= -2147483648 && errno <= 2147483647) result.errno = errno; return Object.keys(result).length ? result : { classification: 'unavailable' }; } catch { return { classification: 'unavailable' }; } }
export function normalizeReceipt(input, { status = 'cleanup_unknown', error = null } = {}) {
  const source = object(input) ?? {}; const version = read(source, 'version'); const sourceStatus = read(source, 'status'); const normalizedStatus = STATUSES.has(sourceStatus) ? sourceStatus : status;
  const base = { version: 2, run_id: typeof read(source, 'run_id') === 'string' ? boundedString(read(source, 'run_id'), 'run') : null, status: normalizedStatus, effect_state: EFFECTS.has(read(source, 'effect_state')) ? read(source, 'effect_state') : 'uncertain', result: cleanValue(read(source, 'result'), 'result') ?? null, evidence: cleanList(read(source, 'evidence')), artifacts: cleanList(read(source, 'artifacts')), publication_evidence: cleanPublication(read(source, 'publication_evidence')), errors: cleanList(read(source, 'errors')).map(value => boundedString(value)), failure: cleanFailure(read(source, 'failure')) };
  for (const key of ['cleanup_history', 'created_entries', 'created_entry_paths', 'publication_result', 'exporter_exit', 'execution_deadline', 'cleanup_deadline', 'cleanup_grace_ms']) if (Object.hasOwn(source, key)) { const cleaned = cleanValue(source[key], key); if (cleaned !== undefined) base[key] = cleaned; }
  if (error) base.errors.push(safeFailureSummary(error, 'cleanup could not be proven'));
  if ((version === 1 || version === undefined) && !base.failure.terminal && normalizedStatus !== 'completed') base.failure.terminal = { phase: 'recovery', message: safeFailureSummary(read(source, 'errors')?.[0] ?? error, normalizedStatus === 'interrupted' ? 'run interrupted' : 'cleanup could not be proven') };
  if (version !== undefined && version !== 1 && version !== 2) base.errors.push('unsupported receipt version');
  return Object.fromEntries(Object.entries(base).filter(([key]) => OUTER_KEYS.has(key)));
}
export function hasReceiptShape(value) { const version = read(value, 'version'); return version === 1 || version === 2; }
export function classifyTermination(code, signal = null) { if (signal !== null && (!SIGNALS.has(signal) || code !== null && code !== 128 + SIGNAL_NUMBERS[signal])) return null; if (signal === 'SIGKILL' || code === 137) return { ...(code !== null ? { code } : {}), ...(signal ? { signal } : {}), classification: 'sigkill_compatible' }; if (code === 124) return { code, classification: 'timeout_or_output_limit' }; if (signal) return { signal, classification: 'signal' }; return null; }
