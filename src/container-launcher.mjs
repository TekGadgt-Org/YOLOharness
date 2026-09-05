import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { encodeBootstrap } from './bootstrap.mjs';

const MAX_OUTPUT = 1024 * 1024;
export class ContainerLauncher {
  constructor({ image, workspace = process.cwd(), command = 'docker', spawn = nodeSpawn, timeoutMs = 600000, responsesUrl } = {}) {
    if (!image || !workspace) throw new TypeError('container image and workspace are required');
    this.image = image; this.workspace = workspace; this.command = command; this.spawn = spawn; this.timeoutMs = timeoutMs; this.responsesUrl = responsesUrl;
  }
  async launch(bootstrap, { signal } = {}) {
    const source = await realpath(this.workspace);
    const name = `yoloharness-${randomUUID()}`;
    const args = ['run', '--pull=never', '--rm', '--name', name, '--init', '-i', '--network', 'bridge', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--tmpfs', '/home/worker:rw,noexec,nosuid,size=16m', '--mount', `type=bind,src=${source},dst=/workspace,rw,bind-propagation=rprivate`, '--workdir', '/workspace', '--env', `YOLO_RESPONSES_URL=${this.responsesUrl}`, this.image, 'node', '/app/src/container-runtime.mjs'];
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      let child; let out = ''; let err = ''; let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
      const abort = () => { child?.kill('SIGKILL'); };
      const timer = setTimeout(() => { child?.kill('SIGKILL'); finish(reject, Object.assign(new Error('container deadline exceeded'), { code: 'deadline' })); }, this.timeoutMs);
      try { child = this.spawn(this.command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }); }
      catch (error) { return finish(reject, error); }
      const collect = (which, chunk) => { const text = String(chunk); if (Buffer.byteLength(which === 'out' ? out + text : err + text) > MAX_OUTPUT) { child.kill('SIGKILL'); return finish(reject, Object.assign(new Error('container output limit exceeded'), { code: 'output_limit' })); } if (which === 'out') out += text; else err += text; };
      child.stdout?.on('data', chunk => collect('out', chunk)); child.stderr?.on('data', chunk => collect('err', chunk));
      child.once('error', error => finish(reject, error));
      child.once('close', code => { if (settled) return; if (code !== 0) return finish(reject, new Error(err.trim() || `container exited (${code})`)); const lines = out.trim().split(/\r?\n/); if (lines.length !== 1) return finish(reject, new Error('container returned malformed status')); try { finish(resolve, JSON.parse(lines[0])); } catch { finish(reject, new Error('container returned malformed status')); } });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.end(encodeBootstrap(bootstrap));
    });
  }
}