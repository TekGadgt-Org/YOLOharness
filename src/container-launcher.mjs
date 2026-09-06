import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, readdir, lstat, readFile, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { encodeBootstrap } from './bootstrap.mjs';
import { snapshotSkills } from './skills.mjs';

const MAX_OUTPUT = 1024 * 1024;
const OP_TIMEOUT = 10_000;
const CLEANUP_TOTAL_MS = 1500;
const CLEANUP_STABLE_ABSENCE_MS = 500;
const CLEANUP_POLL_MS = 50;
// These paths are materialized by Docker inside every container and therefore
// cannot be resolved from the host before the workspace bind is created.
const KNOWN_CONTAINER_SYMLINK_TARGETS = new Set(['/etc/hosts', '/etc/hostname', '/etc/resolv.conf']);
// The invoker-selected Docker client/context is trusted host setup.  The
// environment is used only by the Docker client and never passed to the
// runtime container.
const DOCKER_ENV = () => ({ ...process.env });

export class ContainerLauncher {
  constructor({ image, workspace = process.cwd(), command = 'docker', spawn = nodeSpawn, timeoutMs = 600000 } = {}) {
    if (!image || !workspace) throw new TypeError('container image and workspace are required');
    this.image = image; this.workspace = workspace; this.command = command; this.spawn = spawn; this.timeoutMs = timeoutMs;
  }

  async launch(bootstrap, { signal } = {}) {
    const startedAt = Date.now();
    const deadline = startedAt + this.timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    if (signal?.aborted) throw signal.reason;
    const source = await validateWorkspace(this.workspace, { signal, deadline });
    if (signal?.aborted) throw signal.reason;
    if (Date.now() >= deadline) throw Object.assign(new Error('container deadline exceeded'), { code: 'deadline' });
    const name = `yoloharness-${randomUUID()}`;
    const label = randomUUID();
    const identity = await containerIdentity(this.command, this.spawn, { signal, timeoutMs: remaining() });
    if (signal?.aborted) throw signal.reason;
    if (Date.now() >= deadline) throw Object.assign(new Error('container deadline exceeded'), { code: 'deadline' });
    const args = ['create', '--pull=never', '--name', name, '--label', `yoloharness.run=${label}`, '--init', '-i', '--user', `${identity.uid}:${identity.gid}`, '--network', 'bridge', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--tmpfs', '/home/worker:rw,noexec,nosuid,size=16m', '--mount', `type=bind,src=${source},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--workdir', '/workspace', '--env', 'HOME=/home/worker', '--env', 'XDG_CONFIG_HOME=/home/worker/.config', '--env', 'XDG_DATA_HOME=/home/worker/.local/share', this.image, 'node', '/app/src/container-runtime.mjs'];
    let id;
    let attached;
    let creating;
    let createAttempted = false;
    let owned = false;
    let reason;
    let abortCleanup;
    const abort = (abortReason = signal?.reason ?? Object.assign(new Error('container interrupted'), { code: 'interrupted' })) => {
      reason = abortReason;
      creating?.kill('SIGKILL'); attached?.kill('SIGKILL');
      // Do not wait for docker attach to observe EOF: a descendant can keep
      // that pipe open after the attach client is killed. Stop the owned
      // container immediately so it cannot write to the workspace later.
      if (id && owned && !abortCleanup) abortCleanup = cleanup(this.command, id, name, label, this.spawn);
    };
    const timer = setTimeout(() => abort(Object.assign(new Error('container deadline exceeded'), { code: 'deadline' })), remaining());
    signal?.addEventListener('abort', abort, { once: true });
    try {
      createAttempted = true;
      const create = operation(this.command, args, this.spawn, { timeoutMs: remaining(), signal });
      creating = create.child;
      id = (await create.promise).trim();
      if (!/^[a-f0-9]{64}$/i.test(id)) throw new Error('docker did not return a full container ID');
      if (reason || signal?.aborted) throw reason ?? signal.reason;
      creating = null;
      if (Date.now() >= deadline) throw Object.assign(new Error('container deadline exceeded'), { code: 'deadline' });
      id = await verifyOwnedContainer(this.command, id, name, label, this.spawn);
      owned = true;
      attached = this.spawn(this.command, ['start', '--attach', '--interactive', id], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: DOCKER_ENV() });
      const result = await attachedOperation(attached, encodeBootstrap({ ...bootstrap, skills: await snapshotSkills(source) }), signal);
      if (reason) return { version: 1, run_id: null, status: reason.code === 'deadline' ? 'deadline' : 'interrupted', result: null, evidence: [], artifacts: [], errors: [reason.message] };
      if (result.overflow) throw Object.assign(new Error('container output limit exceeded'), { code: 'output_limit' });
      if (result.code !== 0) throw new Error(result.err.trim() || `container exited (${result.code})`);
      const lines = result.out.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length !== 1) throw new Error('container returned malformed status');
      return JSON.parse(lines[0]);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (abortCleanup) await abortCleanup;
      else if (id && owned) await cleanup(this.command, id, name, label, this.spawn);
      else if (createAttempted) await reconcileUnknownCreate(this.command, name, label, this.spawn);
    }
  }
}

