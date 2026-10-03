import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { encodeExport, parseExport, publishExport } from '../src/workspace-protocol.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('framed export publishes files and recursively excludes dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yolo-protocol-'));
  try {
    const frames = encodeExport([
      { type: 'directory', path: 'packages' },
      { type: 'directory', path: 'packages/app' },
      { type: 'file', path: 'packages/app/main.js', mode: 0o644, data: Buffer.from('ok') },
      { type: 'directory', path: 'packages/app/node_modules' },
      { type: 'file', path: 'packages/app/node_modules/x.js', mode: 0o644, data: Buffer.from('secret') },
    ]);
    const result = await publishExport(Readable.from(frames), root, ['node_modules']);
    assert.equal(result.created, 3);
    assert.equal(await readFile(join(root, 'packages/app/main.js'), 'utf8'), 'ok');
    await assert.rejects(() => readFile(join(root, 'packages/app/node_modules/x.js')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('parser rejects traversal, duplicate, unsupported and truncated frames', async t => {
  for (const [name, frames] of [
    ['traversal', [{ type: 'file', path: '../escape', mode: 0o644, data: Buffer.from('x') }]],
    ['duplicate', [{ type: 'directory', path: 'x' }, { type: 'directory', path: 'x' }]],
    ['unsupported', [{ type: 'fifo', path: 'x' }]],
    ['truncated', [{ type: 'file', path: 'x', mode: 0o644, data: Buffer.from('x') }]],
  ]) {
    await t.test(name, async () => {
      const bytes = encodeExport(frames);
      const input = name === 'truncated' ? bytes.subarray(0, bytes.length - 1) : bytes;
      await assert.rejects(async () => { for await (const _record of parseExport(Readable.from([input]))) {} }, /unsafe|duplicate|unsupported|truncated/);
    });
  }
});

test('metadata is closed, typed, and rejects duplicate or non-canonical fields', async () => {
  const raw = (header, payload = Buffer.alloc(0)) => {
    const h = Buffer.from(header); const p = Buffer.alloc(8); p.writeUInt32BE(h.length); p.writeUInt32BE(payload.length, 4);
    return Buffer.concat([Buffer.from('YHP1'), p, h, payload]);
  };
  for (const header of [
    '{"version":1,"version":1,"type":"directory","path":"x","mode":493}',
    '{"version":1,"type":"directory","path":"x","mode":"493"}',
    '{"version":1,"type":"directory","path":"x","mode":493,"extra":true}',
    '{"version":1.0,"type":"directory","path":"x","mode":493}',
  ]) await assert.rejects(async () => { for await (const _ of parseExport(Readable.from([raw(header)]))) {} }, /metadata|canonical/);
});

test('partial publication reports the created leaf and exact bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yolo-partial-'));
  try {
    const header = Buffer.from('{"version":1,"type":"file","path":"partial.bin","mode":420,"size":10}');
    const prefix = Buffer.alloc(8); prefix.writeUInt32BE(header.length); prefix.writeUInt32BE(10, 4);
    await assert.rejects(() => publishExport(Readable.from([Buffer.concat([Buffer.from('YHP1'), prefix, header, Buffer.from('abc')])]), root), error => {
      assert.equal(error.code, 'publication_incomplete'); assert.deepEqual(error.created_entry_paths, ['partial.bin']);
      assert.deepEqual(error.partial_evidence, [{ path: 'partial.bin', bytes: 3 }]); return true;
    });
    assert.equal((await readFile(join(root, 'partial.bin'))).toString(), 'abc');
  } finally { await rm(root, { recursive: true, force: true }); }
});
