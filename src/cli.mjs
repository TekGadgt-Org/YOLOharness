#!/usr/bin/env node
import { AuthClient, AuthStore } from './auth.mjs';
import { ConfigStore, configPath, configRoot, validateModel, imageMetadataPath } from './config.mjs';
import { ContainerLauncher } from './container-launcher.mjs';
import { readFile, mkdir, cp, rm, open, rename, readdir, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
const execFileAsync = promisify(execFile);

const VERSION = '0.1.1';
const RUNTIME_IMAGE_TAG = `yoloharness-local:${VERSION}`;
const RUNTIME_ENTRYPOINT = ['node', '/app/src/container-runtime.mjs'];
// Kept local so production launcher errors do not require loading the agent
// runtime module on the host.
export class MissingProviderError extends Error {
  constructor(message = 'No provider is configured; run `yolo setup` and authenticate before starting a run') {
    super(message);
    this.name = 'MissingProviderError';
  }
}
const AUTH_ENDPOINTS = Object.freeze({
  issueUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  pollUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  verificationUrl: 'https://auth.openai.com/codex/device',
  redirectUri: 'https://auth.openai.com/deviceauth/callback',
});
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
function usage() { return 'Usage: yolo [-t MINUTES] [--json] <prompt>\n       yolo setup\n       yolo doctor\n       yolo config set model <model-id>\n       yolo auth login|status|logout\n       yolo --help\n       yolo --version'; }
export function parseArgs(args) {
  let minutes = 10; let json = false; const prompt = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--version' || arg === '-v') return { version: true };
    if (arg === '--json') { json = true; continue; }
    if (arg === '-t' || arg === '--time') {
      const value = Number(args[++i]);
      if (!(Number.isFinite(value) && value > 0)) throw new TypeError('time must be a positive finite number of minutes');
      minutes = value; continue;
    }
    if (arg.startsWith('-')) throw new TypeError(`unknown option: ${arg}`);
    prompt.push(arg);
  }
  if (!prompt.join(' ').trim()) throw new TypeError('prompt must be non-empty');
  return { minutes, json, prompt: prompt.join(' ') };
}

export async function main(args = process.argv.slice(2), io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, { clientFactory } = {}) {
  try {
    if (args[0] === 'setup') return await setupCommand(io);
    if (args[0] === 'doctor') return await doctorCommand(io);
    if (args[0] === 'auth') return await authCommand(args.slice(1), io, { clientFactory });
    if (args[0] === 'config') return await configCommand(args.slice(1), io);
    const options = parseArgs(args);
    if (options.help) { io.stdout.write(`${usage()}\n`); return 0; }
    if (options.version) { io.stdout.write(`${VERSION}\n`); return 0; }
    io.stderr.write(`starting bounded run (${options.minutes} minutes)\n`);
    io.stderr.write('Warning: files in the selected project are intentionally exposed to the agent and may be disclosed\n');
    const controller = new AbortController();
    const onInterrupt = () => { io.stderr.write('interrupt requested; stopping run\n'); controller.abort(new Error('SIGINT')); };
    process.once('SIGINT', onInterrupt);
    const workspace = process.cwd();
    const model = await resolveModel();
    // Resolve the trusted invoker-selected Docker client once.  The same
    // executable and normal Docker context/host configuration are used for
    // image inspection and the subsequent container lifecycle.
    const dockerCommand = await resolveDockerCommand();
    const image = await configuredImage({ dockerCommand });
    const credentials = await runtimeCredentials(options.minutes);
    const launcher = new ContainerLauncher({ image, workspace, command: dockerCommand, timeoutMs: options.minutes * 60_000 + 10_000 });
    const record = await launcher.launch({ prompt: options.prompt, model, deadline: Date.now() + options.minutes * 60_000, accessToken: credentials.accessToken, expiresAt: credentials.expiresAt }, { signal: controller.signal });
    process.removeListener('SIGINT', onInterrupt);
    io.stdout.write(`${options.json ? JSON.stringify(record) : `${record.status} run=${record.run_id ?? 'unknown'} effect_state=${record.effect_state ?? 'unknown'} evidence=${record.evidence?.length ?? 0} artifacts=${record.artifacts?.length ?? 0}: ${record.result ?? record.errors.join('; ')}`}\n`);
    return record.status === 'completed' && record.effect_state !== 'uncertain' ? 0 : record.status === 'interrupted' ? 130 : record.status === 'deadline' ? 124 : 1;
  } catch (error) {
    const message = error instanceof MissingProviderError ? error.message : error.message;
    if (hasCleanupUnknown(error)) {
      const prior = error.receipt && typeof error.receipt === 'object' ? error.receipt : {};
      const cleanup = cleanupErrorIn(error);
      const errors = [...(Array.isArray(prior.errors) ? prior.errors : []), ...(message ? [message] : []), ...(cleanup && cleanup !== error && cleanup.message ? [cleanup.message] : [])];
      const receipt = { version: 1, run_id: prior.run_id ?? null, status: 'cleanup_unknown', effect_state: 'uncertain', result: prior.result ?? error.partialResult ?? null, evidence: Array.isArray(prior.evidence) ? prior.evidence : [], artifacts: Array.isArray(prior.artifacts) ? prior.artifacts : [], errors, cleanup_history: cleanup?.cleanupHistory ?? prior.cleanup_history ?? [] };
      io.stdout.write(`${JSON.stringify(receipt)}\n`);
      return 1;
    }
    io.stderr.write(`${message}\n`); return 1;
  }
}

