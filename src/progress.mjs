import { Buffer } from 'node:buffer';

export const PROGRESS_PROTOCOL_VERSION = 1;
export const PROGRESS_MAGIC = 'YVP1 ';
export const PROGRESS_LIMITS = Object.freeze({ maxFrameBytes: 4096, maxEvents: 1024, maxWireBytes: 262144, maxTextBytes: 2048, maxQueueBytes: 65536 });
const DROP_RESERVE_BYTES = 512;
const TRUNCATION_SUFFIX = '... [truncated]';

const tools = new Set(['exec', 'skill_load']);
const outcomes = new Set(['ok', 'error', 'deadline']);
const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const magic = Buffer.from(PROGRESS_MAGIC);
const int = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every((key, index) => Object.keys(value)[index] === key);

function canonicalEvent(event) {
  if (!event || typeof event !== 'object' || event.v !== 1 || !int(event.seq, 1, PROGRESS_LIMITS.maxEvents) || typeof event.type !== 'string') throw new TypeError('invalid progress event');
  if (event.type === 'assistant_delta') {
    if (!exactKeys(event, ['v', 'seq', 'type', 'text']) || typeof event.text !== 'string' || Buffer.byteLength(event.text) > PROGRESS_LIMITS.maxTextBytes) throw new TypeError('invalid assistant delta');
    return { v: 1, seq: event.seq, type: 'assistant_delta', text: event.text };
  }
  if (event.type === 'tool_start') {
    if (!exactKeys(event, ['v', 'seq', 'type', 'tool', 'ordinal']) || !tools.has(event.tool) || !int(event.ordinal, 1, 100)) throw new TypeError('invalid tool start');
    return { v: 1, seq: event.seq, type: 'tool_start', tool: event.tool, ordinal: event.ordinal };
  }
  if (event.type === 'tool_finish') {
    if (!exactKeys(event, ['v', 'seq', 'type', 'tool', 'ordinal', 'outcome', 'code', 'output_bytes', 'error_bytes', 'limited']) || !tools.has(event.tool) || !int(event.ordinal, 1, 100) || !outcomes.has(event.outcome) || (event.tool === 'skill_load' ? event.code !== null : !int(event.code, 0, 255)) || !int(event.output_bytes, 0, 1048576) || !int(event.error_bytes, 0, 1048576) || typeof event.limited !== 'boolean') throw new TypeError('invalid tool finish');
    return { v: 1, seq: event.seq, type: 'tool_finish', tool: event.tool, ordinal: event.ordinal, outcome: event.outcome, code: event.code, output_bytes: event.output_bytes, error_bytes: event.error_bytes, limited: event.limited };
  }
  if (event.type === 'lifecycle') {
    if (event.phase === 'runtime_started') {
      if (!exactKeys(event, ['v', 'seq', 'type', 'phase'])) throw new TypeError('invalid lifecycle');
      return { v: 1, seq: event.seq, type: 'lifecycle', phase: event.phase };
    }
    if (event.phase === 'deadline_near') {
      if (!exactKeys(event, ['v', 'seq', 'type', 'phase', 'remaining_ms']) || !int(event.remaining_ms, 0, 86400000) || event.remaining_ms % 1000 !== 0) throw new TypeError('invalid deadline');
      return { v: 1, seq: event.seq, type: 'lifecycle', phase: 'deadline_near', remaining_ms: event.remaining_ms };
    }
    throw new TypeError('invalid lifecycle phase');
  }
  if (event.type === 'drop') {
    if (!exactKeys(event, ['v', 'seq', 'type', 'count', 'reason']) || !int(event.count, 1, 1048576) || !['backpressure', 'budget'].includes(event.reason)) throw new TypeError('invalid drop');
    return { v: 1, seq: event.seq, type: 'drop', count: event.count, reason: event.reason };
  }
  throw new TypeError('unknown progress event');
}

function semanticFrame(event, seq) {
  if (!event || typeof event !== 'object') throw new TypeError('invalid progress event');
  switch (event.type) {
    case 'assistant_delta': return encodeProgressFrame({ v: 1, seq, type: 'assistant_delta', text: event.text });
    case 'tool_start': return encodeProgressFrame({ v: 1, seq, type: 'tool_start', tool: event.tool, ordinal: event.ordinal });
    case 'tool_finish': return encodeProgressFrame({ v: 1, seq, type: 'tool_finish', tool: event.tool, ordinal: event.ordinal, outcome: event.outcome, code: event.code, output_bytes: event.output_bytes, error_bytes: event.error_bytes, limited: event.limited });
    case 'lifecycle':
      if (event.phase === 'deadline_near') return encodeProgressFrame({ v: 1, seq, type: 'lifecycle', phase: event.phase, remaining_ms: event.remaining_ms });
      return encodeProgressFrame({ v: 1, seq, type: 'lifecycle', phase: event.phase });
    case 'drop': return encodeProgressFrame({ v: 1, seq, type: 'drop', count: event.count, reason: event.reason });
    default: throw new TypeError('unknown progress event');
  }
}

