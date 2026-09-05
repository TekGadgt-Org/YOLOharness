#!/usr/bin/env node
import { runOnce, FixtureProvider, MissingProviderError } from './runtime.mjs';
import { AuthClient, AuthStore } from './auth.mjs';
import { ConfiguredProvider } from './provider.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
    if (args[0] === 'auth') return await authCommand(args.slice(1), io);
    const options = parseArgs(args);
    if (options.help) { io.stdout.write(`${usage()}\n`); return 0; }
    if (options.version) { io.stdout.write(`${VERSION}\n`); return 0; }
    io.stderr.write(`starting bounded run (${options.minutes} minutes)\n`);
    const controller = new AbortController();
    const onInterrupt = () => { io.stderr.write('interrupt requested; stopping run\n'); controller.abort(new Error('SIGINT')); };
    process.once('SIGINT', onInterrupt);
    const record = await runOnce({ prompt: options.prompt, minutes: options.minutes, workspace: process.cwd(), provider: options.fixture ? new FixtureProvider() : await configuredProvider(), signal: controller.signal });
    process.removeListener('SIGINT', onInterrupt);
    io.stdout.write(`${options.json ? JSON.stringify(record) : `${record.status}: ${record.result ?? record.errors.join('; ')}`}\n`);
    return record.status === 'completed' ? 0 : record.status === 'interrupted' ? 130 : record.status === 'deadline' ? 124 : 1;
  } catch (error) {
    const message = error instanceof MissingProviderError ? error.message : error.message;
    io.stderr.write(`${message}\n`); return 1;
  }
}

async function configuredProvider() {
  if (!process.env.YOLO_RESPONSES_URL || !process.env.YOLO_MODEL) throw new MissingProviderError();
  const endpoint = new URL(process.env.YOLO_RESPONSES_URL);
  const loopback = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost' || endpoint.hostname === '::1';
  if (endpoint.username || endpoint.password || (endpoint.protocol !== 'https:' && !(loopback && process.env.YOLO_ALLOW_INSECURE_LOCAL === '1'))) throw new TypeError('YOLO_RESPONSES_URL must use HTTPS; HTTP is limited to explicit loopback fixtures');
  const path = process.env.YOLO_AUTH_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'yoloharness', 'credentials.json');
  const credentials = await new AuthStore(path).load();
  if (!credentials) throw new MissingProviderError();
  const authClient = process.env.YOLO_CLIENT_ID ? new AuthClient(authConfig(new AuthStore(path))) : undefined;
  return new ConfiguredProvider({ credentials, url: process.env.YOLO_RESPONSES_URL, model: process.env.YOLO_MODEL, authClient });
}

function authConfig(store) { return { clientId: process.env.YOLO_CLIENT_ID, issueUrl: process.env.YOLO_AUTH_ISSUE_URL ?? 'https://auth.openai.com/api/accounts/deviceauth/usercode', pollUrl: process.env.YOLO_AUTH_POLL_URL ?? 'https://auth.openai.com/api/accounts/deviceauth/token', tokenUrl: process.env.YOLO_AUTH_TOKEN_URL ?? 'https://auth.openai.com/oauth/token', verificationUrl: process.env.YOLO_AUTH_VERIFY_URL ?? 'https://auth.openai.com/codex/device', redirectUri: process.env.YOLO_AUTH_REDIRECT_URI ?? 'https://auth.openai.com/deviceauth/callback', store }; }
async function authCommand(args, io) {
  const path = process.env.YOLO_AUTH_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'yoloharness', 'credentials.json'); const store=new AuthStore(path);
  if(args[0]==='status'){const c=await store.load();io.stdout.write(c?`authenticated (expires ${c.expiresAt?new Date(c.expiresAt).toISOString():'unknown'})\n`:'not authenticated\n');return 0;}
  if(args[0]==='logout'){await store.clear();io.stdout.write('local credentials removed\n');return 0;}
  if(args[0]!=='login') throw new TypeError('usage: yolo auth login|status|logout');
  const client=new AuthClient(authConfig(store)); const attempt=await client.begin(); io.stdout.write(`Open ${attempt.verificationUrl} and enter ${attempt.userCode}\n`); await client.finish(attempt); io.stdout.write('authenticated\n'); return 0;
}

if (process.argv[1] && (process.argv[1].endsWith('/cli.mjs') || process.argv[1].endsWith('/yolo'))) {
  const code = await main(); process.exitCode = code;
}
