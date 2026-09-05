import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ContainerLauncher } from '../src/container-launcher.mjs';

const enabled = process.env.YOLO_REAL_DOCKER === '1';
const image = process.env.YOLO_DOCKER_IMAGE ?? 'yoloharness-local:0.1.0';
const skip = !enabled;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' });

test('shipped whole-runtime launcher uses the final image and one workspace bind', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-whole-runtime-');
  try {
    const launcher = new ContainerLauncher({ image, workspace, responsesUrl: 'https://chatgpt.com/backend-api/codex/responses', timeoutMs: 5000 });
    const record = await launcher.launch({ prompt: 'synthetic acceptance', model: 'synthetic-model', deadline: Date.now() + 3000, accessToken: 'synthetic-access-token', expiresAt: Date.now() + 60_000 });
    assert.equal(record.status, 'failed');
    assert.match(record.errors.join('\n'), /fetch failed|network|401|provider/i);
    assert.deepEqual((docker('ps', '-a', '--format', '{{.Names}}').trim().split(/\r?\n/).filter(Boolean)).filter(name => name.startsWith('yoloharness-')), []);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('final image has a read-only root and rootless UID0 workspace write/delete canary', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-image-canary-');
  try {
    const output = docker('run', '--rm', '--pull=never', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m', '--mount', `type=bind,src=${workspace},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--user', '0:0', '--entrypoint', 'sh', image, '-c', 'id -u; touch /workspace/canary; rm /workspace/canary; ! touch /app/forbidden');
    assert.match(output, /^0\n/);
    await assert.rejects(access(join(workspace, 'canary')));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});