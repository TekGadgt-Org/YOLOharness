import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DockerExecutor } from '../src/docker-executor.mjs';

const enabled = process.env.YOLO_REAL_DOCKER === '1';
const image = process.env.YOLO_DOCKER_IMAGE ?? 'yoloharness-phase1:local';

test('real Docker worker enforces the phase1 boundary and cleans up', { skip: !enabled }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-real-test-');
  await chmod(workspace, 0o777);
  try {
    const executor = new DockerExecutor({ image, workspace, timeoutMs: 5000 });
    assert.match(await executor.preflight(), /^\d+\.\d+\.\d+$/);
    const success = await executor.execute({ call: { call_id: 'real-success', command: 'sh', args: ['-c', 'printf artifact > /workspace/result.txt && id -u'] } });
    assert.equal(success.ok, true);
    assert.match(success.output, /^10001\n$/);
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'artifact');
    const readOnly = await executor.execute({ call: { call_id: 'real-readonly', command: 'sh', args: ['-c', 'touch /app/forbidden'] } });
    assert.equal(readOnly.ok, false);
    assert.match(readOnly.error, /Read-only file system/);
    const noNetwork = await executor.execute({ call: { call_id: 'real-network', command: 'sh', args: ['-c', 'test ! -s /proc/net/route'] } });
    assert.equal(noNetwork.ok, true);
    const deadlineExecutor = new DockerExecutor({ image, workspace, timeoutMs: 100 });
    await assert.rejects(deadlineExecutor.execute({ call: { call_id: 'real-deadline', command: 'sleep', args: ['30'] } }), /deadline exceeded/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
