import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const enabled = process.env.YOLO_REAL_DOCKER === '1';
const skip = !enabled;
const dockerPath = execFileSync('command', ['-v', 'docker'], { shell: '/bin/sh', encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync(dockerPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const image = process.env.YOLO_DOCKER_IMAGE ?? 'yoloharness-local:0.1.1';

async function installPacked(root) {
  const packed = join(root, 'packed');
  await mkdir(packed);
  const name = execFileSync('npm', ['pack', '--pack-destination', packed], { cwd: process.cwd(), encoding: 'utf8' }).trim().split(/\r?\n/).at(-1);
  execFileSync('tar', ['-xzf', join(packed, name), '-C', packed]);
  const home = join(root, 'home');
  const data = join(root, 'data');
  const installed = spawnSync(process.execPath, [join(packed, 'package', 'install.mjs')], {
    cwd: join(packed, 'package'),
    env: { ...process.env, HOME: home, XDG_DATA_HOME: data },
    encoding: 'utf8',
  });
  assert.equal(installed.status, 0, installed.stderr);
  return { app: join(data, 'yoloharness', 'app'), bin: join(home, '.local', 'bin') };
}

async function writeDockerProxy(root, mode, logPath) {
  const proxy = join(root, `docker-${mode}.cjs`);
  await writeFile(proxy, `#!/usr/bin/env node
const cp = require('node:child_process');
const fs = require('node:fs');
const docker = ${JSON.stringify(dockerPath)};
const mode = ${JSON.stringify(mode)};
const log = ${JSON.stringify(logPath)};
const original = process.argv.slice(2);
const record = { mode, argv: original, env: { DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } };
if (original[0] === 'info') {
  fs.appendFileSync(log, JSON.stringify(record) + '\\n');
  const security = mode === 'rootless' ? ['name=rootless', 'name=seccomp,profile=builtin'] : ['name=seccomp,profile=builtin'];
  process.stdout.write(JSON.stringify({ OSType: 'linux', OperatingSystem: 'intentionally-irrelevant', ClientInfo: { Context: 'intentionally-irrelevant' }, SecurityOptions: security }));
  process.exit(0);
}
const translated = [...original];
if (mode === 'rootful' && original[0] === 'create') {
  for (let i = translated.length - 1; i >= 0; i--) {
    if (translated[i] === '--group-add') translated.splice(i, 2);
  }
  const user = translated.indexOf('--user');
  if (user >= 0) translated[user + 1] = '0:0';
  for (let i = 0; i < translated.length; i++) {
    if (translated[i] === '--tmpfs') translated[i + 1] = translated[i + 1].replace(/uid=[0-9]+,gid=[0-9]+/, 'uid=0,gid=0');
  }
  record.translatedArgv = translated;
}
fs.appendFileSync(log, JSON.stringify(record) + '\\n');
const child = cp.spawnSync(docker, translated, { env: process.env, encoding: 'utf8' });
process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? ''); process.exit(child.status ?? 1);
`);
  await execFileSync('chmod', ['755', proxy]);
  return proxy;
}

function argvValues(argv, flag) {
  return argv.flatMap((value, index) => value === flag ? [argv[index + 1]] : []);
}

function assertContract(record, mode, selectedDockerEnv) {
  assert.deepEqual(record.env, selectedDockerEnv);
  const argv = record.argv;
  assert.equal(argv[0], 'create');
  assert.equal(argvValues(argv, '--user').length, 1);
  assert.equal(argv.includes('--read-only'), true);
  assert.equal(argv.includes('--cap-drop=ALL'), true);
  assert.equal(argv.includes('--security-opt') && argv.includes('no-new-privileges'), true);
  const expectedGroups = mode === 'rootful' ? [...new Set(process.getgroups?.() ?? [])].filter(group => group !== process.getgid()).map(String) : [];
  assert.deepEqual(argvValues(argv, '--group-add'), expectedGroups);
  assert.equal(argvValues(argv, '--tmpfs').length, 2);
  for (const value of argvValues(argv, '--tmpfs')) assert.match(value, /uid=\d+,gid=\d+,mode=700/);
  assert.deepEqual(argvValues(argv, '--mount'), [argvValues(argv, '--mount')[0]]);
  assert.match(argvValues(argv, '--mount')[0], /^type=bind,src=/);
  assert.equal(argvValues(argv, '--workdir')[0], '/workspace');
  for (const forbidden of ['--privileged', '--pid=host', '--network=host', '/var/run/docker.sock']) assert.equal(argv.includes(forbidden), false);
  if (mode === 'rootful') assert.match(argvValues(argv, '--user')[0], new RegExp(`^${process.getuid()}:${process.getgid()}$`));
  else assert.equal(argvValues(argv, '--user')[0], '0:0');
}

test('installed v0.1.1 launcher retains rootless, Darwin-shaped, and rootful-shaped Docker identity evidence', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-identity-'));
  const foreignName = `yoloharness-foreign-identity-${process.pid}`;
  try {
    const endpoint = docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', docker('context', 'show').trim()).trim();
    assert.match(endpoint, /^unix:\/\//);
    const selectedDockerEnv = Object.fromEntries(Object.entries({ DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT }).filter(([, value]) => value !== undefined));
    const { app, bin } = await installPacked(root);
    const { ContainerLauncher, containerIdentity } = await import(`file://${join(app, 'src', 'container-launcher.mjs')}`);
    const workspace = join(root, 'unrelated-cwd');
    await mkdir(workspace);
    const help = spawnSync(join(bin, 'yolo'), ['--help'], { cwd: workspace, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: yolo/);
    const foreignId = docker('create', '--pull=never', '--name', foreignName, image, 'sleep', '60').trim();
    assert.match(foreignId, /^[a-f0-9]{64}$/i);
    const modes = ['rootless', 'darwin', 'rootful'];
    for (const mode of modes) {
      const log = join(root, `${mode}.jsonl`);
      const proxy = await writeDockerProxy(root, mode === 'darwin' ? 'darwin' : mode, log);
      const launcher = new ContainerLauncher({ image, workspace, command: proxy, hostPlatform: mode === 'darwin' ? 'darwin' : 'linux', timeoutMs: 15_000 });
      try {
        await launcher.launch({ prompt: `identity evidence ${mode}`, model: 'synthetic-model', deadline: Date.now() + 10_000, accessToken: 'synthetic-token', expiresAt: Date.now() + 20_000 });
      } catch {}
      const records = (await readFile(log, 'utf8').catch(error => { throw new Error(`${mode} produced no Docker trace: ${error.message}`); })).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const create = records.find(record => record.argv[0] === 'create');
      assert.ok(create, `${mode} must capture the production create argv`);
      assertContract(create, mode === 'darwin' ? 'darwin' : mode, selectedDockerEnv);
      const operations = records.map(record => record.argv[0]);
      for (const operation of ['info', 'create', 'inspect', 'start', 'stop', 'kill', 'rm']) assert.equal(operations.includes(operation), true, `${mode} must retain ${operation}`);
      if (mode === 'rootful') {
        assert.deepEqual(create.translatedArgv.slice(create.translatedArgv.indexOf('--user'), create.translatedArgv.indexOf('--user') + 2), ['--user', '0:0']);
        assert.equal(create.translatedArgv.includes('--group-add'), false);
      }
      assert.equal(docker('ps', '-aq', '--no-trunc', '--filter', `name=^/${foreignName}$`).trim(), foreignId);
    }
    assert.equal(docker('ps', '-aq', '--no-trunc', '--filter', `name=^/${foreignName}$`).trim(), foreignId, 'foreign resources survive fixture cleanup');
    docker('rm', '--force', foreignId);

    const historicalRoot = join(root, 'historical'); await mkdir(historicalRoot);
    const archive = execFileSync('git', ['archive', '637a4d9^', 'src', 'package.json'], { cwd: process.cwd() });
    const archivePath = join(root, 'historical.tar'); await writeFile(archivePath, archive);
    execFileSync('tar', ['-xf', archivePath, '-C', historicalRoot]);
    const old = await import(`file://${join(historicalRoot, 'src', 'container-launcher.mjs')}`);
    const darwinFacts = JSON.stringify({ OSType: 'linux', OperatingSystem: 'irrelevant', ClientInfo: { Context: 'irrelevant' }, SecurityOptions: ['name=seccomp,profile=builtin'] });
    await assert.rejects(old.containerIdentity('docker', undefined, { hostPlatform: 'darwin', operationFn: async () => darwinFacts }), /unsupported|verify/i);
    await assert.doesNotReject(containerIdentity('docker', undefined, { hostPlatform: 'darwin', operationFn: async () => darwinFacts }));
  } finally {
    try { docker('rm', '--force', foreignName); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});
