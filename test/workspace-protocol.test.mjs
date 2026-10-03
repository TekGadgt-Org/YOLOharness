import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LIMITS,
  PROTOCOL_VERSION,
  encodeEnd,
  encodeExport,
  encodeRecordHeader,
  parseExport,
  publishExport,
} from '../src/workspace-protocol.mjs';

const MAGIC = Buffer.from('YHP2');
const HEADER_BYTES = 24;

function rawHeader({ type = 0, flags = 0, mode = 0, pathLength = 0, size = 0n, targetLength = 0, reserved = 0 } = {}) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt8(flags, 1);
  header.writeUInt16BE(mode, 2);
  header.writeUInt32BE(pathLength, 4);
  header.writeBigUInt64BE(BigInt(size), 8);
  header.writeUInt32BE(targetLength, 16);
  header.writeUInt32BE(reserved, 20);
  return header;
}

function rawRecord({ type, pathBytes = Buffer.alloc(0), mode = 0, size = 0n, payload = Buffer.alloc(0), flags = 0, targetLength = 0, reserved = 0 }) {
  return Buffer.concat([
    rawHeader({ type, flags, mode, pathLength: pathBytes.length, size, targetLength, reserved }),
    pathBytes,
    payload,
  ]);
}

async function parsed(bytes, chunks = [bytes]) {
  const records = [];
  for await (const record of parseExport(Readable.from(chunks))) records.push(record);
  return records;
}

async function rejects(bytes, pattern) {
  await assert.rejects(async () => {
    for await (const _record of parseExport(Readable.from([bytes]))) {}
  }, pattern);
}

test('YHP2 encoder emits fixed headers and one mandatory END', async () => {
  assert.equal(PROTOCOL_VERSION, 2);
  const bytes = encodeExport([
    { type: 'directory', path: 'dir', mode: 0o751 },
    { type: 'file', path: 'dir/file', mode: 0o640, data: Buffer.from('abc') },
  ]);
  assert.equal(bytes.subarray(0, 4).toString(), 'YHP2');
  assert.equal(bytes.subarray(-HEADER_BYTES).equals(Buffer.alloc(HEADER_BYTES)), true);
  assert.equal(encodeEnd().equals(Buffer.alloc(HEADER_BYTES)), true);
  assert.equal(encodeRecordHeader({ type: 'directory', path: 'x', mode: 0o755 }).length, HEADER_BYTES + 1);
  assert.deepEqual(await parsed(bytes), [
    { type: 'directory', path: 'dir', mode: 0o751, size: 0, data: Buffer.alloc(0) },
    { type: 'file', path: 'dir/file', mode: 0o640, size: 3, data: Buffer.from('abc') },
  ]);
});

