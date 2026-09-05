#!/usr/bin/env node
import { runOnce, FixtureProvider, MissingProviderError } from './runtime.mjs';
import { AuthClient, AuthStore } from './auth.mjs';
import { ConfiguredProvider } from './provider.mjs';

import { ConfigStore, configPath, configRoot, validateModel, imageMetadataPath } from './config.mjs';
import { ContainerLauncher } from './container-launcher.mjs';
import { readFile, mkdir, cp, rm, open, rename, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
const execFileAsync = promisify(execFile);

const VERSION = '0.1.0';
const AUTH_ENDPOINTS = Object.freeze({
  issueUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  pollUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  verificationUrl: 'https://auth.openai.com/codex/device',
  redirectUri: 'https://auth.openai.com/deviceauth/callback',
});
function usage() { return 'Usage: yolo [-t MINUTES] [--json] [--fixture] <prompt>\n       yolo setup\n       yolo config set model <model-id>\n       yolo auth login|status|logout\n       yolo --help\n       yolo --version'; }
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

export async function main(args = process.argv.slice(2), io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, { clientFactory } = {}) {
  try {
    if (args[0] === 'setup') return await setupCommand(io);
    if (args[0] === 'auth') return await authCommand(args.slice(1), io, { clientFactory });
    if (args[0] === 'config') return await configCommand(args.slice(1), io);
    const options = parseArgs(args);
    if (options.help) { io.stdout.write(`${usage()}\n`); return 0; }
    if (options.version) { io.stdout.write(`${VERSION}\n`); return 0; }
    io.stderr.write(`starting bounded run (${options.minutes} minutes)\n`);
    const controller = new AbortController();
    const onInterrupt = () => { io.stderr.write('interrupt requested; stopping run\n'); controller.abort(new Error('SIGINT')); };
    process.once('SIGINT', onInterrupt);
    const workspace = process.cwd();
    let record;
    if (options.fixture) record = await runOnce({ prompt: options.prompt, minutes: options.minutes, workspace, provider: new FixtureProvider(), signal: controller.signal });
    else {
      const model = await resolveModel();
      validateRuntimeEndpoint();
      const image = await configuredImage();
      const credentials = await runtimeCredentials(options.minutes);
      record = await new ContainerLauncher({ image, workspace, responsesUrl: process.env.YOLO_RESPONSES_URL, timeoutMs: options.minutes * 60_000 + 10_000 }).launch({ prompt: options.prompt, model, deadline: Date.now() + options.minutes * 60_000, accessToken: credentials.accessToken, expiresAt: credentials.expiresAt }, { signal: controller.signal });
    }
    process.removeListener('SIGINT', onInterrupt);
    io.stdout.write(`${options.json ? JSON.stringify(record) : `${record.status}: ${record.result ?? record.errors.join('; ')}`}\n`);
    return record.status === 'completed' ? 0 : record.status === 'interrupted' ? 130 : record.status === 'deadline' ? 124 : 1;
  } catch (error) {
    const message = error instanceof MissingProviderError ? error.message : error.message;
    io.stderr.write(`${message}\n`); return 1;
  }
}

export async function configuredImage() {
  try {
    const value = JSON.parse(await readFile(imageMetadataPath(), 'utf8'));
    if (value?.version !== 1 || typeof value.imageId !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(value.imageId) || typeof value.sourceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(value.sourceDigest) || value.sourceVersion !== VERSION) throw new Error('invalid image metadata');
    return value.imageId;
  } catch (error) { if (error.code === 'ENOENT') throw new MissingProviderError('no runtime image configured; run `yolo setup` before starting a run'); throw error; }
}

export async function setupCommand(io) {
  const context = await mkdtemp(join(tmpdir(), 'yoloharness-image-'));
  try {
    await cp(new URL('../package.json', import.meta.url), join(context, 'package.json'));
    await cp(new URL('../src', import.meta.url), join(context, 'src'), { recursive: true });
    const docker = process.env.YOLO_DOCKER_COMMAND ?? 'docker';
    const sourceIdentity = await runtimeSourceIdentity();
    const tag = `yoloharness-local:${VERSION}`;
    await execFileAsync(docker, ['build', '--pull', '-f', new URL('../assets/runtime/Dockerfile', import.meta.url).pathname, '-t', tag, context], { maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync(docker, ['image', 'inspect', '--format', '{{.Id}}', tag], { maxBuffer: 16 * 1024 });
    const imageId = stdout.trim();
    if (!/^sha256:[0-9a-f]{64}$/i.test(imageId)) throw new Error('Docker returned an invalid immutable image ID');
    await mkdir(dirname(imageMetadataPath()), { recursive: true, mode: 0o700 });
    await saveImageMetadata({ version: 1, imageId, ...sourceIdentity });
    io.stdout.write(`runtime image ready: ${imageId}\n`); return 0;
  } finally { await rm(context, { recursive: true, force: true }); }
}

export async function runtimeSourceIdentity() {
  const packageUrl = new URL('../package.json', import.meta.url);
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  const files = [['package.json', packageUrl], ...(await listRuntimeFiles(new URL('../src/', import.meta.url)))];
  const hash = createHash('sha256');
  for (const [name, url] of files.sort(([a], [b]) => a.localeCompare(b))) {
    const path = Buffer.from(name);
    const bytes = await readFile(url);
    const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(path.length));
    const contentLength = Buffer.alloc(8); contentLength.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length).update(path).update(contentLength).update(bytes);
  }
  return { sourceDigest: `sha256:${hash.digest('hex')}`, sourceVersion: packageJson.version };
}

async function listRuntimeFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) files.push(...await listRuntimeFiles(url, name));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push([`src/${name}`, url]);
  }
  return files;
}

