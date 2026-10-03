import { constants as fsConstants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';

export const PROTOCOL_VERSION = 2;
const MAGIC = Buffer.from('YHP2');
const HEADER_BYTES = 24;
const TYPE_END = 0;
const TYPE_DIRECTORY = 1;
const TYPE_FILE = 2;
const TYPE_NAMES = new Map([[TYPE_DIRECTORY, 'directory'], [TYPE_FILE, 'file']]);
export const LIMITS = Object.freeze({
  maxRecord: 128 * 1024 * 1024,
  maxPath: 4096,
  maxEntries: 100_000,
  maxBytes: 4 * 1024 * 1024 * 1024,
});
const DEFAULT_EXCLUSIONS = new Set(['.yolo', 'node_modules', '.venv', 'vendor', '.godot', 'target']);

function exclusions(names = []) {
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\'))) {
    throw new TypeError('invalid dependency directory names');
  }
  return new Set([...DEFAULT_EXCLUSIONS, ...names]);
}

function validatePath(path, encodedLength = Buffer.byteLength(path ?? '', 'utf8')) {
  if (typeof path !== 'string' || encodedLength < 1 || encodedLength > LIMITS.maxPath || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe publication path: ${path}`);
  }
}

function recordType(type) {
  if (type === 'directory') return TYPE_DIRECTORY;
  if (type === 'file') return TYPE_FILE;
  throw new Error(`unsupported record type: ${type}`);
}

export function encodeEnd() {
  return Buffer.alloc(HEADER_BYTES);
}

export function encodeRecordHeader(meta, size = 0) {
  const type = recordType(meta?.type);
  const pathBytes = Buffer.from(meta.path ?? '', 'utf8');
  validatePath(meta?.path, pathBytes.length);
  const mode = meta.mode ?? (type === TYPE_DIRECTORY ? 0o755 : 0o644);
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('record mode exceeds protocol limit');
  if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.maxRecord || (type === TYPE_DIRECTORY && size !== 0)) throw new Error('record exceeds protocol limit');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt16BE(mode, 2);
  header.writeUInt32BE(pathBytes.length, 4);
  header.writeBigUInt64BE(BigInt(size), 8);
  return Buffer.concat([header, pathBytes]);
}

export function encodeExport(records) {
  const chunks = [MAGIC];
  let entries = 0;
  let total = 0;
  for (const record of records) {
    const payload = record.data === undefined ? Buffer.alloc(0) : Buffer.from(record.data);
    const size = record.type === 'file' ? (record.size ?? payload.length) : 0;
    if (record.type === 'file' && size !== payload.length) throw new Error('inconsistent file size');
    if (++entries > LIMITS.maxEntries || (total += size) > LIMITS.maxBytes) throw new Error('export exceeds resource limit');
    chunks.push(encodeRecordHeader(record, size));
    if (record.type === 'file') chunks.push(payload);
  }
  chunks.push(encodeEnd());
  return Buffer.concat(chunks);
}

function checkOptions({ signal, deadline } = {}) {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('export aborted'), { code: 'aborted' });
  if (Number.isFinite(deadline) && Date.now() >= deadline) throw Object.assign(new Error('export deadline exceeded'), { code: 'deadline' });
}

class ByteReader {
  constructor(stream, options) {
    this.iterator = stream?.[Symbol.asyncIterator]?.();
    if (!this.iterator) throw new TypeError('workspace exporter did not provide framed stdout');
    this.options = options;
    this.buffer = Buffer.alloc(0);
    this.done = false;
  }

  async nextChunk() {
    while (true) {
      checkOptions(this.options);
      let abortListener;
      let deadlineTimer;
      const abort = this.options.signal && new Promise((_, reject) => {
        abortListener = () => reject(this.options.signal.reason ?? Object.assign(new Error('export aborted'), { code: 'aborted' }));
        this.options.signal.addEventListener('abort', abortListener, { once: true });
      });
      const expiry = Number.isFinite(this.options.deadline) && new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => reject(Object.assign(new Error('export deadline exceeded'), { code: 'deadline' })), Math.max(1, this.options.deadline - Date.now()));
        deadlineTimer.unref?.();
      });
      let result;
      try { result = await Promise.race([this.iterator.next(), ...(abort ? [abort] : []), ...(expiry ? [expiry] : [])]); }
      finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (abortListener) this.options.signal.removeEventListener('abort', abortListener);
      }
      if (result.done) { this.done = true; return false; }
      const chunk = Buffer.from(result.value);
      if (chunk.length === 0) continue;
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      return true;
    }
  }

  async readExactly(length) {
    while (this.buffer.length < length && !this.done) await this.nextChunk();
    if (this.buffer.length < length) throw new Error('truncated frame');
    const value = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return value;
  }

  async readPayload(length, onChunk) {
    let remaining = length;
    while (remaining > 0) {
      if (this.buffer.length === 0) {
        if (this.done || !(await this.nextChunk())) throw new Error('truncated frame');
      }
      const take = Math.min(remaining, this.buffer.length);
      const chunk = this.buffer.subarray(0, take);
      this.buffer = this.buffer.subarray(take);
      remaining -= take;
      await onChunk(chunk, remaining === 0);
    }
  }

  async expectEof() {
    if (this.buffer.length > 0) throw new Error('trailing bytes after END');
    while (!this.done) {
      if (!(await this.nextChunk())) break;
      if (this.buffer.length > 0) throw new Error('trailing bytes after END');
    }
  }
}

function decodeHeader(header) {
  const type = header.readUInt8(0);
  const flags = header.readUInt8(1);
  const mode = header.readUInt16BE(2);
  const pathLength = header.readUInt32BE(4);
  const sizeBig = header.readBigUInt64BE(8);
  const targetLength = header.readUInt32BE(16);
  const reserved = header.readUInt32BE(20);
  if (type === TYPE_END) {
    if (header.some(byte => byte !== 0)) throw new Error('invalid END record');
    return { type };
  }
  if (!TYPE_NAMES.has(type)) throw new Error(`unsupported record type: ${type}`);
  if (flags !== 0) throw new Error('record flags must be zero');
  if (reserved !== 0) throw new Error('record reserved field must be zero');
  if (targetLength !== 0) throw new Error('record target length must be zero');
  if (mode > 0o777) throw new Error('record mode exceeds protocol limit');
  if (pathLength < 1 || pathLength > LIMITS.maxPath) throw new Error('record path exceeds protocol limit');
  if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('record size exceeds safe integer range');
  const size = Number(sizeBig);
  if (type === TYPE_DIRECTORY && size !== 0) throw new Error('directory record must have zero size');
  if (type === TYPE_FILE && size > LIMITS.maxRecord) throw new Error('file record exceeds protocol limit');
  return { type, mode, pathLength, size };
}

async function consumeExport(stream, handlers = {}, options = {}) {
  const reader = new ByteReader(stream, options);
  if (!(await reader.readExactly(MAGIC.length)).equals(MAGIC)) throw new Error('protocol-version mismatch');
  const seen = new Set();
  let entries = 0;
  let total = 0;
  while (true) {
    checkOptions(options);
    const decoded = decodeHeader(await reader.readExactly(HEADER_BYTES));
    if (decoded.type === TYPE_END) {
      await reader.expectEof();
      return;
    }
    const pathBytes = await reader.readExactly(decoded.pathLength);
    const path = Buffer.from(pathBytes).toString('utf8');
    if (!Buffer.from(path, 'utf8').equals(pathBytes)) throw new Error('publication path is not valid UTF-8');
    validatePath(path, decoded.pathLength);
    if (seen.has(path)) throw new Error(`duplicate publication path: ${path}`);
    seen.add(path);
    if (++entries > LIMITS.maxEntries || (total += decoded.size) > LIMITS.maxBytes) throw new Error('export exceeds resource limit');
    const meta = { type: TYPE_NAMES.get(decoded.type), path, mode: decoded.mode, size: decoded.size };
    await handlers.start?.(meta);
    if (decoded.type === TYPE_FILE && decoded.size > 0) await reader.readPayload(decoded.size, (chunk, final) => handlers.chunk?.(meta, chunk, final));
    await handlers.end?.(meta);
  }
}

export async function* parseExport(stream, options = {}) {
  const records = [];
  let current;
  await consumeExport(stream, {
    start(meta) { current = { ...meta, chunks: [] }; },
    chunk(_meta, chunk) { current.chunks.push(Buffer.from(chunk)); },
    end() {
      records.push({ type: current.type, path: current.path, mode: current.mode, size: current.size, data: Buffer.concat(current.chunks) });
      current = undefined;
    },
  }, options);
  yield* records;
}

function safeMode(mode) { return mode & 0o777; }

export async function publishExport(stream, destination, dependencyNames = [], options = {}) {
  const excluded = exclusions(dependencyNames);
  const io = options.io ?? fsPromises;
  const existing = await io.readdir(destination);
  if (existing.some(name => name !== '.yolo')) throw new Error('publication destination is not empty');
  const createdEntries = [];
  const createdDirectories = new Set();
  const partialEvidence = [];
  let current;

  const snapshotError = error => Object.assign(new Error(`publication_incomplete: ${error.message}`), {
    code: 'publication_incomplete',
    cause: error,
    created_entries: createdEntries.length,
    created_entry_paths: [...createdEntries],
    partial_evidence: partialEvidence.map(entry => ({ ...entry })),
  });

  async function createParents(path) {
    const parts = path.split('/');
    parts.pop();
    let relative = '';
    for (const part of parts) {
      relative = relative ? `${relative}/${part}` : part;
      if (createdDirectories.has(relative)) continue;
      await io.mkdir(join(destination, ...relative.split('/')), { mode: 0o700 });
      createdDirectories.add(relative);
      createdEntries.push(relative);
    }
  }

  try {
    await consumeExport(stream, {
      async start(meta) {
        const skip = meta.path.split('/').some(part => excluded.has(part));
        current = { meta, skip, fh: undefined, evidence: undefined, error: undefined };
        if (skip) return;
        await createParents(meta.path);
        const target = join(destination, ...meta.path.split('/'));
        if (meta.type === 'directory') {
          if (!createdDirectories.has(meta.path)) {
            await io.mkdir(target, { mode: safeMode(meta.mode) });
            createdDirectories.add(meta.path);
            createdEntries.push(meta.path);
          }
          return;
        }
        current.fh = await io.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), safeMode(meta.mode));
        createdEntries.push(meta.path);
        current.evidence = { path: meta.path, bytes: 0 };
        partialEvidence.push(current.evidence);
      },
      async chunk(_meta, payload) {
        if (current.skip) return;
        let offset = 0;
        while (offset < payload.length) {
          const result = await current.fh.write(payload, offset, payload.length - offset);
          const bytesWritten = result?.bytesWritten;
          if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > payload.length - offset) throw new Error('file write made invalid progress');
          offset += bytesWritten;
          current.evidence.bytes += bytesWritten;
        }
      },
      async end(meta) {
        if (current.skip || meta.type === 'directory') { current = undefined; return; }
        let failure;
        try { await current.fh.sync(); }
        catch (error) { failure = error; }
        try { await current.fh.close(); }
        catch (error) { failure ??= error; }
        current.fh = undefined;
        current = undefined;
        if (failure) throw failure;
      },
    }, options);
    return { version: PROTOCOL_VERSION, published: true, created: createdEntries.length, created_entries: createdEntries, partial_evidence: partialEvidence };
  } catch (error) {
    if (current?.fh) {
      try { await current.fh.close(); }
      catch (closeError) { error.closeError = closeError; }
      current.fh = undefined;
    }
    if (error?.code === 'publication_incomplete') throw error;
    throw snapshotError(error);
  }
}