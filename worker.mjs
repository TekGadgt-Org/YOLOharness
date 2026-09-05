#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const MAX_OUTPUT = 1024 * 1024;
const rl = createInterface({ input: process.stdin });

async function run(call) {
  if (!call || typeof call.command !== 'string' || !Array.isArray(call.args) || call.args.some(arg => typeof arg !== 'string')) return { version: 1, ok: false, error: 'command and string args required' };
  const p = spawn(call.command, call.args, { cwd: '/workspace', shell: false, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp' } });
  let out = '', err = '', overflow = false;
  const collect = (which, chunk) => { const value = String(chunk); if (which === 'out') out += value; else err += value; if (Buffer.byteLength(which === 'out' ? out : err) > MAX_OUTPUT) { overflow = true; p.kill('SIGKILL'); } };
  p.stdout.on('data', x => collect('out', x)); p.stderr.on('data', x => collect('err', x));
  const code = await new Promise(resolve => p.on('close', resolve));
  return overflow ? { version: 1, ok: false, error: 'output_limit' } : { version: 1, ok: code === 0, code, output: out, error: err };
}
for await (const line of rl) {
  let request;
  try { request = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ version: 1, ok: false, error: 'invalid request' }) + '\n'); continue; }
  if (request.version !== 1) { process.stdout.write(JSON.stringify({ version: 1, ok: false, error: 'unsupported request version' }) + '\n'); continue; }
  process.stdout.write(JSON.stringify(await run(request.call)) + '\n');
}
