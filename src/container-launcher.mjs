import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, readdir, lstat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { encodeBootstrap } from './bootstrap.mjs';

const MAX_OUTPUT = 1024 * 1024;
const OP_TIMEOUT = 10_000;

export class ContainerLauncher {
  constructor({ image, workspace = process.cwd(), command = 'docker', spawn = nodeSpawn, timeoutMs = 600000, responsesUrl } = {}) {
    if (!image || !workspace) throw new TypeError('container image and workspace are required');
    this.image = image; this.workspace = workspace; this.command = command; this.spawn = spawn; this.timeoutMs = timeoutMs; this.responsesUrl = responsesUrl;
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
    const label = `yoloharness.run=${randomUUID()}`;
    const identity = await containerIdentity(this.command, this.spawn, { signal, timeoutMs: remaining() });
    if (signal?.aborted) throw signal.reason;
    if (Date.now() >= deadline) throw Object.assign(new Error('container deadline exceeded'), { code: 'deadline' });
    const args = ['create', '--pull=never', '--name', name, '--label', label, '--init', '-i', '--user', `${identity.uid}:${identity.gid}`, '--network', 'bridge', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--tmpfs', '/home/worker:rw,noexec,nosuid,size=16m', '--mount', `type=bind,src=${source},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--workdir', '/workspace', '--env', 'HOME=/home/worker', '--env', 'XDG_CONFIG_HOME=/home/worker/.config', '--env', 'XDG_DATA_HOME=/home/worker/.local/share', '--env', `YOLO_RESPONSES_URL=${this.responsesUrl ?? ''}`, this.image, 'node', '/app/src/container-runtime.mjs'];
    let id;
    let attached;
    let creating;
    let createAttempted = false;
    let reason;
    const abort = () => { reason = signal?.reason ?? Object.assign(new Error('container interrupted'), { code: 'interrupted' }); creating?.kill('SIGKILL'); attached?.kill('SIGKILL'); };
    const timer = setTimeout(() => { reason = Object.assign(new Error('container deadline exceeded'), { code: 'deadline' }); creating?.kill('SIGKILL'); attached?.kill('SIGKILL'); }, remaining());
    signal?.addEventListener('abort', abort, { once: true });
    try {
      createAttempted = true;
      const create = operation(this.command, args, this.spawn, { timeoutMs: remaining(), signal });
      creating = create.child;
      id = (await create.promise).trim();
      if (!/^sha256:|^[a-f0-9]{12,64}$/i.test(id)) throw new Error('docker did not return a container ID');
      if (reason || signal?.aborted) throw reason ?? signal.reason;
      creating = null;
      if (Date.now() >= deadline) throw Object.assign(new Error('container deadline exceeded'), { code: 'deadline' });
      attached = this.spawn(this.command, ['start', '--attach', '--interactive', id], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
      const result = await attachedOperation(attached, encodeBootstrap(bootstrap));
      if (reason) return { version: 1, run_id: null, status: reason.code === 'deadline' ? 'deadline' : 'interrupted', result: null, evidence: [], artifacts: [], errors: [reason.message] };
      if (result.overflow) throw Object.assign(new Error('container output limit exceeded'), { code: 'output_limit' });
      if (result.code !== 0) throw new Error(result.err.trim() || `container exited (${result.code})`);
      const lines = result.out.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length !== 1) throw new Error('container returned malformed status');
      return JSON.parse(lines[0]);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (id) await cleanup(this.command, id, this.spawn);
      else if (createAttempted) await reconcileUnknownCreate(this.command, name, label, this.spawn);
    }
  }
}

async function containerIdentity(command, spawn, opts) {
  const result = await operation(command, ['info', '--format', '{{json .SecurityOptions}}'], spawn, opts).promise;
  let options;
  try { options = JSON.parse(result.trim()); } catch { throw new Error('unable to verify Docker rootless mode'); }
  if (!Array.isArray(options) || !options.some(value => value === 'name=rootless')) throw new Error('refusing launch: Docker rootless mode was not verified');
  // Do not rely on rootless UID 0. The image and launcher must execute the
  // runtime as an explicit non-root identity; projects that do not permit
  // that identity are rejected by the runtime canary rather than repaired by
  // silently chmod'ing or chown'ing host files.
  return { uid: 10001, gid: 10001 };
}

