import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, readdir, lstat } from 'node:fs/promises';
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
    const source = await validateWorkspace(this.workspace);
    if (signal?.aborted) throw signal.reason;
    const name = `yoloharness-${randomUUID()}`;
    const label = `yoloharness.run=${randomUUID()}`;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 10001;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 10001;
    if (uid === 0) throw new Error('refusing root container launch');
    const args = ['create', '--pull=never', '--name', name, '--label', label, '--init', '-i', '--user', `${uid}:${gid}`, '--network', 'bridge', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--tmpfs', '/home/worker:rw,noexec,nosuid,size=16m', '--mount', `type=bind,src=${source},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--workdir', '/workspace', '--env', 'HOME=/tmp', '--env', `YOLO_RESPONSES_URL=${this.responsesUrl}`, this.image, 'node', '/app/src/container-runtime.mjs'];
    let id;
    let attached;
    let reason;
    const abort = () => { reason = signal?.reason ?? Object.assign(new Error('container interrupted'), { code: 'interrupted' }); attached?.kill('SIGKILL'); };
    const timer = setTimeout(() => { reason = Object.assign(new Error('container deadline exceeded'), { code: 'deadline' }); attached?.kill('SIGKILL'); }, this.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      id = (await operation(this.command, args, this.spawn, { timeoutMs: this.timeoutMs })).trim();
      if (!/^sha256:|^[a-f0-9]{12,64}$/i.test(id)) throw new Error('docker did not return a container ID');
      attached = this.spawn(this.command, ['start', '--attach', '--interactive', id], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
      const result = await attachedOperation(attached, encodeBootstrap(bootstrap));
      if (reason) return { version: 1, run_id: null, status: reason.code === 'deadline' ? 'deadline' : 'interrupted', result: null, evidence: [], artifacts: [], errors: [reason.message] };
      if (result.code !== 0) throw new Error(result.err.trim() || `container exited (${result.code})`);
      const lines = result.out.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length !== 1) throw new Error('container returned malformed status');
      return JSON.parse(lines[0]);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (id) await cleanup(this.command, id, this.spawn);
    }
  }
}

async function operation(command, args, spawn, { timeoutMs = OP_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let out = ''; let child; let done = false;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { child?.kill('SIGKILL'); finish(reject, new Error('docker operation deadline exceeded')); }, Math.min(timeoutMs, OP_TIMEOUT));
    try { child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }); }
    catch (error) { finish(reject, error); return; }
    child.stdout?.on('data', chunk => { out += String(chunk); if (Buffer.byteLength(out) > MAX_OUTPUT) { child.kill('SIGKILL'); finish(reject, new Error('docker output limit exceeded')); } });
    let err = '';
    child.stderr?.on('data', chunk => { err += String(chunk); if (Buffer.byteLength(err) > MAX_OUTPUT) child.kill('SIGKILL'); });
    child.once('error', error => finish(reject, error)); child.once('close', code => { if (code === 0) finish(resolve, out); else finish(reject, Object.assign(new Error(`docker operation failed (${code})`), { dockerOutput: `${out}${err}`.trim(), dockerExitCode: code })); });
  });
}

function attachedOperation(child, input) {
  return new Promise((resolve, reject) => {
    let out = ''; let err = ''; let done = false;
    const finish = (fn, value) => { if (done) return; done = true; fn(value); };
    const collect = (which, chunk) => { const text = String(chunk); if (which === 'out') out += text; else err += text; if (Buffer.byteLength(which === 'out' ? out : err) > MAX_OUTPUT) child.kill('SIGKILL'); };
    child.stdout?.on('data', chunk => collect('out', chunk)); child.stderr?.on('data', chunk => collect('err', chunk));
    child.once('error', error => finish(reject, error)); child.once('close', code => finish(resolve, { code, out, err }));
    child.stdin?.end(input);
  });
}

async function cleanup(command, id, spawn) {
  try { await operation(command, ['kill', '--signal', 'KILL', id], spawn); } catch {}
  try { await operation(command, ['rm', '--force', id], spawn); } catch (error) { throw Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown', cause: error }); }
  try { await operation(command, ['inspect', id], spawn); throw new Error('cleanup_unknown'); } catch (error) {
    if (error.message === 'cleanup_unknown') throw error;
    const output = error.dockerOutput ?? '';
    if (!/no such (?:container|object)[: ]/i.test(output)) throw Object.assign(new Error('cleanup_unknown'), { cause: error });
  }
}

export async function validateWorkspace(workspace) {
  const source = await realpath(workspace);
  const info = await lstat(source);
  if (!info.isDirectory()) throw new TypeError('workspace must be a directory');
  // Reject regular-file hardlinks: they can alias data outside the selected project.
  async function scan(dir) {
    for (const name of await readdir(dir)) {
      const path = join(dir, name); const entry = await lstat(path);
      if (entry.isFile() && entry.nlink > 1) throw new TypeError(`workspace contains a multiply-linked file: ${relative(source, path)}`);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await scan(path);
    }
  }
  await scan(source);
  return source;
}