function cleanupErrorIn(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return null;
  seen.add(error);
  if (error.code === 'cleanup_unknown') return error;
  for (const nested of [error.cleanupError, error.cause, ...(error.errors ?? []), ...(error.aggregateErrors ?? [])]) {
    const found = cleanupErrorIn(nested, seen);
    if (found) return found;
  }
  return null;
}

function hasCleanupUnknown(error) { return Boolean(cleanupErrorIn(error)); }

export async function configuredImage({ inspect, dockerCommand } = {}) {
  try {
    const value = JSON.parse(await readFile(imageMetadataPath(), 'utf8'));
    if (!value || Object.keys(value).length !== 4 || value.version !== 1 ||
        typeof value.imageId !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(value.imageId) ||
        typeof value.sourceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(value.sourceDigest) ||
        typeof value.sourceVersion !== 'string' || !value.sourceVersion) throw new Error('invalid image metadata');
    const installed = await runtimeSourceIdentity();
    if (value.sourceDigest !== installed.sourceDigest || value.sourceVersion !== installed.sourceVersion) throw new Error('configured image metadata does not match installed runtime source');
    const inspectImage = inspect ?? (image => inspectRuntimeImage(image, dockerCommand));
    const inspected = JSON.parse(await inspectImage(value.imageId));
    const config = inspected?.Config ?? {};
    if (inspected.Id !== value.imageId) throw new Error('runtime image identity did not match configured immutable ID');
    if (!Array.isArray(inspected.RepoTags) || !inspected.RepoTags.includes(RUNTIME_IMAGE_TAG)) throw new Error('runtime image is not the installation-owned image tag');
    if (config.Labels?.['org.yoloharness.source-digest'] !== value.sourceDigest) throw new Error('runtime image source digest does not match configured source digest');
    if (JSON.stringify(config.Entrypoint) !== JSON.stringify(RUNTIME_ENTRYPOINT)) throw new Error('runtime image entrypoint is not the installation-owned entrypoint');
    return value.imageId;
  } catch (error) { if (error.code === 'ENOENT') throw new MissingProviderError('no runtime image configured; run `yolo setup` before starting a run'); throw error; }
}

async function inspectRuntimeImage(image, dockerCommand = undefined) {
  const docker = dockerCommand ?? await resolveDockerCommand();
  const { stdout } = await execFileAsync(docker, ['image', 'inspect', '--format', '{{json .}}', image], { maxBuffer: 64 * 1024, env: dockerEnvironment() });
  return stdout;
}

export async function resolveDockerCommand() {
  const path = typeof process.env.PATH === 'string' ? process.env.PATH : '';
  for (const directory of path.split(':')) {
    if (!directory) continue;
    const candidate = `${directory}/docker`;
    try { await access(candidate, fsConstants.X_OK); return candidate; } catch {}
  }
  throw new Error('Docker executable was not found on PATH');
}

