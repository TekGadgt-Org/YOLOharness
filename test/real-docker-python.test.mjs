import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNTIME_RESOURCE_POLICY } from '../src/resource-policy.mjs';

const skip = process.env.YOLO_REAL_DOCKER !== '1';
const image = process.env.YOLO_DOCKER_IMAGE ?? 'yoloharness-local:0.1.1';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('final runtime image exposes the documented Python/Node/Git/sh baseline under shipped restrictions', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-python-');
  try {
    const command = 'set -eu; python3 --version; python3 -m pip --version; python3 -m venv /tmp/venv; /tmp/venv/bin/python -c "from pathlib import Path; p=Path(chr(47)+chr(119)+chr(111)+chr(114)+chr(107)+chr(115)+chr(112)+chr(97)+chr(99)+chr(101)+chr(47)+chr(104)+chr(101)+chr(108)+chr(108)+chr(111)+chr(46)+chr(116)+chr(120)+chr(116)); p.write_text(chr(104)+chr(101)+chr(108)+chr(108)+chr(111)+chr(10))"; test "$(cat /workspace/hello.txt)" = hello; node --version; npm --version; git --version; command -v /bin/sh';
    const output = docker('run', '--rm', '--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', RUNTIME_RESOURCE_POLICY.pids, '--memory', RUNTIME_RESOURCE_POLICY.memory, '--cpus', RUNTIME_RESOURCE_POLICY.cpus, '--tmpfs', `/tmp:rw,noexec,nosuid,size=${RUNTIME_RESOURCE_POLICY.tmpfs}`, '--mount', `type=bind,src=${workspace},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--user', '0:0', '--entrypoint', 'sh', image, '-c', command);
    assert.match(output, /Python 3\./);
    assert.match(output, /pip /);
    assert.match(output, /v?\d+\./);
    assert.match(output, /git version /);
    assert.equal(await readFile(join(workspace, 'hello.txt'), 'utf8'), 'hello\n');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