test('YHP2 parser rejects malformed fields, paths, END placement, and trailing bytes', async t => {
  const end = rawHeader();
  const validDirectory = rawRecord({ type: 1, pathBytes: Buffer.from('x'), mode: 0o755 });
  const cases = [
    ['legacy magic', Buffer.concat([Buffer.from('YHP1'), end]), /protocol-version/],
    ['unsupported type', Buffer.concat([MAGIC, rawRecord({ type: 3, pathBytes: Buffer.from('x') }), end]), /unsupported record type/],
    ['flags', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('x'), flags: 1 }), end]), /flags/],
    ['reserved', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('x'), reserved: 1 }), end]), /reserved/],
    ['target', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('x'), targetLength: 1 }), end]), /target/],
    ['directory size', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('x'), size: 1n }), end]), /directory/],
    ['mode', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('x'), mode: 0o1000 }), end]), /mode/],
    ['oversize path', Buffer.concat([MAGIC, rawHeader({ type: 1, pathLength: LIMITS.maxPath + 1 }), end]), /path/],
    ['oversize file', Buffer.concat([MAGIC, rawHeader({ type: 2, pathLength: 1, size: BigInt(LIMITS.maxRecord + 1) }), Buffer.from('x'), end]), /record|file/],
    ['unsafe absolute', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('/x') }), end]), /unsafe/],
    ['unsafe drive', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('C:/x') }), end]), /unsafe/],
    ['unsafe slash component', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('a//b') }), end]), /unsafe/],
    ['unsafe dot', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('a/./b') }), end]), /unsafe/],
    ['unsafe dotdot', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('a/../b') }), end]), /unsafe/],
    ['unsafe backslash', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('a\\b') }), end]), /unsafe/],
    ['unsafe nul', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from('a\0b') }), end]), /unsafe/],
    ['invalid utf8', Buffer.concat([MAGIC, rawRecord({ type: 1, pathBytes: Buffer.from([0xc3]) }), end]), /UTF-8/],
    ['duplicate', Buffer.concat([MAGIC, validDirectory, validDirectory, end]), /duplicate/],
    ['missing END', Buffer.concat([MAGIC, validDirectory]), /END|truncated/],
    ['truncated header', Buffer.concat([MAGIC, validDirectory, end.subarray(0, 23)]), /truncated/],
    ['nonzero END field', Buffer.concat([MAGIC, rawHeader({ mode: 1 })]), /END/],
    ['trailing byte', Buffer.concat([MAGIC, end, Buffer.from([0])]), /trailing/],
    ['second END', Buffer.concat([MAGIC, end, end]), /trailing/],
  ];
  for (const [name, bytes, pattern] of cases) await t.test(name, () => rejects(bytes, pattern));
});

test('YHP2 parser has at least 650 deterministic exact boundary decisions', async () => {
  const bytes = encodeExport([
    { type: 'directory', path: 'd', mode: 0o755 },
    { type: 'file', path: 'f', mode: 0o644, data: Buffer.alloc(256, 0xa5) },
  ]);
  let decisions = 0;
  for (let length = 0; length < bytes.length; length += 1) {
    await rejects(bytes.subarray(0, length), /./);
    decisions += 1;
  }
  const expected = await parsed(bytes);
  for (let split = 1; split < bytes.length; split += 1) {
    assert.deepEqual(await parsed(bytes, [bytes.subarray(0, split), bytes.subarray(split)]), expected);
    decisions += 1;
  }
  assert.ok(decisions >= 650, `expected >=650 decisions, got ${decisions}`);
});

