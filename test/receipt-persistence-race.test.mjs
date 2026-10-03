import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { persistReceipt } from '../src/receipt-persistence.mjs';
import { buildCleanupUnknownReceipt } from '../src/cli.mjs';

const exchange = (left, right) => {
  const script = [
    'import ctypes,sys',
    'libc=ctypes.CDLL(None,use_errno=True)',
    'libc.renameat2.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]',
    'libc.renameat2.restype=ctypes.c_int',
    'rc=libc.renameat2(-100,sys.argv[1].encode(),-100,sys.argv[2].encode(),2)',
    'raise SystemExit(0 if rc == 0 else ctypes.get_errno())',
  ].join(';');
  const result = spawnSync('python3', ['-c', script, left, right], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};

const fixture = async prefix => {
  const workspace = await mkdtemp(`/tmp/${prefix}-`);
  const outside = await mkdtemp(`/tmp/${prefix}-outside-`);
  await mkdir(join(workspace, '.yolo'));
  const sentinel = Buffer.from('{"operator":true}\n');
  await writeFile(join(outside, 'last-receipt.json'), sentinel, { mode: 0o640 });
  return { workspace, outside, sentinel };
};

const assertUntouched = async ({ workspace, outside, sentinel, persist }) => {
  const original = join(workspace, '.yolo');
  const replacement = outside;
  await assert.rejects(persist(async () => exchange(original, replacement)), /changed|receipt directory/);
  exchange(original, replacement);
  assert.deepEqual(await readFile(join(outside, 'last-receipt.json')), sentinel);
  assert.equal((await stat(join(outside, 'last-receipt.json'))).mode & 0o777, 0o640);
  await assert.rejects(stat(join(workspace, '.yolo', 'last-receipt.json')));
  await assert.rejects(stat(join(outside, 'last-receipt.json.tmp')));
};

test('ordinary receipt persistence fails closed on a deterministic RENAME_EXCHANGE barrier', { skip: process.platform !== 'linux' }, async () => {
  const value = await fixture('yolo-receipt-normal-race');
  try {
    await assertUntouched({ ...value, persist: barrier => persistReceipt(value.workspace, { version: 1, status: 'completed' }, { beforeReceiptDirectoryOpen: barrier }) });
  } finally { await rm(value.workspace, { recursive: true, force: true }); await rm(value.outside, { recursive: true, force: true }); }
});

test('cleanup receipt persistence fails closed on a deterministic RENAME_EXCHANGE barrier', { skip: process.platform !== 'linux' }, async () => {
  const value = await fixture('yolo-receipt-cleanup-race');
  try {
    await assertUntouched({ ...value, persist: async barrier => {
      const result = await buildCleanupUnknownReceipt(new Error('cleanup unknown'), value.workspace, { beforeReceiptDirectoryOpen: barrier });
      assert.equal(result.status, 'cleanup_unknown');
      throw new Error('receipt directory changed during persistence');
    } });
  } finally { await rm(value.workspace, { recursive: true, force: true }); await rm(value.outside, { recursive: true, force: true }); }
});