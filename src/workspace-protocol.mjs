import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const PROTOCOL_VERSION = 1;
const MAGIC = Buffer.from('YHP1');
export const LIMITS = Object.freeze({ maxRecord: 128 * 1024 * 1024, maxPath: 4096, maxEntries: 100_000, maxBytes: 4 * 1024 * 1024 * 1024 });
const DEFAULT_EXCLUSIONS = new Set(['node_modules', '.venv', 'vendor', '.godot', 'target']);

function exclusions(names = []) {
  if (!Array.isArray(names) || names.some(x => typeof x !== 'string' || !x || x === '.' || x === '..' || x.includes('/') || x.includes('\\'))) throw new TypeError('invalid dependency directory names');
  return new Set([...DEFAULT_EXCLUSIONS, ...names]);
}
function validatePath(path) {
  if (typeof path !== 'string' || Buffer.byteLength(path, 'utf8') > LIMITS.maxPath || !path || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`unsafe publication path: ${path}`);
}
function parseMeta(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  if (/(?:^|[,:\[])\s*-?(?:0|[1-9]\d*)(?:\.\d+|[eE][+-]?\d+)/.test(text)) throw new Error('non-canonical numeric metadata');
  const keys = new Set();
  for (const match of text.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)) { if (keys.has(match[1])) throw new Error('duplicate metadata key'); keys.add(match[1]); }
  let meta;
  try { meta = JSON.parse(text); }
  catch { throw new Error('malformed frame metadata'); }
  if (!meta || Array.isArray(meta) || typeof meta !== 'object') throw new Error('ambiguous frame metadata');
  return meta;
}
function validateMeta(meta, payloadLength) {
  if (!meta || meta.version !== PROTOCOL_VERSION) throw new Error('protocol-version mismatch');
  if (!Number.isInteger(meta.version) || JSON.stringify(meta.version) !== String(PROTOCOL_VERSION)) throw new Error('non-canonical protocol version');
  validatePath(meta.path);
  if (!['file', 'directory'].includes(meta.type)) throw new Error(`unsupported record type: ${meta.type}`);
  if (meta.type === 'file') {
    if (Object.keys(meta).some(k => !['version', 'type', 'path', 'mode', 'size'].includes(k)) || !Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size !== payloadLength || !Number.isInteger(meta.mode) || meta.mode < 0 || meta.mode > 0o777) throw new Error('inconsistent file metadata');
  } else {
    if (Object.keys(meta).some(k => !['version', 'type', 'path', 'mode'].includes(k)) || !Number.isInteger(meta.mode) || meta.mode < 0 || meta.mode > 0o777 || payloadLength !== 0) throw new Error('inconsistent directory metadata');
  }
}
function frame(meta, payload = Buffer.alloc(0)) {
  const { data: _data, ...headerMeta } = meta;
  const header = Buffer.from(JSON.stringify({ version: PROTOCOL_VERSION, ...headerMeta }));
  if (header.length > 65535 || payload.length > LIMITS.maxRecord) throw new Error('record exceeds protocol limit');
  const prefix = Buffer.alloc(8); prefix.writeUInt32BE(header.length); prefix.writeUInt32BE(payload.length, 4);
  return Buffer.concat([prefix, header, payload]);
}
export function encodeRecordHeader(meta, size = 0) {
  const header = Buffer.from(JSON.stringify({ version: PROTOCOL_VERSION, ...meta, ...(meta.type === 'file' ? { size } : {}) }));
  if (header.length > 65535 || size > LIMITS.maxRecord) throw new Error('record exceeds protocol limit');
  const prefix = Buffer.alloc(8); prefix.writeUInt32BE(header.length); prefix.writeUInt32BE(size, 4);
  return Buffer.concat([prefix, header]);
}
export function encodeExport(records) { return Buffer.concat([MAGIC, ...records.map(record => { const payload = record.data ?? Buffer.alloc(0); return frame({ mode: record.mode ?? 0o755, ...record, ...(record.type === 'file' ? { size: record.size ?? payload.length } : {}) }, payload); })]); }

