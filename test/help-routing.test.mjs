import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';

function makeIo() {
  const output = [];
  const errors = [];
  return { io: { stdin: { isTTY: false }, stdout: { write(value) { output.push(value); } }, stderr: { write(value) { errors.push(value); } } }, output, errors };
}

test('uninstall help is side-effect-free and does not require Docker', async () => {
  const { io, output, errors } = makeIo();
  assert.equal(await main(['uninstall', '--help'], io), 0);
  assert.match(output.join(''), /Usage: yolo uninstall/);
  assert.deepEqual(errors, []);
});

test('setup help is side-effect-free and does not require Docker', async () => {
  const { io, output, errors } = makeIo();
  assert.equal(await main(['setup', '--help'], io), 0);
  assert.match(output.join(''), /Usage: yolo setup/);
  assert.deepEqual(errors, []);
});

test('auth logout help does not clear credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-help-auth-'));
  const previous = process.env.YOLO_AUTH_FILE;
  const path = join(dir, 'credentials.json');
  try {
    process.env.YOLO_AUTH_FILE = path;
    await writeFile(path, '{"accessToken":"keep-me"}\n');
    const { io, output, errors } = makeIo();
    assert.equal(await main(['auth', 'logout', '--help'], io), 0);
    assert.match(output.join(''), /Usage: yolo auth logout/);
    assert.deepEqual(errors, []);
    assert.equal(await readFile(path, 'utf8'), '{"accessToken":"keep-me"}\n');
  } finally {
    if (previous === undefined) delete process.env.YOLO_AUTH_FILE; else process.env.YOLO_AUTH_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('supported command help paths are side-effect-free', async () => {
  const paths = [
    ['setup', '--help'], ['doctor', '-h'], ['skills', '--help'],
    ['skills', 'list', '--help'], ['skills', 'install', '-h'], ['skills', 'uninstall', '--help'],
    ['uninstall', '-h'], ['config', '--help'], ['config', 'set', 'model', '--help'],
    ['config', 'ephemeral-path', '--help'], ['config', 'ephemeral-path', 'list', '--help'],
    ['config', 'ephemeral-path', 'add', '--help'], ['config', 'ephemeral-path', 'remove', '-h'],
    ['config', 'ephemeral-path', 'reset', '--help'], ['auth', '--help'],
    ['auth', 'login', '--help'], ['auth', 'status', '-h'], ['auth', 'logout', '--help'],
  ];
  for (const path of paths) {
    const { io, output, errors } = makeIo();
    assert.equal(await main(path, io), 0, path.join(' '));
    assert.match(output.join(''), /^Usage: yolo /, path.join(' '));
    assert.deepEqual(errors, [], path.join(' '));
  }
  assert.equal(paths.length, 18);
});

test('closed command shapes reject trailing arguments before command work', async () => {
  const paths = [['setup', 'extra'], ['doctor', 'extra'], ['auth', 'status', 'extra'], ['auth', 'logout', 'extra'], ['skills', 'list', 'extra'], ['config', 'ephemeral-path', 'list', 'extra'], ['uninstall', 'extra']];
  for (const path of paths) {
    const { io, output } = makeIo();
    assert.equal(await main(path, io), 1, path.join(' '));
    assert.deepEqual(output, [], path.join(' '));
  }
  assert.equal(paths.length, 7);
});