function dockerEnvironment() {
  // Docker context/host selection is trusted invoker configuration.  Do not
  // replace it with a product-selected socket or context.  This environment
  // is used only by the Docker client, never inherited by the runtime.
  return { ...process.env };
}

export async function setupCommand(io) {
  const context = await mkdtemp(join(tmpdir(), 'yoloharness-image-'));
  try {
    await cp(new URL('../package.json', import.meta.url), join(context, 'package.json'));
    await cp(new URL('../src', import.meta.url), join(context, 'src'), { recursive: true });
    const docker = await resolveDockerCommand();
    const sourceIdentity = await runtimeSourceIdentity();
    const tag = `yoloharness-local:${VERSION}`;
    await execFileAsync(docker, ['build', '--pull', '--build-arg', `YOLO_SOURCE_DIGEST=${sourceIdentity.sourceDigest}`, '-f', new URL('../assets/runtime/Dockerfile', import.meta.url).pathname, '-t', tag, context], { maxBuffer: 1024 * 1024, env: dockerEnvironment() });
    const { stdout } = await execFileAsync(docker, ['image', 'inspect', '--format', '{{.Id}}', tag], { maxBuffer: 16 * 1024, env: dockerEnvironment() });
    const imageId = stdout.trim();
    if (!/^sha256:[0-9a-f]{64}$/i.test(imageId)) throw new Error('Docker returned an invalid immutable image ID');
    await mkdir(dirname(imageMetadataPath()), { recursive: true, mode: 0o700 });
    await saveImageMetadata({ version: 1, imageId, ...sourceIdentity });
    io.stdout.write(`runtime image ready: ${imageId}\n`); return 0;
  } finally { await rm(context, { recursive: true, force: true }); }
}

export async function runtimeSourceIdentity() {
  const packageUrl = new URL('../package.json', import.meta.url);
  const dockerfileUrl = new URL('../assets/runtime/Dockerfile', import.meta.url);
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  const files = [['package.json', packageUrl], ['assets/runtime/Dockerfile', dockerfileUrl], ...(await listRuntimeFiles(new URL('../src/', import.meta.url)))];
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
    credentials = await new AuthClient(authConfig(store, credentials.clientId, false)).refresh(credentials);
  }
  if (!Number.isFinite(credentials.expiresAt) || credentials.expiresAt <= required) throw new MissingProviderError('access token lifetime does not cover the requested deadline; run `yolo auth login`');
  return credentials;
}

export function validateRuntimeEndpoint() {
  if (process.env.YOLO_RESPONSES_URL !== 'https://chatgpt.com/backend-api/codex/responses') throw new MissingProviderError('YOLO_RESPONSES_URL must be the canonical HTTPS Responses endpoint');
}

