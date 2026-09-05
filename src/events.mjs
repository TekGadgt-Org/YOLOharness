import { appendFile, mkdir, readFile, stat, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const SECRET = /token|secret|password|authorization|credential|api[_-]?key/i;
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET.test(key) ? '[REDACTED]' : redact(item)]));
}

export function receiptPayload(payload) {
  const safe = redact(payload);
  for (const key of ['prompt', 'result', 'output', 'message']) {
    if (typeof safe[key] === 'string' && safe[key].length > 256) safe[key] = `[sha256:${createHash('sha256').update(safe[key]).digest('hex')}]`;
  }
  return safe;
}

export class EventLog {
  constructor(path, { maxBytes = 64 * 1024 } = {}) { this.path = path; this.maxBytes = maxBytes; this.nextSeq = new Map(); this.queue = Promise.resolve(); }
  async append(runId, type, payload = {}) {
    if (!runId || !type) throw new TypeError('runId and type are required');
    return this.queue = this.queue.then(async () => {
      const text = await readFile(this.path, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
      let seq = this.nextSeq.get(runId);
      if (seq === undefined) seq = text.split('\n').filter(Boolean).reduce((n, line) => { const e = JSON.parse(line); return e.run_id === runId ? Math.max(n, e.seq) : n; }, 0);
      const event = { version: 1, run_id: runId, seq: seq + 1, type, payload: receiptPayload(payload), at: new Date().toISOString() };
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(text) + Buffer.byteLength(line) > this.maxBytes) throw new Error('event log byte limit exceeded');
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 });
      await chmod(this.path, 0o600).catch(() => {});
      this.nextSeq.set(runId, event.seq);
      return event;
    });
  }
}

export async function recoverEvents(path, runId) {
  const text = await readFile(path, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
  return text.split('\n').filter(Boolean).map(JSON.parse).filter(event => event.run_id === runId);
}