async function containerIdentity(command, spawn, opts) {
  const result = await operation(command, ['info', '--format', '{{json .SecurityOptions}}'], spawn, opts).promise;
  let options;
  try { options = JSON.parse(result.trim()); } catch { throw new Error('unable to verify Docker rootless mode'); }
  if (!Array.isArray(options) || !options.some(value => value === 'name=rootless')) throw new Error('refusing launch: Docker rootless mode was not verified');
  // The approved compatibility exception uses the rootless daemon's UID 0
  // mapping. This is not acceptable for rootful or unknown Docker, which was
  // rejected above; no host chmod/chown is needed for normal project binds.
  return { uid: 0, gid: 0 };
}

function operation(command, args, spawn, { timeoutMs = OP_TIMEOUT, signal } = {}) {
  let child;
  const promise = new Promise((resolve, reject) => {
    let out = ''; let err = ''; let done = false; let terminalError; let abort = () => {};
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const terminate = error => { terminalError = error; child?.kill('SIGKILL'); };
    const timer = setTimeout(() => terminate(new Error('docker operation deadline exceeded')), Math.min(timeoutMs, OP_TIMEOUT));
    try { child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: DOCKER_ENV() }); }
    catch (error) { finish(reject, error); return; }
    child.stdout?.on('data', chunk => { out += String(chunk); if (Buffer.byteLength(out) > MAX_OUTPUT) terminate(new Error('docker output limit exceeded')); });
    child.stderr?.on('data', chunk => { err += String(chunk); if (Buffer.byteLength(err) > MAX_OUTPUT) terminate(new Error('docker output limit exceeded')); });
    abort = () => terminate(signal?.reason ?? new Error('docker operation cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => finish(reject, terminalError ?? error)); child.once('close', code => {
      if (terminalError) return finish(reject, Object.assign(terminalError, { dockerOutput: `${out}${err}`.trim() }));
      // Docker may have created the container before the client was killed. Preserve
      // a returned ID so the caller can still perform exact-ID cleanup.
      if (code !== 0 && /^[a-f0-9]{12,64}$/i.test(out.trim())) return finish(resolve, out);
      if (code === 0) finish(resolve, out); else finish(reject, Object.assign(new Error(`docker operation failed (${code}): ${err.trim()}`), { dockerOutput: `${out}${err}`.trim(), dockerExitCode: code }));
    });
  });
  return { promise, get child() { return child; } };
}

function attachedOperation(child, input, signal) {
  return new Promise((resolve, reject) => {
    let out = ''; let err = ''; let done = false; let overflow = false;
    const abort = () => { child.kill('SIGKILL'); finish(resolve, { code: null, out, err, overflow }); };
    const finish = (fn, value) => { if (done) return; done = true; signal?.removeEventListener('abort', abort); fn(value); };
    const collect = (which, chunk) => { const text = String(chunk); if (which === 'out') out += text; else err += text; if (Buffer.byteLength(which === 'out' ? out : err) > MAX_OUTPUT) { overflow = true; child.kill('SIGKILL'); } };
    child.stdout?.on('data', chunk => collect('out', chunk)); child.stderr?.on('data', chunk => collect('err', chunk));
    child.once('error', error => finish(reject, error)); child.once('close', code => finish(resolve, { code, out, err, overflow }));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    child.stdin?.end(input);
  });
}

async function reconcileUnknownCreate(command, name, label, spawn) {
  const startedAt = Date.now();
  let absentSince = null;
  while (Date.now() - startedAt < CLEANUP_TOTAL_MS) {
    let output;
    try { output = await operation(command, ['ps', '--all', '--no-trunc', '--quiet', '--filter', `label=yoloharness.run=${label}`, '--filter', `name=^/${name}$`], spawn).promise; }
    catch (error) { throw Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown', cause: error }); }
    const ids = output.trim().split(/\s+/).filter(id => /^[a-f0-9]{64}$/i.test(id));
    if (ids.length > 0) {
      absentSince = null;
      for (const id of ids) await cleanup(command, id, name, label, spawn);
    } else {
      absentSince ??= Date.now();
    }
    const remaining = CLEANUP_TOTAL_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(CLEANUP_POLL_MS, remaining)));
  }
  if (absentSince !== null && Date.now() - absentSince >= CLEANUP_STABLE_ABSENCE_MS) return;
  throw Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown' });
}

