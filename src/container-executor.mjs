import { spawn } from 'node:child_process';

const MAX_OUTPUT = 1024 * 1024;
const MAX_COMMAND = 256;
const MAX_ARGS = 64;

export class ContainerProcessExecutor {
  constructor({ cwd = '/workspace', home = '/tmp/yoloharness-home', timeoutMs = 60_000 } = {}) {
    this.cwd = cwd;
    this.home = home;
    this.timeoutMs = timeoutMs;
  }

  execute({ call, signal }) {
    if (!call || typeof call.command !== 'string' || !call.command || call.command.length > MAX_COMMAND || !Array.isArray(call.args) || call.args.length > MAX_ARGS) {
      return Promise.reject(new TypeError('invalid exec call'));
    }
    if (call.command.includes('\0') || call.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 4096)) return Promise.reject(new TypeError('invalid exec arguments'));
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('executor cancelled'));
      let child;
      let out = '';
      let err = '';
      let settled = false;
      let timedOut = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
      const abort = () => { timedOut = true; child?.kill('SIGKILL'); };
      const timer = setTimeout(() => { timedOut = true; child?.kill('SIGKILL'); }, this.timeoutMs);
      try {
        child = spawn(call.command, call.args, {
          cwd: this.cwd,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: this.home, LANG: 'C', LC_ALL: 'C' },
        });
      } catch (error) { finish(reject, error); return; }
      const collect = (which, chunk) => {
        const value = String(chunk);
        if (which === 'out') out += value; else err += value;
        if (Buffer.byteLength(which === 'out' ? out : err) > MAX_OUTPUT) { timedOut = true; child.kill('SIGKILL'); }
      };
      child.stdout?.on('data', chunk => collect('out', chunk));
      child.stderr?.on('data', chunk => collect('err', chunk));
      child.once('error', error => finish(reject, error));
      child.once('close', code => {
        if (timedOut) return finish(resolve, { version: 1, ok: false, call_id: call.call_id, code: 124, output: out.slice(0, MAX_OUTPUT), error: 'command deadline or output limit exceeded' });
        finish(resolve, { version: 1, ok: code === 0, call_id: call.call_id, code: code ?? 1, output: out.slice(0, MAX_OUTPUT), ...(code === 0 ? {} : { error: err.trim().slice(0, MAX_OUTPUT) || `command exited (${code})` }) });
      });
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
