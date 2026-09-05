#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const MAX_OUTPUT = 1024 * 1024;
const MAX_COMMAND = 256; const MAX_ARGS = 64; const MAX_ARG = 4096;
function validate(call) { return call && typeof call.command === 'string' && call.command.length > 0 && call.command.length <= MAX_COMMAND && !call.command.includes('\0') && Array.isArray(call.args) && call.args.length <= MAX_ARGS && call.args.every(arg => typeof arg === 'string' && arg.length <= MAX_ARG && !arg.includes('\0')); }
async function run(call, callId) {
  if (!validate(call) || typeof callId !== 'string' || !callId) return { version: 1, ok: false, call_id: callId ?? '', error: 'invalid exec call' };
  const child = spawn(call.command, call.args, { cwd: '/workspace', shell: false, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp' } });
  let out = ''; let err = ''; let overflow = false;
  const collect = (which, chunk) => { const value = String(chunk); const next = which === 'out' ? out + value : err + value; if (Buffer.byteLength(next) > MAX_OUTPUT) { overflow = true; child.kill('SIGKILL'); } else if (which === 'out') out = next; else err = next; };
  child.stdout.on('data', x => collect('out', x)); child.stderr.on('data', x => collect('err', x));
  const [code] = await once(child, 'close');
  return overflow ? { version: 1, ok: false, call_id: callId, code: 1, output: '', error: 'output_limit' } : code === 0 ? { version: 1, ok: true, call_id: callId, code, output: out } : { version: 1, ok: false, call_id: callId, code, output: out, error: err || `exit_${code}` };
}
let input = ''; process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const lines = input.split('\n').filter(Boolean);
let receipt;
if (lines.length !== 1) receipt = { version: 1, ok: false, error: 'exactly one request required' };
else { try { const request = JSON.parse(lines[0]); receipt = request.version !== 1 ? { version: 1, ok: false, call_id: '', error: 'unsupported request version' } : await run(request.call, request.call_id); } catch { receipt = { version: 1, ok: false, call_id: '', error: 'invalid request' }; } }
process.stdout.write(JSON.stringify(receipt) + '\n');
