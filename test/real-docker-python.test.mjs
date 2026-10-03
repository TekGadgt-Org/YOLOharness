import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RUNTIME_RESOURCE_POLICY } from '../src/resource-policy.mjs';

const skip = process.env.YOLO_REAL_DOCKER !== '1';
const image = process.env.YOLO_DOCKER_IMAGE ?? 'yoloharness-local:0.1.1';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('final runtime image exposes the documented Python/Node/Git/sh baseline under shipped restrictions', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-python-');
  const volume = `yoloharness-python-${randomUUID()}`;
  try {
    docker('volume', 'create', '--label', `yoloharness.run=${volume}`, volume);
    const command = 'set -eu; python3 --version; python3 -m pip --version; python3 -m venv /tmp/venv; /tmp/venv/bin/python -c "from pathlib import Path; p=Path(chr(47)+chr(119)+chr(111)+chr(114)+chr(107)+chr(115)+chr(112)+chr(97)+chr(99)+chr(101)+chr(47)+chr(104)+chr(101)+chr(108)+chr(108)+chr(111)+chr(46)+chr(116)+chr(120)+chr(116)); p.write_text(chr(104)+chr(101)+chr(108)+chr(108)+chr(111)+chr(10))"; test "$(cat /workspace/hello.txt)" = hello; node --version; npm --version; git --version; command -v /bin/sh';
    const output = docker('run', '--rm', '--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', RUNTIME_RESOURCE_POLICY.pids, '--memory', RUNTIME_RESOURCE_POLICY.memory, '--cpus', RUNTIME_RESOURCE_POLICY.cpus, '--mount', `type=volume,src=${volume},dst=/tmp,volume-nocopy`, '--mount', `type=bind,src=${workspace},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--user', '0:0', '--entrypoint', 'sh', image, '-c', command);
    assert.match(output, /Python 3\./);
    assert.match(output, /pip /);
    assert.match(output, /v?\d+\./);
    assert.match(output, /git version /);
    assert.equal(await readFile(join(workspace, 'hello.txt'), 'utf8'), 'hello\n');
  } finally {
    try { docker('volume', 'rm', volume); } catch {}
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Docker-managed scratch handles a registry-free local npm package larger than the historical 64 MiB ceiling', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-npm-capacity-');
  const volume = `yoloharness-npm-${randomUUID()}`;
  try {
    await mkdir(join(workspace, 'package-fixture'));
    await writeFile(join(workspace, 'package-fixture', 'package.json'), JSON.stringify({ name: 'local-capacity-fixture', version: '1.0.0' }));
    await writeFile(join(workspace, 'package-fixture', 'payload.bin'), Buffer.alloc(70 * 1024 * 1024, 7));
    docker('volume', 'create', '--label', `yoloharness.run=${volume}`, volume);
    const output = docker('run', '--rm', '--pull=never', '--read-only', '--network', 'none', '--mount', `type=volume,src=${volume},dst=/tmp,volume-nocopy`, '--mount', `type=bind,src=${workspace},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--workdir', '/workspace', '--env', 'HOME=/tmp', '--user', '0:0', '--entrypoint', 'sh', image, '-c', 'set -eu; npm install --offline --ignore-scripts --no-audit --no-fund /workspace/package-fixture >/tmp/npm-install.log; test -f /workspace/node_modules/local-capacity-fixture/payload.bin; wc -c /workspace/node_modules/local-capacity-fixture/payload.bin');
    assert.match(output, /73400320/);
  } finally {
    try { docker('volume', 'rm', volume); } catch {}
    await rm(workspace, { recursive: true, force: true });
  }
});