export function encodeProgressFrame(event) {
  const canonical = canonicalEvent(event);
  const bytes = Buffer.from(`${PROGRESS_MAGIC}${JSON.stringify(canonical)}\n`);
  if (bytes.byteLength > PROGRESS_LIMITS.maxFrameBytes) throw new RangeError('progress frame too large');
  return bytes;
}

export class ProgressFrameDecoder {
  constructor(onEvent, { onFault } = {}) {
    this.onEvent = onEvent; this.onFault = onFault; this.seq = 0; this.events = 0; this.total = 0; this.state = 'SEEK_START'; this.tools = new Map(); this.stoppingStatus = null;
    this.mode = 'prefix'; this.prefix = []; this.candidate = [];
  }
  fault() { if (this.state !== 'FAULT') { this.state = 'FAULT'; try { this.onFault?.('[yolo progress unavailable: invalid or over-limit progress stream]'); } catch {} } }
  resetLine() { this.mode = 'prefix'; this.prefix = []; this.candidate = []; }
  push(chunk) {
    if (this.state === 'FAULT') return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (const byte of bytes) {
      if (this.state === 'FAULT') return;
      if (this.mode === 'skip') { if (byte === 10) this.resetLine(); continue; }
      if (this.mode === 'prefix') {
        if (byte === 10) { this.resetLine(); continue; }
        const index = this.prefix.length;
        if (byte !== magic[index]) { this.mode = 'skip'; this.prefix = []; continue; }
        this.prefix.push(byte);
        if (this.prefix.length === magic.length) {

          this.mode = 'candidate'; this.candidate = [...this.prefix]; this.total += magic.length;
          if (this.total > PROGRESS_LIMITS.maxWireBytes) return this.fault();
        }
        continue;
      }
      this.total += 1;
      if (this.total > PROGRESS_LIMITS.maxWireBytes) return this.fault();
      if (byte === 10) {
        const line = Buffer.from(this.candidate);
        this.resetLine();
        this.consume(line);
        continue;
      }
      this.candidate.push(byte);
      if (this.candidate.length + 1 > PROGRESS_LIMITS.maxFrameBytes) return this.fault();
    }
  }
  consume(line) {
    let event;
    try {
      const payload = line.subarray(PROGRESS_MAGIC.length);
      const text = utf8.decode(payload);
      event = canonicalEvent(JSON.parse(text));
      if (JSON.stringify(event) !== text) throw new Error('noncanonical');
    } catch { return this.fault(); }
    if (event.seq !== this.seq + 1 || this.events >= PROGRESS_LIMITS.maxEvents) return this.fault();
    if (this.events === 0 && !(event.type === 'lifecycle' && event.phase === 'runtime_started' && event.seq === 1)) return this.fault();
    if (event.type === 'lifecycle' && event.phase === 'runtime_started' && this.events > 0) return this.fault();
    if (event.type === 'tool_start') {
      const key = `${event.tool}:${event.ordinal}`;
      if (this.tools.has(key)) return this.fault();
      this.tools.set(key, true);
    }
    if (event.type === 'tool_finish') {
      const key = `${event.tool}:${event.ordinal}`;
      if (!this.tools.has(key)) return this.fault();
      this.tools.delete(key);
    }

    this.seq = event.seq; this.events += 1;
    try { this.onEvent?.(event); } catch {}
  }
  end() { if (this.mode === 'candidate' && this.candidate.length) this.fault(); }
}

export function sanitizeTerminalText(value) {
  let out = '';
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xD800 && cp <= 0xDFFF) out += '\uFFFD';
    else if (ch === '\n') out += '\n';
    else if (ch === '\t') out += '    ';
    else if (ch === '\r') out += '\\r';
    else if (cp === 0x2028 || cp === 0x2029 || cp <= 0x1F || cp === 0x7F || (cp >= 0x80 && cp <= 0x9F) || /\p{Cf}/u.test(ch)) out += `\\u{${cp.toString(16).toUpperCase()}}`;
    else out += ch;
  }
  return out;
}

function truncateLogicalLine(text) {
  const clean = sanitizeTerminalText(text);
  if (Buffer.byteLength(clean) <= PROGRESS_LIMITS.maxTextBytes) return clean;
  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX);
  let out = '';
  let bytes = 0;
  for (const scalar of clean) {
    const length = Buffer.byteLength(scalar);
    if (bytes + length > PROGRESS_LIMITS.maxTextBytes - suffixBytes) break;
    out += scalar; bytes += length;
  }
  return `${out}${TRUNCATION_SUFFIX}`;
}

