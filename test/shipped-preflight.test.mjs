import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { runtimeSourceIdentity } from '../src/cli.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const enabled = process.env.YOLO_REAL_DOCKER === '1';
const skip = !enabled;
const imageId = `sha256:${'a'.repeat(64)}`;

async function runCase(mode) {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-preflight-'));
  const workspace = join(root, 'workspace');
  const configHome = join(root, 'config');
  const dataHome = join(root, 'data');
  const bin = join(root, 'bin');
  const emptyBin = join(root, 'empty-bin');
  const log = join(root, 'docker-argv.jsonl');
  await Promise.all([
    mkdir(workspace),
    mkdir(join(configHome, 'yoloharness'), { recursive: true }),
    mkdir(join(dataHome, 'yoloharness'), { recursive: true }),
    mkdir(bin),
    mkdir(emptyBin),
  ]);
  const sourceIdentity = await runtimeSourceIdentity();
  await writeFile(join(configHome, 'yoloharness', 'config.json'), JSON.stringify({ version: 1, model: 'synthetic-model' }));
  await writeFile(join(dataHome, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId, ...sourceIdentity }));
  if (mode === 'unavailable-daemon') {
    await writeFile(join(configHome, 'yoloharness', 'credentials.json'), JSON.stringify({
      accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', clientId: 'synthetic-client', expiresAt: Date.now() + 1_800_000,
    }));
  }
  const wrapper = join(bin, 'docker');
  await writeFile(wrapper, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect' && ${JSON.stringify(mode)} === 'absent-image') {
  process.stderr.write('Error: No such image: ' + args.at(-1) + '\\n'); process.exit(1);
}
if (args[0] === 'info' && ${JSON.stringify(mode)} === 'unavailable-daemon') {
  process.stderr.write('Cannot connect to the Docker daemon\\n'); process.exit(1);
}
if (args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write(JSON.stringify({ Id: ${JSON.stringify(imageId)}, RepoTags: ['yoloharness-local:0.1.0'], Config: { Labels: { 'org.yoloharness.source-digest': ${JSON.stringify(sourceIdentity.sourceDigest)} }, Entrypoint: ['node', '/app/src/container-runtime.mjs'] } })); process.exit(0);
}
if (args[0] === 'info') { process.stdout.write(JSON.stringify(['name=rootless'])); process.exit(0); }
process.stderr.write('unexpected Docker operation: ' + args.join(' ') + '\\n'); process.exit(91);
`, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    YOLO_AUTH_FILE: mode === 'unavailable-daemon'
      ? join(configHome, 'yoloharness', 'credentials.json')
      : join(root, 'missing-credentials.json'),
    PATH: mode === 'unavailable-client' ? emptyBin : bin,
  };
  for (const key of ['DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
  const child = spawn(process.execPath, [cli, '--json', 'preflight probe'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const argv = await readFile(log, 'utf8').catch(() => '');
  await rm(root, { recursive: true, force: true });
  return { ...exit, stdout, stderr, argv };
}

test('WRC-03 unavailable Docker executable fails before image or credential handoff', { skip }, async () => {
  const result = await runCase('unavailable-client');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Docker executable was not found on PATH/);
  assert.equal(result.stdout, '');
  assert.equal(result.argv, '');
});

test('WRC-03 unavailable Docker daemon fails after image identity and before credentials', { skip }, async () => {
  const result = await runCase('unavailable-daemon');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Docker operation failed|Cannot connect to the Docker daemon/);
  assert.match(result.argv, /\["image","inspect"/);
  assert.match(result.argv, /\["info"/);
  assert.doesNotMatch(result.argv, /create|start/);
  assert.doesNotMatch(result.stderr, /synthetic-access-token|refresh-token/);
});

test('WRC-03 absent configured image fails before credentials or runtime start', { skip }, async () => {
  const result = await runCase('absent-image');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No such image/);
  assert.match(result.argv, /\["image","inspect"/);
  assert.doesNotMatch(result.argv, /info|create|start/);
  assert.doesNotMatch(result.stderr, /synthetic-access-token|refresh-token/);
});

test('WRC-03 valid client daemon and image control reaches credential boundary without handoff', { skip }, async () => {
  const result = await runCase('valid');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no usable credentials; run `yolo auth login`/);
  assert.match(result.argv, /\["image","inspect"/);
  assert.doesNotMatch(result.argv, /\["info"/);
  assert.doesNotMatch(result.argv, /create|start/);
  assert.doesNotMatch(result.stderr, /synthetic-access-token|refresh-token/);
});
