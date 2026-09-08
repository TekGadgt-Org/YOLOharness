import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ContainerLauncher, validateWorkspace, decodeMountInfoTargets, containerIdentity } from '../src/container-launcher.mjs';
import { configuredImage, runtimeSourceIdentity } from '../src/cli.mjs';
import { RUNTIME_RESOURCE_POLICY } from '../src/resource-policy.mjs';

test('runtime resource policy reserves bounded scratch for offline package-manager installs', () => {
  assert.deepEqual(RUNTIME_RESOURCE_POLICY, {
    tmpfs: '256m',
    homeTmpfs: '64m',
    memory: '512m',
    pids: '128',
    cpus: '1',
  });
});

const child = (onCreate) => {
  const listeners = new Map();
  const value = {
    stdout: { on() {} }, stderr: { on() {} }, stdin: { end() {} },
    kill() { setImmediate(() => listeners.get('close')?.(137)); },
    once(event, fn) { listeners.set(event, fn); },
  };
  onCreate?.(value);
  return value;
};

test('launcher never starts a container after create is cancelled', async () => {
  const workspace = await mkdtemp('/tmp/yolo-launcher-cancel-');
  const controller = new AbortController();
  const operations = [];
  try {
    const launcher = new ContainerLauncher({ image: 'sha256:' + 'a'.repeat(64), workspace, timeoutMs: 1000, spawn: (_command, args) => {
      operations.push(args[0]);
      if (args[0] === 'info') return { stdout: { on(event, fn) { if (event === 'data') setImmediate(() => fn(JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=rootless'] }))); } }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { if (event === 'close') setImmediate(() => fn(0)); } };
      if (args[0] === 'ps') return { stdout: { on() {} }, stderr: { on() {} }, once(event, fn) { if (event === 'close') setImmediate(() => fn(0)); } };
      if (args[0] === 'create') {
        const created = child();
        setImmediate(() => { controller.abort(new Error('cancelled during create')); created.kill('SIGKILL'); });
        return created;
      }
      throw new Error('start must not run after cancellation');
    } });
    await assert.rejects(launcher.launch({ prompt: 'synthetic' }, { signal: controller.signal }), /cancelled during create|docker operation failed|cleanup_unknown/);
    assert.equal(operations[0], 'info');
    assert.equal(operations[1], 'create');
    assert.ok(operations.filter(operation => operation === 'ps').length >= 8);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

async function uncertainCreateFixture({ failure = 'cancel', appearAfter = 8 } = {}) {
  const workspace = await mkdtemp('/tmp/yolo-launcher-uncertain-');
  const controller = new AbortController();
  const operations = [];
  let psCount = 0;
  let removed = 0;
  let ownedName;
  let ownedLabel;
  const ownedId = 'deadbeef'.repeat(8);
  const spawn = (_command, args) => {
    const operation = args[0]; operations.push(operation);
    const listeners = new Map();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const result = {
      stdout, stderr, stdin: { end() {} },
      kill() { setImmediate(() => listeners.get('close')?.(137)); },
      once(event, fn) { listeners.set(event, fn); },
    };
    if (operation === 'info') {
      setImmediate(() => stdout.emit('data', JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=rootless'] })));
      setImmediate(() => listeners.get('close')?.(0));
    } else if (operation === 'create') {
      ownedName = args[args.indexOf('--name') + 1];
      ownedLabel = args[args.indexOf('--label') + 1].split('=').slice(1).join('=');
      if (failure === 'stdout') setImmediate(() => stdout.emit('data', 'x'.repeat(1024 * 1024 + 1)));
      if (failure === 'stderr') setImmediate(() => stderr.emit('data', 'x'.repeat(1024 * 1024 + 1)));
      if (failure === 'nonzero') setImmediate(() => listeners.get('close')?.(17));
      if (failure === 'cancel') setImmediate(() => { controller.abort(new Error('cancelled during create')); result.kill(); });
      // timeout intentionally leaves create open until launch's deadline kills it.
    } else if (operation === 'ps') {
      psCount += 1;
      if (removed === 0 && psCount >= appearAfter) setImmediate(() => stdout.emit('data', `${ownedId}\n`));
      setImmediate(() => listeners.get('close')?.(0));
    } else if (operation === 'kill' || operation === 'rm') {
      if (operation === 'rm') removed += 1;
      setImmediate(() => listeners.get('close')?.(0));
    } else if (operation === 'inspect') {
      if (removed === 0) {
        setImmediate(() => stdout.emit('data', JSON.stringify({ Id: ownedId, Name: `/${ownedName}`, Config: { Labels: { 'yoloharness.run': ownedLabel } } })));
        setImmediate(() => listeners.get('close')?.(0));
      } else {
        setImmediate(() => stderr.emit('data', `Error: No such container: ${ownedId}`));
        setImmediate(() => listeners.get('close')?.(1));
      }
    } else {
      throw new Error(`unexpected docker operation: ${operation}`);
    }
    return result;
  };
  const launcher = new ContainerLauncher({ image: 'sha256:' + 'f'.repeat(64), workspace, timeoutMs: failure === 'timeout' ? 30 : 1000, spawn });
  try {
    await assert.rejects(launcher.launch({ prompt: `uncertain-${failure}` }, { signal: controller.signal }), /cleanup_unknown|docker operation failed|cancelled|deadline|output limit/);
    assert.ok(psCount >= appearAfter, `${failure} reconciled before delayed appearance`);
    assert.equal(removed, 1, `${failure} did not remove the exact discovered ID`);
    assert.equal(operations.includes('start'), false, `${failure} unexpectedly started a container`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test('uncertain create cancellation reconciles a delayed daemon appearance with no returned ID', async () => {
  await uncertainCreateFixture({ failure: 'cancel' });
});

test('uncertain create timeout reconciles a delayed daemon appearance with no returned ID', async () => {
  await uncertainCreateFixture({ failure: 'timeout' });
});

test('uncertain create stdout overflow reconciles a delayed daemon appearance with no returned ID', async () => {
  await uncertainCreateFixture({ failure: 'stdout' });
});

test('uncertain create stderr overflow and nonzero create reconcile delayed daemon appearances with no returned ID', async (t) => {
  await t.test('stderr overflow', () => uncertainCreateFixture({ failure: 'stderr' }));
  await t.test('nonzero create', () => uncertainCreateFixture({ failure: 'nonzero' }));
});

test('production launcher has no caller-selectable network or endpoint policy', () => {
  const launcher = new ContainerLauncher({ image: 'sha256:' + 'd'.repeat(64), network: 'synthetic-network', responsesUrl: 'http://synthetic-provider/responses', testOnly: true });
  assert.equal(Object.hasOwn(launcher, 'network'), false);
  assert.equal(Object.hasOwn(launcher, 'responsesUrl'), false);
  assert.equal(Object.hasOwn(launcher, 'testOnly'), false);
});

test('launcher rejects a Docker create ID that is not the exact owned name and label', async () => {
  const workspace = await mkdtemp('/tmp/yolo-foreign-id-');
  const operations = [];
  try {
    const launcher = new ContainerLauncher({ image: 'sha256:' + '9'.repeat(64), workspace, timeoutMs: 1000, spawn: (_command, args) => {
      operations.push(args[0]);
      const listeners = new Map();
      const foreignId = 'abcdef'.repeat(10) + 'abcd';
      const output = args[0] === 'info' ? JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=rootless'] }) : args[0] === 'create' ? foreignId : JSON.stringify([{ Id: foreignId, Name: '/foreign', Config: { Labels: { 'yoloharness.run': 'other' } } }]);
      const error = args[0] === 'inspect' ? '' : '';
      return { stdout: { on(event, fn) { if (event === 'data') setImmediate(() => fn(output)); } }, stderr: { on(event, fn) { if (event === 'data' && error) setImmediate(() => fn(error)); } }, stdin: { end() {} }, kill() {}, once(event, fn) { listeners.set(event, fn); if (event === 'close') setImmediate(() => fn(args[0] === 'inspect' ? 0 : 0)); } };
    } });
    await assert.rejects(launcher.launch({ prompt: 'foreign' }), /ownership|cleanup_unknown|container/i);
    assert.equal(operations.includes('start'), false);
    assert.equal(operations.includes('kill'), false);
    assert.equal(operations.includes('rm'), false);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('uncertain create waits for stable absence and removes a delayed daemon container', async () => {
  const workspace = await mkdtemp('/tmp/yolo-launcher-delayed-create-');
  const operations = [];
  let psCount = 0;
  let ownedName;
  let ownedLabel;
  let removed = false;
  try {
    const launcher = new ContainerLauncher({ image: 'sha256:' + 'c'.repeat(64), workspace, timeoutMs: 1000, spawn: (_command, args) => {
      const quick = (code = 0) => ({ stdout: { on() {} }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { if (event === 'close') setImmediate(() => fn(code)); } });
      operations.push(args[0]);
      if (args[0] === 'info') return { stdout: { on(event, fn) { if (event === 'data') setImmediate(() => fn(JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=rootless'] }))); } }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { if (event === 'close') setImmediate(() => fn(0)); } };
      if (args[0] === 'create') { ownedName = args[args.indexOf('--name') + 1]; ownedLabel = args[args.indexOf('--label') + 1].split('=').slice(1).join('='); const created = child(); setImmediate(() => created.kill('SIGKILL')); return created; }
      if (args[0] === 'ps') {
        const listeners = new Map();
        const result = { stdout: { on() {} }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { listeners.set(event, fn); } };
        psCount += 1;
        result.stdout.on = (event, fn) => { if (event === 'data' && psCount === 2) setImmediate(() => fn(`${'deadbeef'.repeat(8)}\n`)); };
        setTimeout(() => listeners.get('close')?.(0), 5); return result;
      }
      if (args[0] === 'kill' || args[0] === 'rm') { if (args[0] === 'rm') removed = true; return quick(); }
      if (args[0] === 'inspect') {
        const listeners = new Map();
        const result = removed
          ? { stdout: { on() {} }, stderr: { on(event, fn) { if (event === 'data') setImmediate(() => fn('Error: No such container')); } }, stdin: { end() {} }, kill() {}, once(event, fn) { listeners.set(event, fn); } }
          : { stdout: { on(event, fn) { if (event === 'data') setImmediate(() => fn(JSON.stringify({ Id: 'deadbeef'.repeat(8), Name: `/${ownedName}`, Config: { Labels: { 'yoloharness.run': ownedLabel } } }))); } }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { listeners.set(event, fn); } };
        setImmediate(() => listeners.get('close')?.(removed ? 1 : 0)); return result;
      }
      throw new Error(`unexpected docker operation: ${args[0]}`);
    } });
    await assert.rejects(launcher.launch({ prompt: 'delayed' }), /docker operation failed|cleanup_unknown|ownership|cancelled|deadline/);
    assert.ok(psCount >= 2);
    assert.equal(operations.includes('start'), false);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('uncertain create proves stable absence after the bounded reconciliation budget', async () => {
  const workspace = await mkdtemp('/tmp/yolo-launcher-full-grace-');
  let firstPsAt;
  let lastPsAt;
  try {
    const launcher = new ContainerLauncher({ image: 'sha256:' + 'e'.repeat(64), workspace, timeoutMs: 1000, spawn: (_command, args) => {
      const listeners = new Map();
      const quick = (code = 0, output = '') => ({ stdout: { on(event, fn) { if (event === 'data' && output) setImmediate(() => fn(output)); } }, stderr: { on() {} }, stdin: { end() {} }, kill() {}, once(event, fn) { listeners.set(event, fn); if (event === 'close') setImmediate(() => fn(code)); } });
      if (args[0] === 'info') return quick(0, JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=rootless'] }));
      if (args[0] === 'create') return { stdout: { on() {} }, stderr: { on() {} }, stdin: { end() {} }, kill() { setImmediate(() => listeners.get('close')?.(137)); }, once(event, fn) { listeners.set(event, fn); } };
      if (args[0] === 'ps') { const now = Date.now(); firstPsAt ??= now; lastPsAt = now; return quick(); }
      throw new Error(`unexpected docker operation: ${args[0]}`);
    } });
    await assert.rejects(launcher.launch({ prompt: 'grace' }), error => {
      assert.notEqual(error.code, 'cleanup_unknown');
      return /docker operation failed|cancelled|deadline/.test(error.message);
    });
    assert.ok(lastPsAt - firstPsAt >= 950, `reconciliation lasted ${lastPsAt - firstPsAt}ms`);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('workspace validation rejects nested mount points and multiply-linked files', async () => {
  const workspace = await mkdtemp('/tmp/yolo-workspace-check-');
  const outside = await mkdtemp('/tmp/yolo-workspace-outside-');
  try {
    const file = join(outside, 'outside.txt'); await writeFile(file, 'sentinel');
    await link(file, join(workspace, 'alias.txt'));
    await assert.rejects(validateWorkspace(workspace), /multiply-linked/);
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('workspace validation allows Docker-managed known container symlink targets', async () => {
  const workspace = await mkdtemp('/tmp/yolo-workspace-container-target-');
  try {
    await symlink('/etc/hosts', join(workspace, 'container-known-target'));
    assert.equal(await validateWorkspace(workspace), workspace);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('mountinfo decoding preserves escaped newline targets for nested-mount checks', () => {
  const source = '/tmp/project';
  const targets = decodeMountInfoTargets(`42 35 0:1 / ${source}\\012nested - overlay overlay rw`);
  assert.deepEqual(targets, [`${source}\nnested`]);
});

test('rootful-shaped Docker security options select the host numeric identity and groups', async () => {
  const identity = await containerIdentity('docker', undefined, {
    getuid: () => 1234, getgid: () => 2345, getgroups: () => [2345, 3456, 3456],
    operationFn: async () => JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=seccomp,profile=builtin'] }),
  });
  assert.deepEqual(identity, { uid: 1234, gid: 2345, groups: [3456], rootless: false });
});

test('rootless Docker keeps container root mapping and does not add host groups', async () => {
  const identity = await containerIdentity('docker', undefined, {
    getuid: () => 1234, getgid: () => 2345, getgroups: () => [2345, 3456],
    operationFn: async () => JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=rootless', 'name=seccomp,profile=builtin'] }),
  });
  assert.deepEqual(identity, { uid: 0, gid: 0, groups: [], rootless: true });
});

test('Docker identity rejects malformed info and user namespace remapping specifically', async () => {
  await assert.rejects(containerIdentity('docker', undefined, { operationFn: async () => 'not-json' }), /malformed|unable to verify Docker security mode/i);
  await assert.rejects(containerIdentity('docker', undefined, { operationFn: async () => JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=userns'] }) }), /user.?namespace remapping|unsupported/i);
});

test('Docker identity accepts vendor-neutral macOS Linux-daemon facts as container root', async () => {
  const identity = await containerIdentity('docker', undefined, {
    hostPlatform: 'darwin',
    operationFn: async () => JSON.stringify({
      OSType: 'linux', OperatingSystem: 'Colima',
      ClientInfo: { Context: 'colima' }, SecurityOptions: ['name=seccomp,profile=builtin'],
    }),
    getuid: () => 1234, getgid: () => 2345, getgroups: () => [7, 8],
  });
  assert.deepEqual(identity, { uid: 0, gid: 0, groups: [], rootless: false });
});

test('macOS Linux-VM security facts remain supported, but native Linux userns remapping is rejected', async () => {
  const vm = await containerIdentity('docker', undefined, {
    hostPlatform: 'darwin',
    operationFn: async () => JSON.stringify({ OSType: 'linux', OperatingSystem: 'Docker Desktop', ClientInfo: { Context: 'desktop-linux' }, SecurityOptions: ['name=userns', 'name=seccomp,profile=builtin'] }),
  });
  assert.deepEqual(vm, { uid: 0, gid: 0, groups: [], rootless: false });
  await assert.rejects(containerIdentity('docker', undefined, { hostPlatform: 'linux', operationFn: async () => JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=userns'] }) }), /user.?namespace remapping|unsupported/i);
});

test('macOS identity rejects non-Linux and malformed daemon facts', async () => {
  for (const info of [
    { OSType: 'darwin', OperatingSystem: 'Colima', SecurityOptions: [] },
    { OSType: 'linux', OperatingSystem: 'Colima', SecurityOptions: 'bad' },
    ['name=seccomp,profile=builtin'],
  ]) await assert.rejects(containerIdentity('docker', undefined, { hostPlatform: 'darwin', operationFn: async () => JSON.stringify(info) }), /unsupported|malformed/i);
});

test('old rootless-only behavior is a regression control on macOS Linux VM runtimes', async () => {
  await assert.doesNotReject(containerIdentity('docker', undefined, {
    hostPlatform: 'darwin', operationFn: async () => JSON.stringify({ OSType: 'linux', OperatingSystem: 'Colima', ClientInfo: { Context: 'colima' }, SecurityOptions: ['name=rootless'] }),
  }));
});

test('macOS Linux-daemon consumer create argv uses 0:0 without supplementary groups', async () => {
  const workspace = await mkdtemp('/tmp/yolo-macos-linux-daemon-argv-');
  const id = 'abcdef0123456789'.repeat(4); let createArgs;
  try {
    const spawn = (_command, args) => {
      const listeners = new Map(); const stdout = new EventEmitter(); const stderr = new EventEmitter();
      const result = { stdout, stderr, stdin: { end() {} }, kill() { setImmediate(() => listeners.get('close')?.(137)); }, once(event, fn) { listeners.set(event, fn); } };
      const close = code => setImmediate(() => listeners.get('close')?.(code));
      if (args[0] === 'info') { setImmediate(() => stdout.emit('data', JSON.stringify({ OSType: 'linux', OperatingSystem: 'Colima', ClientInfo: { Context: 'colima' }, SecurityOptions: ['name=userns'] }))); close(0); }
      else if (args[0] === 'create') { createArgs = args; setImmediate(() => stdout.emit('data', id)); close(0); }
      else if (args[0] === 'inspect' && !createArgs?._cleaned) { setImmediate(() => stdout.emit('data', JSON.stringify({ Id: id, Name: `/${createArgs[createArgs.indexOf('--name') + 1]}`, Config: { Labels: { 'yoloharness.run': createArgs[createArgs.indexOf('--label') + 1].split('=').slice(1).join('=') } } }))); close(0); }
      else if (args[0] === 'start') { setImmediate(() => stdout.emit('data', '{"version":1,"status":"completed","effect_state":"none","result":"ok","evidence":[],"artifacts":[]}\n')); close(0); }
      else if (args[0] === 'stop' || args[0] === 'kill') close(0);
      else if (args[0] === 'rm') { createArgs._cleaned = true; close(0); }
      else if (args[0] === 'inspect') { setImmediate(() => stderr.emit('data', `Error: No such container: ${id}`)); close(1); }
      return result;
    };
    const launcher = new ContainerLauncher({ image: `sha256:${'d'.repeat(64)}`, workspace, spawn, hostPlatform: 'darwin' });
    assert.equal((await launcher.launch({ prompt: 'linux-daemon', model: 'synthetic-model', deadline: Date.now() + 10_000, accessToken: 'synthetic-access', expiresAt: Date.now() + 20_000 })).result, 'ok');
    assert.equal(createArgs[createArgs.indexOf('--user') + 1], '0:0');
    assert.equal(createArgs.includes('--group-add'), false);
    assert.match(createArgs[createArgs.indexOf('--tmpfs') + 1], new RegExp(`size=${RUNTIME_RESOURCE_POLICY.tmpfs}.*uid=0,gid=0,mode=700`));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('Docker identity accepts the maximum Docker numeric identity and rejects invalid boundaries', async () => {
  const info = JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=seccomp,profile=builtin'] });
  const valid = await containerIdentity('docker', undefined, { operationFn: async () => info, getuid: () => 2147483647, getgid: () => 2147483647, getgroups: () => [0, 2147483647] });
  assert.deepEqual(valid, { uid: 2147483647, gid: 2147483647, groups: [0], rootless: false });
  for (const value of [-1, 2147483648, 1.5, NaN, Infinity]) {
    await assert.rejects(containerIdentity('docker', undefined, { operationFn: async () => info, getuid: () => value, getgid: () => 1, getgroups: () => [0] }), /invalid host numeric identity/);
    await assert.rejects(containerIdentity('docker', undefined, { operationFn: async () => info, getuid: () => 1, getgid: () => value, getgroups: () => [0] }), /invalid host numeric identity/);
    await assert.rejects(containerIdentity('docker', undefined, { operationFn: async () => info, getuid: () => 1, getgid: () => 1, getgroups: () => [value] }), /invalid host numeric identity/);
  }
});

test('host root under standard Docker remains explicit numeric 0:0 identity', async () => {
  const identity = await containerIdentity('docker', undefined, {
    getuid: () => 0, getgid: () => 0, getgroups: () => [0, 7],
    operationFn: async () => JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: [] }),
  });
  assert.deepEqual(identity, { uid: 0, gid: 0, groups: [7], rootless: false });
});

test('rootful consumer create argv carries selected ownership without duplicate primary group', async () => {
  const workspace = await mkdtemp('/tmp/yolo-rootful-argv-');
  const id = '0123456789abcdef'.repeat(4);
  let createArgs;
  try {
    const spawn = (_command, args) => {
      const listeners = new Map(); const stdout = new EventEmitter(); const stderr = new EventEmitter();
      const result = { stdout, stderr, stdin: { end() {} }, kill() { setImmediate(() => listeners.get('close')?.(137)); }, once(event, fn) { listeners.set(event, fn); } };
      const close = code => setImmediate(() => listeners.get('close')?.(code));
      if (args[0] === 'info') { setImmediate(() => stdout.emit('data', JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=seccomp,profile=builtin'] }))); close(0); }
      else if (args[0] === 'create') { createArgs = args; setImmediate(() => stdout.emit('data', id)); close(0); }
      else if (args[0] === 'inspect' && !createArgs?._cleaned) { setImmediate(() => stdout.emit('data', JSON.stringify({ Id: id, Name: `/${createArgs[createArgs.indexOf('--name') + 1]}`, Config: { Labels: { 'yoloharness.run': createArgs[createArgs.indexOf('--label') + 1].split('=').slice(1).join('=') } } }))); close(0); }
      else if (args[0] === 'start') { setImmediate(() => stdout.emit('data', '{"version":1,"status":"completed","effect_state":"none","result":"ok","evidence":[],"artifacts":[]}\n')); close(0); }
      else if (args[0] === 'stop' || args[0] === 'kill') close(0);
      else if (args[0] === 'rm') { createArgs._cleaned = true; close(0); }
      else if (args[0] === 'inspect') { setImmediate(() => stderr.emit('data', `Error: No such container: ${id}`)); close(1); }
      else throw new Error(`unexpected Docker operation: ${args[0]}`);
      return result;
    };
    const launcher = new ContainerLauncher({ image: `sha256:${'a'.repeat(64)}`, workspace, spawn });
    const record = await launcher.launch({ prompt: 'rootful', model: 'synthetic-model', deadline: Date.now() + 10_000, accessToken: 'synthetic-access', expiresAt: Date.now() + 20_000 });
    assert.equal(record.result, 'ok');
    const groups = createArgs.filter((value, index) => value === '--group-add' ? createArgs[index + 1] : null).filter(Boolean);
    assert.equal(groups.includes(String(process.getgid())), false);
    assert.match(createArgs[createArgs.indexOf('--tmpfs') + 1], new RegExp(`size=${RUNTIME_RESOURCE_POLICY.tmpfs}.*uid=${process.getuid()},gid=${process.getgid()},mode=700`));
    assert.match(createArgs[createArgs.indexOf('--tmpfs', createArgs.indexOf('--tmpfs') + 1) + 1], new RegExp(`size=${RUNTIME_RESOURCE_POLICY.homeTmpfs}.*uid=${process.getuid()},gid=${process.getgid()},mode=700`));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('runtime source identity is a versioned sha256 digest', async () => {
  const identity = await runtimeSourceIdentity();
  assert.match(identity.sourceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(identity.sourceVersion, '0.1.1');
});

test('configured image requires the complete versioned source-identity metadata', async () => {
  const data = await mkdtemp('/tmp/yolo-image-metadata-');
  const old = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  try {
    await mkdir(join(data, 'yoloharness'), { recursive: true });
    const identity = await runtimeSourceIdentity();
    const imageId = `sha256:${'a'.repeat(64)}`;
    await writeFile(join(data, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId, ...identity }));
    assert.equal(await configuredImage({ inspect: async () => JSON.stringify({ Id: imageId, RepoTags: ['yoloharness-local:0.1.1'], Config: { Labels: { 'org.yoloharness.source-digest': identity.sourceDigest }, Entrypoint: ['node', '/app/src/container-runtime.mjs'] } }) }), imageId);
  } finally {
    if (old === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = old;
    await rm(data, { recursive: true, force: true });
  }
});

test('configured image rejects an image whose embedded source digest is stale', async () => {
  const data = await mkdtemp('/tmp/yolo-stale-image-');
  const oldData = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  try {
    const identity = await runtimeSourceIdentity();
    await mkdir(join(data, 'yoloharness'), { recursive: true });
    const imageId = `sha256:${'a'.repeat(64)}`;
    await writeFile(join(data, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId, ...identity }));
    await assert.rejects(
      configuredImage({ inspect: async () => JSON.stringify({ Id: imageId, RepoTags: ['yoloharness-local:0.1.1'], Config: { Labels: { 'org.yoloharness.source-digest': `sha256:${'b'.repeat(64)}` }, Entrypoint: ['node', '/app/src/container-runtime.mjs'] } }) }),
      /source digest/i,
    );
  } finally {
    if (oldData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldData;
    await rm(data, { recursive: true, force: true });
  }
});

test('configured image rejects a coherent old 0.1.0 tag even when its ID and source digest match', async () => {
  const data = await mkdtemp('/tmp/yolo-old-image-tag-');
  const oldData = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  try {
    const identity = await runtimeSourceIdentity();
    await mkdir(join(data, 'yoloharness'), { recursive: true });
    const imageId = `sha256:${'c'.repeat(64)}`;
    await writeFile(join(data, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId, ...identity }));
    await assert.rejects(
      configuredImage({ inspect: async () => JSON.stringify({ Id: imageId, RepoTags: ['yoloharness-local:0.1.0'], Config: { Labels: { 'org.yoloharness.source-digest': identity.sourceDigest }, Entrypoint: ['node', '/app/src/container-runtime.mjs'] } }) }),
      /installation-owned image tag/,
    );
  } finally {
    if (oldData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldData;
    await rm(data, { recursive: true, force: true });
  }
});

test('launcher uses one absolute deadline and does not create after slow preflight', async () => {
  const workspace = await mkdtemp('/tmp/yolo-workspace-deadline-');
  const operations = [];
  try {
    const launcher = new ContainerLauncher({ image: 'sha256:' + 'b'.repeat(64), workspace, timeoutMs: 10, spawn: (_command, args) => {
      operations.push(args[0]);
      const listeners = new Map();
      return { stdout: { on(event, fn) { if (event === 'data') setTimeout(() => fn('[\"name=rootless\"]'), 20); } }, stderr: { on() {} }, stdin: { end() {} }, kill() { setImmediate(() => listeners.get('close')?.(137)); }, once(event, fn) { listeners.set(event, fn); if (event === 'close') setTimeout(() => fn(0), 25); } };
    } });
    await assert.rejects(launcher.launch({ prompt: 'slow' }), /cleanup_unknown|deadline|operation/);
    assert.deepEqual(operations, ['info']);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('abort starts exact cleanup while an attach client never closes', async () => {
  const workspace = await mkdtemp('/tmp/yolo-launcher-stuck-attach-');
  const controller = new AbortController();
  const operations = [];
  const ownedId = '0123456789abcdef'.repeat(4);
  let ownedName;
  let ownedLabel;
  let cleanupStarted;
  let cleanupCount = 0;
  try {
    const spawn = (_command, args) => {
      const operation = args[0]; operations.push(operation);
      const listeners = new Map();
      const stdout = new EventEmitter(); const stderr = new EventEmitter();
      const result = {
        stdout, stderr, stdin: { end() {} },
        kill() { if (operation === 'start') cleanupStarted ??= Date.now(); },
        once(event, fn) { listeners.set(event, fn); },
      };
      const close = code => setImmediate(() => listeners.get('close')?.(code));
      if (operation === 'info') { setImmediate(() => stdout.emit('data', JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', SecurityOptions: ['name=rootless'] }))); close(0); }
      else if (operation === 'create') { ownedName = args[args.indexOf('--name') + 1]; ownedLabel = args[args.indexOf('--label') + 1].split('=').slice(1).join('='); setImmediate(() => stdout.emit('data', ownedId)); close(0); }
      else if (operation === 'inspect' && cleanupCount === 0) { setImmediate(() => stdout.emit('data', JSON.stringify({ Id: ownedId, Name: `/${ownedName}`, Config: { Labels: { 'yoloharness.run': ownedLabel } } }))); close(0); }
      else if (operation === 'start') { setImmediate(() => { stdout.emit('data', JSON.stringify({ version: 1, run_id: 'run-partial', status: 'deadline', effect_state: 'uncertain', result: 'partial answer', evidence: [], artifacts: [], errors: ['deadline exceeded'] }) + '\n'); controller.abort(new Error('stuck attach cancellation')); }); }
      else if (operation === 'kill') { cleanupCount += 1; close(0); }
      else if (operation === 'rm') { cleanupCount += 1; close(0); }
      else if (operation === 'inspect') { setImmediate(() => { stderr.emit('data', 'Error: No such container: ' + ownedId); close(1); }); }
      return result;
    };
    const launcher = new ContainerLauncher({ image: 'sha256:' + 'a'.repeat(64), workspace, spawn, timeoutMs: 1000 });
    const result = await launcher.launch({ prompt: 'stuck attach', model: 'synthetic-model', deadline: Date.now() + 10_000, accessToken: 'synthetic-access', expiresAt: Date.now() + 20_000 }, { signal: controller.signal });
    assert.equal(result.status, 'interrupted');
    assert.equal(result.result, 'partial answer');
    assert.equal(result.effect_state, 'uncertain');
    assert.ok(cleanupStarted, 'cleanup did not start while attach remained open');
    assert.ok(operations.includes('stop'), 'abort must gracefully stop the owned runtime before hard cleanup');
    assert.equal(operations.filter(operation => operation === 'rm').length, 1);
    assert.equal(cleanupCount, 2, 'exact cleanup should issue one kill and one rm');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
