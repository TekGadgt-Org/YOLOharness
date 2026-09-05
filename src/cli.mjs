#!/usr/bin/env node
import { runOnce, FixtureProvider, MissingProviderError, EXEC_TOOL } from './runtime.mjs';
import { AuthClient, AuthStore } from './auth.mjs';
import { ConfiguredProvider } from './provider.mjs';
import { DockerExecutor } from './docker-executor.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VERSION = '0.1.0';
const AUTH_ENDPOINTS = Object.freeze({
  issueUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  pollUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  verificationUrl: 'https://auth.openai.com/codex/device',
  redirectUri: 'https://auth.openai.com/deviceauth/callback',
});
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
    const workspace = process.cwd();
    const record = await runOnce({ prompt: options.prompt, minutes: options.minutes, workspace, provider: options.fixture ? new FixtureProvider() : await configuredProvider(), executor: options.fixture || !process.env.YOLO_DOCKER_IMAGE ? undefined : new DockerExecutor({ image: process.env.YOLO_DOCKER_IMAGE, workspace }), tools: options.fixture ? [] : [EXEC_TOOL], signal: controller.signal });
    process.removeListener('SIGINT', onInterrupt);
    io.stdout.write(`${options.json ? JSON.stringify(record) : `${record.status}: ${record.result ?? record.errors.join('; ')}`}\n`);
    return record.status === 'completed' ? 0 : record.status === 'interrupted' ? 130 : record.status === 'deadline' ? 124 : 1;
  } catch (error) {
    const message = error instanceof MissingProviderError ? error.message : error.message;
    io.stderr.write(`${message}\n`); return 1;
  }
}

export async function configuredProvider() {
  if (!process.env.YOLO_RESPONSES_URL || !process.env.YOLO_MODEL) throw new MissingProviderError();
  const rawEndpoint = process.env.YOLO_RESPONSES_URL;
  const canonicalEndpoint = 'https://chatgpt.com/backend-api/codex/responses';
  if (rawEndpoint !== canonicalEndpoint) throw new TypeError('YOLO_RESPONSES_URL must be the canonical HTTPS Responses endpoint');
  const authEnvNames = { issueUrl: 'YOLO_AUTH_ISSUE_URL', pollUrl: 'YOLO_AUTH_POLL_URL', tokenUrl: 'YOLO_AUTH_TOKEN_URL', verificationUrl: 'YOLO_AUTH_VERIFY_URL', redirectUri: 'YOLO_AUTH_REDIRECT_URI' };
  for (const [name, canonical] of Object.entries(AUTH_ENDPOINTS)) {
    const envName = authEnvNames[name];
    if (process.env[envName] !== undefined && process.env[envName] !== canonical) throw new TypeError(`${envName} must be the canonical HTTPS auth endpoint`);
  }
  const endpoint = new URL(rawEndpoint);
  if (endpoint.username || endpoint.password || endpoint.protocol !== 'https:') throw new TypeError('YOLO_RESPONSES_URL must be the canonical HTTPS Responses endpoint');
  const path = process.env.YOLO_AUTH_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'yoloharness', 'credentials.json');
  const credentials = await new AuthStore(path).load();
  if (!credentials) throw new MissingProviderError();
  if (typeof credentials.clientId !== 'string' || !credentials.clientId) throw new MissingProviderError();
  const authClient = new AuthClient(authConfig(new AuthStore(path), credentials.clientId, false));
  return new ConfiguredProvider({ credentials, url: process.env.YOLO_RESPONSES_URL, model: process.env.YOLO_MODEL, authClient });
}

function authConfig(store, clientId = process.env.YOLO_CLIENT_ID, allowOverrides = true) { return { clientId, ...(allowOverrides ? { issueUrl: process.env.YOLO_AUTH_ISSUE_URL ?? AUTH_ENDPOINTS.issueUrl, pollUrl: process.env.YOLO_AUTH_POLL_URL ?? AUTH_ENDPOINTS.pollUrl, tokenUrl: process.env.YOLO_AUTH_TOKEN_URL ?? AUTH_ENDPOINTS.tokenUrl, verificationUrl: process.env.YOLO_AUTH_VERIFY_URL ?? AUTH_ENDPOINTS.verificationUrl, redirectUri: process.env.YOLO_AUTH_REDIRECT_URI ?? AUTH_ENDPOINTS.redirectUri } : AUTH_ENDPOINTS), store }; }
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