async function saveImageMetadata(value) {
  const path = imageMetadataPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fh = await open(temp, 'wx', 0o600);
  try { await fh.writeFile(`${JSON.stringify(value)}\n`); await fh.sync(); } finally { await fh.close(); }
  try {
    await rename(temp, path);
    const dir = await open(dirname(path), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
}

export async function runtimeCredentials(minutes) {
  const path = process.env.YOLO_AUTH_FILE ?? join(configRoot(), 'yoloharness', 'credentials.json');
  const store = new AuthStore(path); let credentials = await store.load();
  if (!credentials?.accessToken || !credentials?.refreshToken || !Number.isFinite(credentials.expiresAt)) throw new MissingProviderError('no usable credentials; run `yolo auth login`');
  const required = Date.now() + minutes * 60_000 + 30_000;
  if (credentials.expiresAt <= required) {
    if (!credentials.clientId) throw new MissingProviderError('credential lifetime is insufficient and cannot be refreshed; run `yolo auth login`');
    credentials = await new AuthClient(authConfig(store, credentials.clientId, false)).refresh(credentials);
  }
  if (!Number.isFinite(credentials.expiresAt) || credentials.expiresAt <= required) throw new MissingProviderError('access token lifetime does not cover the requested deadline; run `yolo auth login`');
  return credentials;
}

export function validateRuntimeEndpoint() {
  if (process.env.YOLO_RESPONSES_URL !== 'https://chatgpt.com/backend-api/codex/responses') throw new MissingProviderError('YOLO_RESPONSES_URL must be the canonical HTTPS Responses endpoint');
}

export async function configuredProvider() {
  const model = await resolveModel();
  if (!process.env.YOLO_RESPONSES_URL) throw new MissingProviderError();
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
  const path = process.env.YOLO_AUTH_FILE ?? join(configRoot(), 'yoloharness', 'credentials.json');
  const credentials = await new AuthStore(path).load();
  if (!credentials) throw new MissingProviderError();
  if (typeof credentials.clientId !== 'string' || !credentials.clientId) throw new MissingProviderError();
  const authClient = new AuthClient(authConfig(new AuthStore(path), credentials.clientId, false));
  return new ConfiguredProvider({ credentials, url: process.env.YOLO_RESPONSES_URL, model, authClient });
}

export async function resolveModel() {
  if (process.env.YOLO_MODEL !== undefined) return validateModel(process.env.YOLO_MODEL);
  const saved = await new ConfigStore(configPath()).load();
  if (!saved) throw new MissingProviderError('no model configured; run `yolo config set model <model-id>`');
  return saved.model;
}

async function configCommand(args, io) {
  if (args.length !== 3 || args[0] !== 'set' || args[1] !== 'model') throw new TypeError('usage: yolo config set model <model-id>');
  const model = validateModel(args[2]); const store = new ConfigStore(configPath()); await store.load(); await store.save(model); io.stdout.write(`saved model ${model}\n`); return 0;
}

function authConfig(store, clientId = process.env.YOLO_CLIENT_ID, allowOverrides = true) { return { clientId, ...(allowOverrides ? { issueUrl: process.env.YOLO_AUTH_ISSUE_URL ?? AUTH_ENDPOINTS.issueUrl, pollUrl: process.env.YOLO_AUTH_POLL_URL ?? AUTH_ENDPOINTS.pollUrl, tokenUrl: process.env.YOLO_AUTH_TOKEN_URL ?? AUTH_ENDPOINTS.tokenUrl, verificationUrl: process.env.YOLO_AUTH_VERIFY_URL ?? AUTH_ENDPOINTS.verificationUrl, redirectUri: process.env.YOLO_AUTH_REDIRECT_URI ?? AUTH_ENDPOINTS.redirectUri } : AUTH_ENDPOINTS), store }; }
export async function authCommand(args, io, { clientFactory } = {}) {
  const path = process.env.YOLO_AUTH_FILE ?? join(configRoot(), 'yoloharness', 'credentials.json'); const store=new AuthStore(path);
  if(args[0]==='status'){const c=await store.load();io.stdout.write(c?`authenticated (expires ${c.expiresAt?new Date(c.expiresAt).toISOString():'unknown'})\n`:'not authenticated\n');return 0;}
  if(args[0]==='logout'){await store.clear();io.stdout.write('local credentials removed\n');return 0;}
  if(args[0]!=='login') throw new TypeError('usage: yolo auth login|status|logout');
  const client=clientFactory ? clientFactory(store) : new AuthClient(authConfig(store, process.env.YOLO_CLIENT_ID, false)); const attempt=await client.begin(); io.stdout.write(`Open ${attempt.verificationUrl} and enter ${attempt.userCode}\n`); await client.finish(attempt); io.stdout.write('authenticated\n');
  if (io.stdin?.isTTY) {
    const current = await new ConfigStore(configPath()).load();
    const { createInterface } = await import('node:readline/promises'); const rl = createInterface({ input: io.stdin, output: io.stdout }); let interrupted = false;
    try {
      const answer = await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => { io.stdin.removeListener?.('end', onEnd); rl.removeListener('SIGINT', onSigint); };
        const settle = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
        const onEnd = () => setImmediate(() => settle(reject, Object.assign(new Error('input ended'), { code: 'EOF' })));
        const onSigint = () => { interrupted = true; settle(resolve, ''); rl.close(); };
        rl.once('SIGINT', onSigint);
        const question = rl.question(`Model name?${current ? ` [${current.model}]` : ''} `);
        io.stdin.once?.('end', onEnd);
        question.then(value => settle(resolve, value), error => settle(reject, error));
      });
      if (interrupted || answer === '' && (io.stdin.readableEnded || io.stdin.destroyed)) throw Object.assign(new Error('input ended'), { code: 'EOF' }); const model = answer === '' && current ? current.model : validateModel(answer); await new ConfigStore(configPath()).save(model); io.stdout.write(`saved model ${model}\n`); }
    catch (error) { if (error.code === 'EOF' || error.code === 'ERR_USE_AFTER_CLOSE' || error.code === 'ABORT_ERR' || error.code === 'ERR_STREAM_PREMATURE_CLOSE') io.stderr.write('authentication succeeded; model setup unfinished (run `yolo config set model <model-id>`)\n'); else throw error; }
    finally { rl.close(); }
  } else if (!(await new ConfigStore(configPath()).load())) io.stderr.write('authentication succeeded; set a model with `yolo config set model <model-id>`\n');
  return 0;
}

if (process.argv[1] && (process.argv[1].endsWith('/cli.mjs') || process.argv[1].endsWith('/yolo'))) {
  const code = await main(); process.exitCode = code;
}
