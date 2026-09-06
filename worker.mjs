#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const MAX_OUTPUT = 1024 * 1024;
const MAX_COMMAND = 256; const MAX_ARGS = 64; const MAX_ARG = 4096;
const validCallId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const failure = (callId, error, code = 1, output = '') => ({ version: 1, ok: false, call_id: validCallId(callId) ? callId : '', code: Math.min(255, Math.max(1, Number.isInteger(code) ? code : 1)), output: output.slice(0, MAX_OUTPUT), error: String(error).slice(0, MAX_OUTPUT) || 'execution failed' });
function validate(call) { return call && typeof call.command === 'string' && call.command.length > 0 && call.command.length <= MAX_COMMAND && !call.command.includes('\0') && Array.isArray(call.args) && call.args.length <= MAX_ARGS && call.args.every(arg => typeof arg === 'string' && arg.length <= MAX_ARG && !arg.includes('\0')); }
async function run(call, callId) {
  if (!validate(call) || !validCallId(callId)) return failure(callId, 'invalid exec call');
  let child;
  try { child = spawn(call.command, call.args, { cwd: '/workspace', shell: false, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp' } }); }
  catch (error) { return failure(callId, error.message || 'spawn failed', 127); }
  let out = ''; let err = ''; let overflow = false; let spawnError;
  const collect = (which, chunk) => { const value = String(chunk); const next = which === 'out' ? out + value : err + value; if (Buffer.byteLength(next) > MAX_OUTPUT) { overflow = true; child.kill('SIGKILL'); } else if (which === 'out') out = next; else err = next; };
  child.stdout.on('data', x => collect('out', x)); child.stderr.on('data', x => collect('err', x));
  child.once('error', error => { spawnError = error; });
  const [code] = await once(child, 'close');
  if (overflow) return failure(callId, 'output_limit', 1);
  if (spawnError) return failure(callId, spawnError.message || 'spawn failed', 127, out);
  const exitCode = Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1;
  return exitCode === 0 ? { version: 1, ok: true, call_id: callId, code: 0, output: out } : failure(callId, err || `exit_${exitCode}`, exitCode, out);
}
let input = ''; process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const lines = input.split('\n').filter(Boolean);
let receipt;
if (lines.length !== 1) receipt = failure('', 'exactly one request required');
else {
  let request;
  try { request = JSON.parse(lines[0]); } catch { request = null; }
  const callId = request?.call_id;
  if (!request || typeof request !== 'object' || Array.isArray(request)) receipt = failure(callId, 'invalid request');
  else if (request.version !== 1) receipt = failure(callId, 'unsupported request version');
  else {
    try { receipt = await run(request.call, callId); }
    catch (error) { receipt = failure(callId, error?.message || 'execution failed', 127); }
  }
}
process.stdout.write(JSON.stringify(receipt) + '\n');