export async function configuredProvider() {
  // Retained as an explicit test/integration seam; ordinary runs never call
  // this host-side provider path.
  const { ConfiguredProvider } = await import('./provider.mjs');
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

export async function doctorStatus({ env = process.env, exec = execFileAsync } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  let docker = false; let dockerCommand;
  for (const directory of (typeof env.PATH === 'string' ? env.PATH : '').split(':')) {
    if (!directory) continue;
    try { await access(join(directory, 'docker'), fsConstants.X_OK); docker = true; dockerCommand = join(directory, 'docker'); break; } catch {}
  }
  add('docker', docker, docker ? 'Docker executable found on PATH' : 'Docker executable missing from PATH');
  let daemon = false;
  if (docker) {
    try { await exec(dockerCommand, ['info', '--format', '{{json .ServerVersion}}'], { env }); daemon = true; }
    catch {}
  }
  add('docker_daemon', daemon, daemon ? 'Docker daemon is reachable' : 'Docker daemon is unavailable; start Docker or select a working context');
  let image = false; let imageDetail = 'runtime image is not configured; run `yolo setup`';
  try {
    const value = JSON.parse(await readFile(imageMetadataPath(env), 'utf8'));
    if (value?.version === 1 && /^sha256:[0-9a-f]{64}$/i.test(value.imageId ?? '') && /^sha256:[0-9a-f]{64}$/i.test(value.sourceDigest ?? '') && typeof value.sourceVersion === 'string' && value.sourceVersion.length > 0 && daemon) {
      const inspected = JSON.parse((await exec(dockerCommand, ['image', 'inspect', '--format', '{{json .}}', value.imageId], { env })).stdout);
      image = inspected.Id === value.imageId && inspected.RepoTags?.includes(RUNTIME_IMAGE_TAG) && inspected.Config?.Labels?.['org.yoloharness.source-digest'] === value.sourceDigest && JSON.stringify(inspected.Config?.Entrypoint) === JSON.stringify(RUNTIME_ENTRYPOINT);
      imageDetail = image ? 'installation-owned immutable runtime image is ready' : 'configured runtime image failed immutable identity/tag/source/entrypoint checks';
    } else if (daemon) imageDetail = 'runtime image metadata is malformed; run `yolo setup`';
  } catch (error) { if (daemon) imageDetail = `configured runtime image could not be inspected: ${error.message}`; }
  add('runtime_image', image, imageDetail);
  add('client_id', true, 'device-auth client ID is built-in');
  let credentials = false;
  try {
    const value = JSON.parse(await readFile(env.YOLO_AUTH_FILE ?? join(configRoot(env), 'yoloharness', 'credentials.json'), 'utf8'));
    credentials = typeof value?.accessToken === 'string' && value.accessToken.length > 0 && typeof value?.refreshToken === 'string' && value.refreshToken.length > 0 && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now();
  } catch {}
  add('credentials', credentials, credentials ? 'local credentials are present and unexpired' : 'usable local credentials are missing; run `yolo auth login`');
  let model = false;
  try { model = Boolean(env.YOLO_MODEL ? validateModel(env.YOLO_MODEL) : (await new ConfigStore(configPath(env)).load())?.model); } catch {}
  add('model', model, model ? 'model is configured' : 'model is missing; run `yolo config set model <model-id>`');
  return { version: 1, ready: checks.every(check => check.ok), checks };
}

export async function doctorCommand(io) {
  const status = await doctorStatus();
  for (const check of status.checks) io.stdout.write(`${check.ok ? 'ready' : 'missing'} ${check.name}: ${check.detail}\n`);
  io.stdout.write(`doctor: ${status.ready ? 'ready' : 'not ready'}\n`);
  return status.ready ? 0 : 1;
}

function authConfig(store, clientId, allowOverrides = true) { return { clientId: typeof clientId === 'string' && clientId.length > 0 ? clientId : CODEX_CLIENT_ID, ...(allowOverrides ? { issueUrl: process.env.YOLO_AUTH_ISSUE_URL ?? AUTH_ENDPOINTS.issueUrl, pollUrl: process.env.YOLO_AUTH_POLL_URL ?? AUTH_ENDPOINTS.pollUrl, tokenUrl: process.env.YOLO_AUTH_TOKEN_URL ?? AUTH_ENDPOINTS.tokenUrl, verificationUrl: process.env.YOLO_AUTH_VERIFY_URL ?? AUTH_ENDPOINTS.verificationUrl, redirectUri: process.env.YOLO_AUTH_REDIRECT_URI ?? AUTH_ENDPOINTS.redirectUri } : AUTH_ENDPOINTS), store }; }
export async function authCommand(args, io, { clientFactory } = {}) {
  const path = process.env.YOLO_AUTH_FILE ?? join(configRoot(), 'yoloharness', 'credentials.json'); const store=new AuthStore(path);
  if(args[0]==='status'){const c=await store.load();io.stdout.write(c?`authenticated (expires ${c.expiresAt?new Date(c.expiresAt).toISOString():'unknown'})\n`:'not authenticated\n');return 0;}
  if(args[0]==='logout'){await store.clear();io.stdout.write('local credentials removed\n');return 0;}
  if(args[0]!=='login') throw new TypeError('usage: yolo auth login|status|logout');
  const client=clientFactory ? clientFactory(store) : new AuthClient(authConfig(store, undefined, false)); const attempt=await client.begin(); io.stdout.write(`Open ${attempt.verificationUrl} and enter ${attempt.userCode}\n`); await client.finish(attempt); io.stdout.write('authenticated\n');
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
