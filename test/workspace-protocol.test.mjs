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