export function renderProgressEvent(event) {
  if (event.type === 'diagnostic') return `${truncateLogicalLine('[yolo progress unavailable: invalid or over-limit progress stream]')}\n`;
  if (event.type === 'assistant_delta') return `${truncateLogicalLine(`[yolo assistant] ${event.text}`)}\n`;
  if (event.type === 'tool_start') return `${truncateLogicalLine(`[yolo tool ${event.ordinal}] ${event.tool} started (arguments hidden)`)}\n`;
  if (event.type === 'tool_finish') return `${truncateLogicalLine(`[yolo tool ${event.ordinal}] ${event.tool} finished ${event.outcome}; output=${event.output_bytes} B error=${event.error_bytes} B (content omitted)`)}\n`;
  if (event.type === 'lifecycle') {
    if (event.phase === 'runtime_started') return '[yolo runtime] agent started\n';
    if (event.phase === 'deadline_near') return `[yolo runtime] deadline near (${event.remaining_ms} ms remain)\n`;
    return '';
  }
  if (event.type === 'drop') return `[yolo progress] ${event.count} events omitted (${event.reason})\n`;
  return '';
}

export function createProgressRenderer({ write, stream } = {}) {
  const target = stream ?? (typeof write === 'object' ? write : process.stderr);
  const output = write ?? (value => target.write(value));
  let suppressed = false; let omitted = 0; let assistant = '';
  const offer = value => {
    if (!value) return true;
    if (suppressed) { omitted += 1; return false; }
    try { if (output(value) === false) { suppressed = true; return false; } return true; }
    catch { suppressed = true; return false; }
  };
  const flushAssistant = () => {
    if (!assistant) return;
    const rendered = `${truncateLogicalLine(`[yolo assistant] ${assistant}`)}\n`;
    assistant = '';
    offer(rendered);
  };
  const resume = () => {
    if (!suppressed) return;
    const count = omitted;
    suppressed = false; omitted = 0; assistant = '';
    try {
      if (output(`[yolo progress: ${count} messages omitted due to terminal backpressure]\n`) === false) suppressed = true;
    } catch { suppressed = true; }
  };
  target?.on?.('drain', resume);
  const render = event => {
    if (suppressed) { omitted += 1; return; }
    if (event.type === 'assistant_delta') {
      const clean = sanitizeTerminalText(event.text);
      const pieces = clean.split('\n');
      for (let index = 0; index < pieces.length; index += 1) {
        assistant += pieces[index];
        if (index < pieces.length - 1) flushAssistant();
      }
      return;
    }
    flushAssistant();
    offer(renderProgressEvent(event));
  };
  render.close = flushAssistant;
  return render;
}

export class ProgressWriter {
  constructor(stream = process.stderr) {
    this.stream = stream; this.seq = 0; this.closed = false; this.queue = []; this.queuedBytes = 0; this.wireBytes = 0; this.dropped = 0; this.blocked = false; this.budgetClosed = false; this.dropUntilDrain = false;
    this.stream.on?.('drain', () => this.flush());
  }
  emit(event) {
    if (this.closed || this.budgetClosed || this.seq >= PROGRESS_LIMITS.maxEvents) return false;
    let estimate;
    try { estimate = semanticFrame(event, Math.min(PROGRESS_LIMITS.maxEvents, this.seq + this.queue.length + 1)); } catch { return false; }
    if (this.blocked) {
      if (this.dropUntilDrain || this.queuedBytes + estimate.length > PROGRESS_LIMITS.maxQueueBytes - DROP_RESERVE_BYTES) { this.dropped += 1; this.dropUntilDrain = true; return false; }
      this.queue.push({ event, bytes: estimate.length }); this.queuedBytes += estimate.length; return false;
    }
    return this.writeEvent(event);
  }
  writeEvent(event) {
    if (this.seq >= PROGRESS_LIMITS.maxEvents) return false;
    let frame;
    try { frame = semanticFrame(event, this.seq + 1); } catch { return false; }
    if (this.wireBytes + frame.length > PROGRESS_LIMITS.maxWireBytes - DROP_RESERVE_BYTES) {
      this.dropped += 1; this.budgetClosed = true; this.writeDrop('budget'); return false;
    }
    this.seq += 1; this.wireBytes += frame.length;
    try { const ok = this.stream.write(frame); if (!ok) this.blocked = true; return ok; }
    catch { this.blocked = true; return false; }
  }
  writeDrop(reason) {
    if (!this.dropped || this.closed || this.seq >= PROGRESS_LIMITS.maxEvents) return;
    const count = Math.min(this.dropped, 1048576);
    let marker;
    try { marker = semanticFrame({ type: 'drop', count, reason }, this.seq + 1); } catch { return; }
    if (this.wireBytes + marker.length > PROGRESS_LIMITS.maxWireBytes) return;
    this.dropped = 0; this.seq += 1; this.wireBytes += marker.length;
    try { if (!this.stream.write(marker)) this.blocked = true; } catch { this.blocked = true; }
  }
  flush() {
    if (this.closed) return;
    this.blocked = false;
    while (!this.blocked && this.queue.length) {
      const item = this.queue.shift(); this.queuedBytes -= item.bytes; this.writeEvent(item.event);
    }
    if (!this.blocked && !this.queue.length) { this.writeDrop('backpressure'); this.dropUntilDrain = false; }
  }
  close() { this.closed = true; this.queue.length = 0; this.queuedBytes = 0; }
}