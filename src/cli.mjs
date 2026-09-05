#!/usr/bin/env node
import { runOnce, FixtureProvider, MissingProviderError } from './runtime.mjs';

const VERSION = '0.1.0';
function usage() { return 'Usage: yolo [-t MINUTES] [--json] [--fixture] <prompt>\n       yolo --help\n       yolo --version'; }
export function parseArgs(args) {
  let minutes = 10; let json = false; let fixture = false; const prompt = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--version' || arg === '-v') return { version: true };
    if (arg === '--json') { json = true; continue; }
    if (arg === '--fixture') { fixture = true; continue; }
    if (arg === '-t' || arg === '--time') {
      const value = Number(args[++i]);
      if (!(Number.isFinite(value) && value > 0)) throw new TypeError('time must be a positive finite number of minutes');
      minutes = value; continue;
    }
    if (arg.startsWith('-')) throw new TypeError(`unknown option: ${arg}`);
    prompt.push(arg);
  }
  if (!prompt.join(' ').trim()) throw new TypeError('prompt must be non-empty');
  return { minutes, json, fixture, prompt: prompt.join(' ') };
}

export async function main(args = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const options = parseArgs(args);
    if (options.help) { io.stdout.write(`${usage()}\n`); return 0; }
    if (options.version) { io.stdout.write(`${VERSION}\n`); return 0; }
    io.stderr.write(`starting bounded run (${options.minutes} minutes)\n`);
    const controller = new AbortController();
    const onInterrupt = () => { io.stderr.write('interrupt requested; stopping run\n'); controller.abort(new Error('SIGINT')); };
    process.once('SIGINT', onInterrupt);
    const record = await runOnce({ prompt: options.prompt, minutes: options.minutes, workspace: process.cwd(), provider: options.fixture ? new FixtureProvider() : undefined, signal: controller.signal });
    process.removeListener('SIGINT', onInterrupt);
    io.stdout.write(`${options.json ? JSON.stringify(record) : `${record.status}: ${record.result ?? record.errors.join('; ')}`}\n`);
    return record.status === 'completed' ? 0 : record.status === 'interrupted' ? 130 : record.status === 'deadline' ? 124 : 1;
  } catch (error) {
    const message = error instanceof MissingProviderError ? error.message : error.message;
    io.stderr.write(`${message}\n`); return 1;
  }
}

if (process.argv[1] && (process.argv[1].endsWith('/cli.mjs') || process.argv[1].endsWith('/yolo'))) {
  const code = await main(); process.exitCode = code;
}