async function verifyOwnedContainer(command, id, name, label, spawn) {
  let output;
  try { output = await operation(command, ['inspect', '--format', '{{json .}}', id], spawn).promise; }
  catch (error) { throw Object.assign(new Error('container ownership could not be verified'), { code: 'cleanup_unknown', cause: error }); }
  let inspected;
  try { inspected = JSON.parse(output.trim()); } catch (error) { throw Object.assign(new Error('container ownership could not be verified'), { code: 'cleanup_unknown', cause: error }); }
  const labels = inspected?.Config?.Labels ?? {};
  if (!/^[a-f0-9]{64}$/i.test(inspected?.Id ?? '') || inspected.Id !== id || inspected?.Name !== `/${name}` || labels['yoloharness.run'] !== label) throw new Error(`container ownership mismatch (id=${inspected?.Id ?? 'missing'}, name=${inspected?.Name ?? 'missing'}, label=${labels['yoloharness.run'] ?? 'missing'})`);
  return inspected.Id;
}

async function cleanup(command, id, name, label, spawn) {
  if (typeof name === 'function') { spawn = name; name = null; label = null; }
  if (name && label) await verifyOwnedContainer(command, id, name, label, spawn);
  try { await operation(command, ['kill', '--signal', 'KILL', id], spawn).promise; } catch {}
  try { await operation(command, ['rm', '--force', id], spawn).promise; } catch (error) { throw Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown', cause: error }); }
  try { await operation(command, ['inspect', id], spawn).promise; throw new Error('cleanup_unknown'); } catch (error) {
    if (error.message === 'cleanup_unknown') throw error;
    const output = error.dockerOutput ?? '';
    if (!/no such (?:container|object)[: ]/i.test(output)) throw Object.assign(new Error('cleanup_unknown'), { cause: error });
  }
}

export async function validateWorkspace(workspace, { signal, deadline } = {}) {
  const check = () => { if (signal?.aborted) throw signal.reason; if (deadline && Date.now() >= deadline) throw Object.assign(new Error('container deadline exceeded'), { code: 'deadline' }); };
  check();
  const source = await realpath(workspace);
  const info = await lstat(source);
  if (!info.isDirectory()) throw new TypeError('workspace must be a directory');
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(source)) throw new TypeError('workspace path contains unsupported control characters');
  await rejectNestedMounts(source);
  // Reject regular-file hardlinks: they can alias data outside the selected project.
  async function scan(dir) {
    check();
    for (const name of await readdir(dir)) {
      const path = join(dir, name); const entry = await lstat(path);
      if (entry.isSymbolicLink()) {
        const linkTarget = await readlink(path);
        if (KNOWN_CONTAINER_SYMLINK_TARGETS.has(linkTarget)) continue;
        let target;
        try { target = await realpath(path); } catch {
          throw new TypeError(`workspace contains an unresolved symlink: ${relative(source, path)}`);
        }
        const outside = relative(source, target);
        if (outside === '..' || outside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || outside.startsWith('/')) throw new TypeError(`workspace symlink resolves outside workspace: ${relative(source, path)}`);
        continue;
      }
      if (entry.isFile() && entry.nlink > 1) throw new TypeError(`workspace contains a multiply-linked file: ${relative(source, path)}`);
      if (entry.isDirectory()) await scan(path);
    }
  }
  await scan(source);
  return source;
}

async function rejectNestedMounts(source) {
  if (process.platform !== 'linux') return;
  const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
  const targets = decodeMountInfoTargets(mountInfo);
  if (targets.some(target => target.startsWith(`${source}/`))) {
    throw new TypeError('workspace contains a nested mount; choose a directory without submounts');
  }
}

export function decodeMountInfoTargets(mountInfo) {
  return mountInfo.split('\n').map(line => line.split(' - ')[0]?.split(' ')[4])
    .filter(Boolean)
    .map(target => target.replaceAll('\\040', ' ').replaceAll('\\011', '\t').replaceAll('\\012', '\n').replaceAll('\\134', '\\'));
}
