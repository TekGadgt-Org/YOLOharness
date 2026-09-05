import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DockerExecutor } from '../src/docker-executor.mjs';
import { EXEC_TOOL, runOnce } from '../src/runtime.mjs';

const enabled = process.env.YOLO_REAL_DOCKER === '1';
const image = process.env.YOLO_DOCKER_IMAGE ?? 'yoloharness-phase1:local';
const skip = !enabled;

class NamedExecutor extends DockerExecutor {
  constructor(options) { super(options); this.name = options.name ?? `yoloharness-real-${randomUUID()}`; }
  containerName() { return this.name; }
}

const dockerInspect = name => JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0];
const dockerNames = () => execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real Docker worker enforces the phase1 boundary and cleans up', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-real-test-');
  await chmod(workspace, 0o777);
  try {
    const executor = new NamedExecutor({ image, workspace, timeoutMs: 5000 });
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
    const failed = await executor.execute({ call: { call_id: 'real-failure', command: 'sh', args: ['-c', 'printf failure >&2; exit 7'] } });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 7);
    assert.match(failed.error, /failure/);
    const capabilities = await executor.execute({ call: { call_id: 'real-capabilities', command: 'sh', args: ['-c', "test \"$(awk '/CapEff/ {print $2}' /proc/self/status)\" = 0000000000000000"] } });
    assert.equal(capabilities.ok, true);
    const controlArtifact = join(workspace, 'delayed-control.txt');
    const control = await executor.execute({ call: { call_id: 'real-delayed-control', command: 'sh', args: ['-c', 'sleep 0.2; printf control > /workspace/delayed-control.txt'] } });
    assert.equal(control.ok, true);
    await delay(300);
    assert.equal(await readFile(controlArtifact, 'utf8'), 'control');
    const delayedArtifact = join(workspace, 'late.txt');
    const deadlineExecutor = new NamedExecutor({ image, workspace, timeoutMs: 100 });
    await assert.rejects(deadlineExecutor.execute({ call: { call_id: 'real-deadline', command: 'sh', args: ['-c', 'sleep 1; printf late > /workspace/late.txt'] } }), /deadline exceeded/);
    await delay(1500);
    await assert.rejects(access(delayedArtifact));
    assert.equal(dockerNames().includes(deadlineExecutor.name), false);
    assert.equal(dockerNames().some(name => name.startsWith('yoloharness-real-')), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('real Docker daemon reports the configured confinement and resource limits', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-real-inspect-');
  const name = `yoloharness-real-inspect-${randomUUID()}`;
  const executor = new NamedExecutor({ image, workspace, name });
  try {
    execFileSync('docker', executor.args(name), { encoding: 'utf8' });
    const config = dockerInspect(name);
    assert.equal(config.HostConfig.NetworkMode, 'none');
    assert.equal(config.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(config.HostConfig.CapDrop, ['ALL']);
    assert.deepEqual(config.HostConfig.SecurityOpt, ['no-new-privileges']);
    assert.equal(config.HostConfig.PidsLimit, 128);
    assert.equal(config.HostConfig.Memory, 512 * 1024 * 1024);
    assert.equal(config.HostConfig.NanoCpus, 1_000_000_000);
    assert.deepEqual(config.Mounts.map(({ Destination, RW }) => ({ Destination, RW })), [{ Destination: '/workspace', RW: true }]);
  } finally {
    execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
    assert.equal(dockerNames().includes(name), false);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('real Docker missing image fails closed without leaving the exact container', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-real-missing-');
  const name = `yoloharness-real-missing-${randomUUID()}`;
  const executor = new NamedExecutor({ image: `yoloharness-image-does-not-exist-${randomUUID()}`, workspace, name, timeoutMs: 5000 });
  try {
    await assert.rejects(executor.execute({ call: { call_id: 'real-missing-image', command: 'true', args: [] } }));
    assert.equal(dockerNames().includes(name), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('real runtime bridge handles abort cleanup and prevents delayed writes', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-real-runtime-');
  const name = `yoloharness-real-runtime-${randomUUID()}`;
  const artifact = join(workspace, 'after-interrupt.txt');
  const controller = new AbortController();
  const executor = new NamedExecutor({ image, workspace, name, timeoutMs: 5000 });
  const provider = { async next() { return { tool_call: { name: 'exec', call_id: 'real-runtime-interrupt', arguments: JSON.stringify({ command: 'sh', args: ['-c', 'sleep 1; printf late > /workspace/after-interrupt.txt'] }) } }; } };
  try {
    const run = runOnce({ prompt: 'interrupt', minutes: 1, workspace, provider, executor, tools: [EXEC_TOOL], signal: controller.signal, cleanupGraceMs: 5000 });
    setTimeout(() => controller.abort(new Error('abort requested')), 100);
    const record = await run;
    assert.equal(record.status, 'interrupted', JSON.stringify(record));
    await delay(1500);
    await assert.rejects(access(artifact));
    assert.equal(dockerNames().includes(name), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