function operation(command, args, spawn, { timeoutMs = OP_TIMEOUT, signal } = {}) {
  let child;
  const promise = new Promise((resolve, reject) => {
    let out = ''; let done = false;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { child?.kill('SIGKILL'); finish(reject, new Error('docker operation deadline exceeded')); }, Math.min(timeoutMs, OP_TIMEOUT));
    try { child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }); }
    catch (error) { finish(reject, error); return; }
    child.stdout?.on('data', chunk => { out += String(chunk); if (Buffer.byteLength(out) > MAX_OUTPUT) { child.kill('SIGKILL'); finish(reject, new Error('docker output limit exceeded')); } });
    let err = '';
    child.stderr?.on('data', chunk => { err += String(chunk); if (Buffer.byteLength(err) > MAX_OUTPUT) child.kill('SIGKILL'); });
    const abort = () => child?.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => finish(reject, error)); child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      // Docker may have created the container before the client was killed. Preserve
      // a returned ID so the caller can still perform exact-ID cleanup.
      if (code !== 0 && /^[a-f0-9]{12,64}$/i.test(out.trim())) return finish(resolve, out);
      if (code === 0) finish(resolve, out); else finish(reject, Object.assign(new Error(`docker operation failed (${code})`), { dockerOutput: `${out}${err}`.trim(), dockerExitCode: code }));
    });
  });
  return { promise, get child() { return child; } };
}

function attachedOperation(child, input) {
  return new Promise((resolve, reject) => {
    let out = ''; let err = ''; let done = false; let overflow = false;
    const finish = (fn, value) => { if (done) return; done = true; fn(value); };
    const collect = (which, chunk) => { const text = String(chunk); if (which === 'out') out += text; else err += text; if (Buffer.byteLength(which === 'out' ? out : err) > MAX_OUTPUT) { overflow = true; child.kill('SIGKILL'); } };
    child.stdout?.on('data', chunk => collect('out', chunk)); child.stderr?.on('data', chunk => collect('err', chunk));
    child.once('error', error => finish(reject, error)); child.once('close', code => finish(resolve, { code, out, err, overflow }));
    child.stdin?.end(input);
  });
}

async function reconcileUnknownCreate(command, name, label, spawn) {
  let output;
  try { output = await operation(command, ['ps', '--all', '--quiet', '--filter', `label=${label}`, '--filter', `name=^/${name}$`], spawn).promise; }
  catch (error) { throw Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown', cause: error }); }
  for (const id of output.trim().split(/\s+/).filter(Boolean)) await cleanup(command, id, spawn);
}

async function cleanup(command, id, spawn) {
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
  await rejectNestedMounts(source);
  // Reject regular-file hardlinks: they can alias data outside the selected project.
  async function scan(dir) {
    check();
    for (const name of await readdir(dir)) {
      const path = join(dir, name); const entry = await lstat(path);
      if (entry.isFile() && entry.nlink > 1) throw new TypeError(`workspace contains a multiply-linked file: ${relative(source, path)}`);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await scan(path);
    }
  }
  await scan(source);
  return source;
}

async function rejectNestedMounts(source) {
  if (process.platform !== 'linux') return;
  const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
  const targets = mountInfo.split('\n').map(line => line.split(' - ')[0]?.split(' ')[4])
    .filter(Boolean).map(target => target.replaceAll('\\040', ' ').replaceAll('\\011', '\t').replaceAll('\\134', '\\'));
  if (targets.some(target => target.startsWith(`${source}/`))) {
    throw new TypeError('workspace contains a nested mount; choose a directory without submounts');
  }
}