async function allBytes(stream, { signal, deadline } = {}) { const chunks = []; let total = 0; for await (const chunk of stream) { if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('export aborted'), { code: 'aborted' }); if (Number.isFinite(deadline) && Date.now() >= deadline) throw Object.assign(new Error('export deadline exceeded'), { code: 'deadline' }); const b = Buffer.from(chunk); total += b.length; if (total > LIMITS.maxBytes) throw new Error('export exceeds total byte limit'); chunks.push(b); } return Buffer.concat(chunks); }
export async function* parseExport(stream, options = {}) {
  const bytes = await allBytes(stream, options); let offset = 0; const seen = new Set(); let entries = 0; let total = 0;
  if (!bytes.subarray(0, 4).equals(MAGIC)) throw new Error('protocol-version mismatch'); offset = 4;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw new Error('truncated frame');
    const headerLength = bytes.readUInt32BE(offset); const payloadLength = bytes.readUInt32BE(offset + 4); offset += 8;
    if (headerLength > 65535 || payloadLength > LIMITS.maxRecord || bytes.length - offset < headerLength + payloadLength) throw new Error('truncated frame');
    const meta = parseMeta(bytes.subarray(offset, offset + headerLength)); offset += headerLength;
    const payload = bytes.subarray(offset, offset + payloadLength); offset += payloadLength;
    validateMeta(meta, payload.length); if (seen.has(meta.path)) throw new Error(`duplicate publication path: ${meta.path}`); seen.add(meta.path);
    if (++entries > LIMITS.maxEntries || (total += payload.length) > LIMITS.maxBytes) throw new Error('export exceeds resource limit');
    yield { ...meta, data: payload };
  }
}

async function consumeFrames(stream, onRecord, { signal, deadline } = {}) {
  let buffer = Buffer.alloc(0); let headerSeen = false; let meta; let remaining = 0; const seen = new Set(); let entries = 0; let total = 0;
  for await (const chunk of stream) {
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('export aborted'), { code: 'aborted' });
    if (Number.isFinite(deadline) && Date.now() >= deadline) throw Object.assign(new Error('export deadline exceeded'), { code: 'deadline' });
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (!headerSeen) { if (buffer.length < 4) continue; if (!buffer.subarray(0, 4).equals(MAGIC)) throw new Error('protocol-version mismatch'); buffer = buffer.subarray(4); headerSeen = true; }
    while (true) {
      if (!meta) {
        if (buffer.length < 8) break;
        const headerLength = buffer.readUInt32BE(0); const payloadLength = buffer.readUInt32BE(4);
        if (headerLength > 65535 || payloadLength > LIMITS.maxRecord) throw new Error('record exceeds protocol limit');
        if (buffer.length < 8 + headerLength) break;
        meta = parseMeta(buffer.subarray(8, 8 + headerLength));
        validateMeta(meta, payloadLength); if (seen.has(meta.path)) throw new Error(`duplicate publication path: ${meta.path}`); seen.add(meta.path);
        if (++entries > LIMITS.maxEntries || (total += payloadLength) > LIMITS.maxBytes) throw new Error('export exceeds resource limit');
        remaining = payloadLength; buffer = buffer.subarray(8 + headerLength);
        if (remaining === 0) { await onRecord(meta, Buffer.alloc(0), true); meta = undefined; continue; }
      }
      const take = Math.min(remaining, buffer.length); if (take === 0) break;
      const part = buffer.subarray(0, take); buffer = buffer.subarray(take); remaining -= take;
      await onRecord(meta, part, remaining === 0); if (remaining === 0) meta = undefined;
    }
    if (buffer.length > 8 + 65535) throw new Error('malformed frame');
  }
  if (!headerSeen || meta || buffer.length !== 0) throw new Error('truncated frame');
}

function safeMode(mode) { return mode & 0o777; }
export async function publishExport(stream, destination, dependencyNames = [], options = {}) {
  const excluded = exclusions(dependencyNames); const existing = await readdir(destination);
  if (existing.some(name => name !== '.yolo')) throw new Error('publication destination is not empty');
  let created = 0; const createdEntries = []; let current;
  try {
    await consumeFrames(stream, async (meta, payload, final) => {
      if (meta.path.split('/').some(part => excluded.has(part))) return;
      if (!current) {
        const parts = meta.path.split('/'); const leaf = parts.pop(); const parent = join(destination, ...parts); await mkdir(parent, { recursive: true, mode: 0o700 }); const target = join(parent, leaf);
        if (meta.type === 'directory') { await mkdir(target, { mode: safeMode(meta.mode ?? 0o755) }); created += 1; createdEntries.push(meta.path); return; }
        current = { fh: await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), safeMode(meta.mode)), path: meta.path };
        created += 1; createdEntries.push(current.path);
      }
      await current.fh.write(payload); current.bytes = (current.bytes ?? 0) + payload.length;
      if (final) { await current.fh.sync(); await current.fh.close(); current = undefined; }
    }, options);
    return { version: 1, published: true, created, created_entries: createdEntries };
  } catch (error) {
    await current?.fh?.close().catch(() => {});
    throw Object.assign(new Error(`publication_incomplete: ${error.message}`), { code: 'publication_incomplete', created_entries: created, created_entry_paths: createdEntries, partial_evidence: current ? [{ path: current.path, bytes: current.bytes ?? 0 }] : [] });
  }
}
