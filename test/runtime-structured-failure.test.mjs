import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnce, EXEC_TOOL, classifyProviderCause } from '../src/runtime.mjs';

test('retains recovered tool failures separately from terminal provider failure', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yolo-')); let step = 0;
  const provider = { async next() {
    step += 1;
    if (step === 1) return { tool_call: { call_id: 'bad-1', name: 'exec', arguments: JSON.stringify({ command: 'python3', args: ['-c', 'bad'] }) } };
    if (step === 2) return { tool_call: { call_id: 'ok-1', name: 'exec', arguments: JSON.stringify({ command: 'true', args: [] }) } };
    if (step === 3) return { tool_call: { call_id: 'bad-2', name: 'exec', arguments: JSON.stringify({ command: 'vite', args: ['build'] }) } };
    if (step === 4) return { tool_call: { call_id: 'ok-2', name: 'exec', arguments: JSON.stringify({ command: 'true', args: [] }) } };
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET', syscall: 'read', errno: -104, message: 'https://secret.invalid/token' } });
  } };
  const executor = { async execute({ call }) { return call.call_id.startsWith('bad')
    ? { version: 1, ok: false, call_id: call.call_id, code: call.call_id === 'bad-2' ? 137 : 1, output: '', error: call.call_id === 'bad-2' ? 'Killed' : 'invalid utf-8' }
    : { version: 1, ok: true, call_id: call.call_id, code: 0, output: '' }; } };
  const record = await runOnce({ prompt: 'reproduce', workspace, provider, executor, tools: [EXEC_TOOL] });
  assert.equal(record.version, 2);
  assert.equal(record.failure.terminal.message, 'fetch failed');
  assert.equal(record.failure.recovered.length, 2);
  assert.deepEqual(record.failure.recovered.map(item => item.code), [1, 137]);
  assert.equal(record.failure.recovered[1].termination.classification, 'sigkill_compatible');
  assert.deepEqual(classifyProviderCause({ code: 'ECONNRESET', syscall: 'read', errno: -104, message: 'https://secret.invalid/token' }), { code: 'ECONNRESET', syscall: 'read', errno: -104 });
});