test('publication records implicit parents, files, and exact partial bytes in creation order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yolo-protocol-'));
  try {
    const result = await publishExport(Readable.from([encodeExport([
      { type: 'file', path: 'implicit/nested/leaf.txt', mode: 0o640, data: Buffer.from('abc') },
    ])]), root);
    assert.deepEqual(result, {
      version: 2,
      published: true,
      created: 3,
      created_entries: ['implicit', 'implicit/nested', 'implicit/nested/leaf.txt'],
      partial_evidence: [{ path: 'implicit/nested/leaf.txt', bytes: 3 }],
    });
    assert.equal((await stat(join(root, 'implicit'))).isDirectory(), true);
    assert.equal(await readFile(join(root, 'implicit/nested/leaf.txt'), 'utf8'), 'abc');

    const partial = Buffer.concat([
      MAGIC,
      encodeRecordHeader({ type: 'file', path: 'partial/leaf.bin', mode: 0o600 }, 10),
      Buffer.from('abcd'),
    ]);
    const partialRoot = await mkdtemp(join(tmpdir(), 'yolo-partial-'));
    try {
      await assert.rejects(() => publishExport(Readable.from([partial]), partialRoot), error => {
        assert.equal(error.code, 'publication_incomplete');
        assert.equal(error.created_entries, 2);
        assert.deepEqual(error.created_entry_paths, ['partial', 'partial/leaf.bin']);
        assert.deepEqual(error.partial_evidence, [{ path: 'partial/leaf.bin', bytes: 4 }]);
        return true;
      });
      assert.equal(await readFile(join(partialRoot, 'partial/leaf.bin'), 'utf8'), 'abcd');
    } finally { await rm(partialRoot, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication loops on bytesWritten, rejects zero progress, and closes deterministically', async () => {
  const calls = [];
  const makeIo = bytesPerWrite => ({
    readdir: async () => [],
    mkdir: async path => { calls.push(['mkdir', path]); },
    open: async path => {
      calls.push(['open', path]);
      return {
        write: async (_buffer, _offset, length) => {
          const bytesWritten = Math.min(bytesPerWrite, length);
          calls.push(['write', bytesWritten]);
          return { bytesWritten };
        },
        sync: async () => { calls.push(['sync']); },
        close: async () => { calls.push(['close']); },
      };
    },
  });

  const result = await publishExport(Readable.from([encodeExport([
    { type: 'file', path: 'short.bin', mode: 0o600, data: Buffer.from('abc') },
  ])]), '/virtual', [], { io: makeIo(1) });
  assert.deepEqual(result.partial_evidence, [{ path: 'short.bin', bytes: 3 }]);
  assert.equal(calls.filter(([name]) => name === 'write').length, 3);
  assert.deepEqual(calls.slice(-2), [['sync'], ['close']]);

  calls.length = 0;
  await assert.rejects(() => publishExport(Readable.from([encodeExport([
    { type: 'file', path: 'zero.bin', mode: 0o600, data: Buffer.from('x') },
  ])]), '/virtual', [], { io: makeIo(0) }), error => {
    assert.equal(error.code, 'publication_incomplete');
    assert.deepEqual(error.partial_evidence, [{ path: 'zero.bin', bytes: 0 }]);
    assert.equal(calls.at(-1)[0], 'close');
    return true;
  });
});

test('publication excludes .yolo defensively before creating any path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yolo-exclusion-'));
  try {
    const result = await publishExport(Readable.from([encodeExport([
      { type: 'directory', path: '.yolo', mode: 0o700 },
      { type: 'file', path: '.yolo/last-receipt.json', mode: 0o600, data: Buffer.from('bad') },
      { type: 'file', path: 'ordinary.txt', mode: 0o644, data: Buffer.from('ok') },
    ])]), root);
    assert.deepEqual(result.created_entries, ['ordinary.txt']);
    await assert.rejects(() => stat(join(root, '.yolo')), { code: 'ENOENT' });
    assert.equal(await readFile(join(root, 'ordinary.txt'), 'utf8'), 'ok');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('both exporter entry points emit YHP2, exclude .yolo, and terminate with END', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'yolo-exporters-'));
  const workspace = join(fixture, 'workspace');
  await mkdir(join(workspace, '.yolo', 'runs'), { recursive: true });
  await writeFile(join(workspace, '.yolo', 'last-receipt.json'), '{}');
  await writeFile(join(workspace, 'ordinary.txt'), 'ok');
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const protocolUrl = pathToFileURL(join(testDirectory, '..', 'src', 'workspace-protocol.mjs')).href;
  try {
    for (const scriptName of ['workspace-export.mjs', 'workspace-publish.mjs']) {
      const sourcePath = join(testDirectory, '..', 'src', scriptName);
      const instrumented = join(fixture, scriptName);
      const source = (await readFile(sourcePath, 'utf8'))
        .replace("'./workspace-protocol.mjs'", JSON.stringify(protocolUrl))
        .replace("'/tmp/workspace'", JSON.stringify(workspace));
      await writeFile(instrumented, source);
      const child = spawn(process.execPath, [instrumented], { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout = [];
      let stderr = '';
      child.stdout.on('data', chunk => stdout.push(chunk));
      child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise(resolve => child.once('close', resolve));
      assert.equal(code, 0, stderr);
      const records = await parsed(Buffer.concat(stdout));
      assert.deepEqual(records.map(record => record.path), ['ordinary.txt']);
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});