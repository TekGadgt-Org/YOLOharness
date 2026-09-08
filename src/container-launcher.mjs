import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, readdir, lstat, readFile, readlink, writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { encodeBootstrap } from './bootstrap.mjs';
import { snapshotSkills } from './skills.mjs';
import { RUNTIME_RESOURCE_POLICY } from './resource-policy.mjs';

const MAX_OUTPUT = 1024 * 1024;
const OP_TIMEOUT = 10_000;
const CLEANUP_TOTAL_MS = 1500;
const CLEANUP_STABLE_ABSENCE_MS = 500;
const CLEANUP_POLL_MS = 50;
const VOLUME_PREFIX = 'yoloharness-scratch-';
const HELPER_PREFIX = 'yoloharness-scratch-';
// These paths are materialized by Docker inside every container and therefore
// cannot be resolved from the host before the workspace bind is created.
const KNOWN_CONTAINER_SYMLINK_TARGETS = new Set(['/etc/hosts', '/etc/hostname', '/etc/resolv.conf']);
// The invoker-selected Docker client/context is trusted host setup.  The
// environment is used only by the Docker client and never passed to the
// runtime container.
const DOCKER_ENV = () => ({ ...process.env });

export class ContainerLauncher {
  constructor({ image, workspace = process.cwd(), command = 'docker', spawn = nodeSpawn, timeoutMs = 600000, hostPlatform = process.platform } = {}) {
    if (!image || !workspace) throw new TypeError('container image and workspace are required');
    this.image = image; this.workspace = workspace; this.command = command; this.spawn = spawn; this.timeoutMs = timeoutMs; this.hostPlatform = hostPlatform;
  }

  async launch(bootstrap, { signal } = {}) {
    const startedAt = Date.now();
    const deadline = startedAt + this.timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    if (signal?.aborted) throw signal.reason;
    const source = await validateWorkspace(this.workspace, { signal, deadline });
    if (signal?.aborted) throw signal.reason;
    if (Date.now() >= deadline) throw Object.assign(new Error('container deadline exceeded'), { code: 'deadline' });
    let outcome;
    let failure;
    let identity;
    let name;
    let label;
    let volumeName;
    let volumeCreated = false;
    let volumeCreateAttempted = false;
    let volumeCleanup;
    let volumeHistory;
    let id;
    let attached;
    let creating;
    let createAttempted = false;
    let owned = false;
    let reason;
    let abortCleanup;
    let abortCleanupError;
    let timer;
    const abort = (abortReason = signal?.reason ?? Object.assign(new Error('container interrupted'), { code: 'interrupted' })) => {
      if (reason) return;
      reason = abortReason;
      creating?.kill('SIGKILL');
      if (id && owned && !abortCleanup) abortCleanup = cleanup(this.command, id, name, label, this.spawn, undefined, { deadline: Date.now() + 6000 }).then(() => null, error => error);
    };
    try {
      identity = await containerIdentity(this.command, this.spawn, { signal, deadline, hostPlatform: this.hostPlatform });
      if (signal?.aborted) throw signal.reason;
      if (Date.now() >= deadline) throw Object.assign(new Error('container deadline exceeded'), { code: 'deadline' });
      name = `yoloharness-${randomUUID()}`;
      label = randomUUID();
      volumeName = `${VOLUME_PREFIX}${label}`;
      volumeCreateAttempted = true;
      await createScratchVolume(this.command, volumeName, label, this.spawn, { signal, deadline });
      volumeCreated = true;
      if (identity.uid !== 0) await initializeScratchVolume(this.command, this.image, volumeName, label, identity, this.spawn, { signal, deadline });
      const args = ['create', '--pull=never', '--name', name, '--label', `yoloharness.run=${label}`, '--init', '-i', '--user', `${identity.uid}:${identity.gid}`];
      for (const group of identity.groups) args.push('--group-add', String(group));
      args.push('--network', 'bridge', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', RUNTIME_RESOURCE_POLICY.pids, '--memory', RUNTIME_RESOURCE_POLICY.memory, '--cpus', RUNTIME_RESOURCE_POLICY.cpus, '--mount', `type=volume,src=${volumeName},dst=/tmp,volume-nocopy`, '--tmpfs', `/home/worker:rw,noexec,nosuid,size=${RUNTIME_RESOURCE_POLICY.homeTmpfs},uid=${identity.uid},gid=${identity.gid},mode=700`, '--mount', `type=bind,src=${source},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--workdir', '/workspace', '--env', 'HOME=/home/worker', '--env', 'XDG_CONFIG_HOME=/home/worker/.config', '--env', 'XDG_DATA_HOME=/home/worker/.local/share', this.image, 'node', '/app/src/container-runtime.mjs');
      timer = setTimeout(() => abort(Object.assign(new Error('container deadline exceeded'), { code: 'deadline' })), remaining());
      signal?.addEventListener('abort', () => abort(signal.reason), { once: true });
      createAttempted = true;
      const create = operation(this.command, args, this.spawn, { deadline, signal });
      creating = create.child;
      id = (await create.promise).trim();
      if (!/^[a-f0-9]{64}$/i.test(id)) throw new Error('docker did not return a full container ID');
      if (reason || signal?.aborted) throw reason ?? signal.reason;
      creating = null;
      if (Date.now() >= deadline) throw Object.assign(new Error('container deadline exceeded'), { code: 'deadline' });
      id = await verifyOwnedContainer(this.command, id, name, label, this.spawn, undefined, { deadline });
      owned = true;
      const bootstrapFrame = encodeBootstrap({ ...bootstrap, skills: await snapshotSkills(source) });
      attached = this.spawn(this.command, ['start', '--attach', '--interactive', id], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: DOCKER_ENV() });
      const result = await attachedOperation(attached, bootstrapFrame, signal);
      if (reason) {
        if (abortCleanup) abortCleanupError = await abortCleanup;
        const partial = lastReceipt(result.out) ?? await workspaceReceipt(this.workspace);
        outcome = { ...(partial ?? { version: 1, run_id: null, result: null, evidence: [], artifacts: [] }), status: reason.code === 'deadline' ? 'deadline' : 'interrupted', effect_state: 'uncertain', errors: [...(partial?.errors ?? []), reason.message] };
      } else if (result.overflow) outcome = { version: 1, run_id: null, status: 'deadline', effect_state: 'uncertain', result: null, evidence: [], artifacts: [], errors: ['container output limit exceeded'] };
      else {
        if (result.code !== 0) throw new Error(result.err.trim() || `container exited (${result.code})`);
        const lines = result.out.trim().split(/\r?\n/).filter(Boolean);
        if (lines.length !== 1) throw new Error('container returned malformed status');
        outcome = JSON.parse(lines[0]);
      }

    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    let cleanupError;
      if (abortCleanupError) cleanupError = abortCleanupError;
      try {
        if (abortCleanup) abortCleanupError = await abortCleanup;
        else if (id && owned) await cleanup(this.command, id, name, label, this.spawn, undefined, { deadline });
        else if (createAttempted) await reconcileUnknownCreate(this.command, name, label, this.spawn, undefined, { deadline: Math.max(deadline, Date.now()) + CLEANUP_TOTAL_MS });
      } catch (error) { cleanupError = error; }
      try {
        if (volumeName && (volumeCreated || volumeCreateAttempted)) volumeCleanup = reconcileVolume(this.command, volumeName, label, this.spawn, { deadline: Math.max(deadline, Date.now()) + CLEANUP_TOTAL_MS });
        if (volumeCleanup) { volumeHistory = await volumeCleanup; if (outcome) outcome = { ...outcome, cleanup_history: volumeHistory }; }
      } catch (error) { cleanupError ??= error; }
      if (cleanupError) {
        const message = cleanupError.code === 'cleanup_unknown' ? `cleanup_unknown: ${dockerErrorOutput(cleanupError) || cleanupError.cause?.message || cleanupError.message}` : cleanupError.message;
        if (outcome) outcome = { ...outcome, status: reason ? (reason.code === 'deadline' ? 'deadline' : 'interrupted') : (['interrupted', 'deadline'].includes(outcome.status) ? outcome.status : 'cleanup_unknown'), effect_state: 'uncertain', errors: [...(outcome.errors ?? []), message], cleanup_history: cleanupError.cleanupHistory ?? outcome.cleanup_history ?? [] }
        else if (failure) { failure.cleanupError = cleanupError; failure.receipt = await workspaceReceipt(this.workspace); }
        else failure = cleanupError;
      }
    }
    if (outcome) {
      try { await mkdir(join(this.workspace, '.yolo'), { recursive: true, mode: 0o700 }); await writeFile(join(this.workspace, '.yolo', 'last-receipt.json'), `${JSON.stringify(outcome)}\n`, { mode: 0o600 }); }
      catch (error) { outcome = { ...outcome, status: 'cleanup_unknown', effect_state: 'uncertain', errors: [...(outcome.errors ?? []), `receipt persistence failed: ${error.message}`] }; }
    }
    if (failure) throw failure;
    return outcome;
  }
}

async function inspectOwnedVolume(command, name, label, spawn, { deadline } = {}) {
  let output;
  try { output = await operation(command, ['volume', 'inspect', '--format', '{{json .}}', name], spawn, { deadline }).promise; }
  catch (error) { throw Object.assign(new Error('scratch volume ownership could not be verified'), { code: 'cleanup_unknown', cause: error }); }
  let inspected;
  try { inspected = JSON.parse(output.trim()); } catch (error) { throw Object.assign(new Error('scratch volume ownership could not be verified'), { code: 'cleanup_unknown', cause: error }); }
  if (inspected?.Name !== name || inspected?.Labels?.['yoloharness.run'] !== label) throw new Error(`scratch volume ownership mismatch (name=${inspected?.Name ?? 'missing'}, label=${inspected?.Labels?.['yoloharness.run'] ?? 'missing'})`);
  return inspected;
}

async function createScratchVolume(command, name, label, spawn, { signal, deadline } = {}) {
  const output = await operation(command, ['volume', 'create', '--label', `yoloharness.run=${label}`, name], spawn, { signal, deadline }).promise;
  if (output.trim() !== name) throw new Error('scratch volume ownership mismatch: Docker did not return the exact generated name');
  await inspectOwnedVolume(command, name, label, spawn, { deadline });
}

async function initializeScratchVolume(command, image, volume, label, identity, spawn, { signal, deadline } = {}) {
  await runScratchHelper(command, image, volume, label, identity, 'scratch-init', 0, true, spawn, { signal, deadline });
  await runScratchHelper(command, image, volume, label, identity, 'scratch-verify', identity.uid, false, spawn, { signal, deadline });
}

async function runScratchHelper(command, image, volume, label, identity, role, uid, addChown, spawn, { signal, deadline } = {}) {
  const name = `${HELPER_PREFIX}${role}-${label}`;
  const args = ['create', '--pull=never', '--name', name, '--label', `yoloharness.run=${label}`, '--label', `yoloharness.role=${role}`, '--init', '--network', 'none', '--read-only', '--cap-drop=ALL', ...(addChown ? ['--cap-add=CHOWN'] : []), '--security-opt', 'no-new-privileges', '--pids-limit', RUNTIME_RESOURCE_POLICY.pids, '--memory', RUNTIME_RESOURCE_POLICY.memory, '--cpus', RUNTIME_RESOURCE_POLICY.cpus, '--user', `${uid}:${uid === 0 ? 0 : identity.gid}`, '--mount', `type=volume,src=${volume},dst=/tmp,volume-nocopy`, '--entrypoint', 'node', image, `/app/src/${role}.mjs`, String(identity.uid), String(identity.gid)];
  let id;
  let verified = false;
  try {
    id = (await operation(command, args, spawn, { signal, deadline }).promise).trim();
    if (!/^[a-f0-9]{64}$/i.test(id)) throw new Error('scratch helper returned an invalid container ID');
    await verifyOwnedContainer(command, id, name, label, spawn, role, { deadline });
    verified = true;
    const result = await operation(command, ['start', '--attach', id], spawn, { signal, deadline }).promise;
    let evidence;
    try { evidence = JSON.parse(result.trim()); } catch { throw new Error(`${role} helper returned malformed verification`); }
    const valid = role === 'scratch-init'
      ? evidence?.version === 1 && evidence.uid === identity.uid && evidence.gid === identity.gid && Number.isInteger(evidence.mode) && evidence.ownership === true
      : evidence?.version === 1 && evidence.uid === identity.uid && evidence.gid === identity.gid && evidence.marker === 'write-read-remove' && evidence.writable === true && Number.isInteger(evidence.mode);
    if (!valid) throw new Error(`${role} helper returned malformed verification: ${JSON.stringify(evidence)}`);
  } finally {
    if (verified) await reapHelper(command, id, name, label, role, spawn, { deadline });
    else await reconcileUnknownCreate(command, name, label, spawn, role, { deadline });
  }
}

async function reapHelper(command, id, name, label, role, spawn, { deadline } = {}) {
  await verifyOwnedContainer(command, id, name, label, spawn, role, { deadline });
  try { await operation(command, ['rm', '--force', id], spawn, { deadline }).promise; }
  catch (error) { throw Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown', cause: error }); }
  await waitForContainerAbsence(command, id, spawn, { deadline });
}

async function reconcileVolume(command, name, label, spawn, { deadline = Date.now() + CLEANUP_TOTAL_MS } = {}) {
  const history = [];
  let absentSince = null;
  while (Date.now() < deadline) {
    const attempt = { at: Date.now(), name, action: 'inspect' };
    try {
      await inspectOwnedVolume(command, name, label, spawn, { deadline });
      absentSince = null;
      attempt.success = true;
      attempt.action = 'remove';
      await operation(command, ['volume', 'rm', name], spawn, { deadline }).promise;
      attempt.removed = true;
    } catch (error) {
      const output = dockerErrorOutput(error);
      attempt.error = error.message;
      attempt.classification = classifyCleanupError(error, output);
      history.push(attempt);
      if (attempt.classification === 'terminal') throw withCleanupHistory(error, history);
      if (attempt.classification === 'absent') absentSince ??= Date.now();
      else absentSince = null;
      if (absentSince !== null && Date.now() - absentSince >= CLEANUP_STABLE_ABSENCE_MS) return history;
      await pauseUntil(deadline);
      continue;
    }
    history.push(attempt);
    if (Date.now() >= deadline) break;
    await pauseUntil(deadline);
  }
  if (absentSince !== null && Date.now() - absentSince >= CLEANUP_STABLE_ABSENCE_MS) return history;
  throw withCleanupHistory(Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown' }), history);
}

function classifyCleanupError(error, output) {
  if (/no such volume|not found/i.test(output)) return 'absent';
  if (/already in use|being used|temporarily|timeout|deadline|busy|transport|connection/i.test(output)) return 'retryable';
  return error.code === 'cleanup_unknown' ? 'retryable' : 'terminal';
}

function withCleanupHistory(error, history) {
  error.cleanupHistory = history;
  return error;
}

async function pauseUntil(deadline) {
  const remaining = deadline - Date.now();
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(CLEANUP_POLL_MS, remaining)));
}

function lastReceipt(output) {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line);
      if (value?.version === 1 && typeof value.result === 'string' && Array.isArray(value.evidence) && Array.isArray(value.artifacts)) return value;
    } catch {}
  }
  return null;
}

async function workspaceReceipt(workspace) {
  try {
    const value = JSON.parse(await readFile(join(workspace, '.yolo', 'last-receipt.json'), 'utf8'));
    return value?.version === 1 ? value : null;
  } catch { return null; }
}

export async function containerIdentity(command, spawn, opts = {}) {
  const result = opts.operationFn
    ? await opts.operationFn()
    : await operation(command, ['info', '--format', '{{json .}}'], spawn, opts).promise;
  let options;
  try { options = JSON.parse(String(result).trim()); } catch { throw new Error('unable to verify Docker security mode: malformed daemon info'); }
  const hostPlatform = opts.hostPlatform ?? process.platform;
  const linuxDaemon = options && typeof options === 'object' && !Array.isArray(options) &&
    typeof options.OSType === 'string' && options.OSType.toLowerCase() === 'linux';
  const darwinLinuxDaemon = hostPlatform === 'darwin' && linuxDaemon;
  const supportedLinux = hostPlatform === 'linux' && linuxDaemon;
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      (!supportedLinux && !darwinLinuxDaemon) ||
      !Array.isArray(options.SecurityOptions) || options.SecurityOptions.some(value => typeof value !== 'string')) {
    throw new Error('unable to verify Docker security mode: unsupported or malformed Linux daemon info');
  }
  const securityOptions = options.SecurityOptions;
  if (supportedLinux && securityOptions.some(value => /^name=userns(?:,|$)/i.test(value))) throw new Error('unsupported Docker user-namespace remapping security mode');
  if (darwinLinuxDaemon) return { uid: 0, gid: 0, groups: [], rootless: false };
  const rootless = securityOptions.some(value => /^name=rootless(?:,|$)/i.test(value));
  if (rootless) return { uid: 0, gid: 0, groups: [], rootless: true };
  const getuid = opts.getuid ?? process.getuid;
  const getgid = opts.getgid ?? process.getgid;
  const getgroups = opts.getgroups ?? process.getgroups;
  if (typeof getuid !== 'function' || typeof getgid !== 'function' || typeof getgroups !== 'function') throw new Error('unsupported Docker identity semantics: host numeric identity is unavailable');
  let uid; let gid; let groups;
  try { uid = getuid(); gid = getgid(); groups = getgroups(); } catch (error) { throw new Error(`unable to read host numeric identity: ${error.message}`); }
  const validId = value => Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
  if (!validId(uid) || !validId(gid) || !Array.isArray(groups) || groups.some(group => !validId(group))) throw new Error('unable to verify Docker security mode: invalid host numeric identity');
  return { uid, gid, groups: [...new Set(groups)].filter(group => group !== gid), rootless: false };
}

function operation(command, args, spawn, { timeoutMs = OP_TIMEOUT, deadline, signal } = {}) {
  let child;
  const promise = new Promise((resolve, reject) => {
    let out = ''; let err = ''; let done = false; let terminalError; let abort = () => {};
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const terminate = error => { terminalError = error; child?.kill('SIGKILL'); };
    const budget = deadline === undefined ? timeoutMs : Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => { terminate(Object.assign(new Error('docker operation deadline exceeded'), { code: 'deadline' })); setImmediate(() => finish(reject, terminalError)); }, Math.min(budget, OP_TIMEOUT));
    try { child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: DOCKER_ENV() }); }
    catch (error) { finish(reject, error); return; }
    child.stdout?.on('data', chunk => { out += String(chunk); if (Buffer.byteLength(out) > MAX_OUTPUT) terminate(new Error('docker output limit exceeded')); });
    child.stderr?.on('data', chunk => { err += String(chunk); if (Buffer.byteLength(err) > MAX_OUTPUT) terminate(new Error('docker output limit exceeded')); });
    abort = () => terminate(signal?.reason ?? new Error('docker operation cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => finish(reject, terminalError ?? error)); child.once('close', code => {
      if (terminalError) return finish(reject, Object.assign(terminalError, { dockerOutput: `${out}${err}`.trim() }));
      // Docker may have created the container before the client was killed. Preserve
      // a returned ID so the caller can still perform exact-ID cleanup.
      if (code !== 0 && /^[a-f0-9]{12,64}$/i.test(out.trim())) return finish(resolve, out);
      if (code === 0) finish(resolve, out); else finish(reject, Object.assign(new Error(`docker operation failed (${code}): ${err.trim()}`), { dockerOutput: `${out}${err}`.trim(), dockerExitCode: code }));
    });
  });
  return { promise, get child() { return child; } };
}

function attachedOperation(child, input, signal) {
  return new Promise((resolve, reject) => {
    let out = ''; let err = ''; let done = false; let overflow = false;
    let hardKill;
    const abort = () => {
      // ContainerLauncher starts an owned `docker stop` concurrently. Keep the
      // attach pipe alive long enough to receive the runtime's SIGTERM receipt;
      // force-close only if the daemon or a descendant remains stuck.
      hardKill = setTimeout(() => { child.kill('SIGKILL'); finish(resolve, { code: null, out, err, overflow }); }, 5500);
    };
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(hardKill); signal?.removeEventListener('abort', abort); fn(value); };
    const collect = (which, chunk) => { const text = String(chunk); if (which === 'out') out += text; else err += text; if (Buffer.byteLength(which === 'out' ? out : err) > MAX_OUTPUT) { overflow = true; child.kill('SIGKILL'); } };
    child.stdout?.on('data', chunk => collect('out', chunk)); child.stderr?.on('data', chunk => collect('err', chunk));
    child.once('error', error => finish(reject, error)); child.once('close', code => finish(resolve, { code, out, err, overflow }));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    child.stdin?.end(input);
  });
}

async function reconcileUnknownCreate(command, name, label, spawn, role = undefined, { deadline = Date.now() + CLEANUP_TOTAL_MS } = {}) {
  const startedAt = Date.now();
  let absentSince = null;
  while (Date.now() < deadline) {
    let output;
    const filters = ['--filter', `label=yoloharness.run=${label}`, '--filter', `name=^/${name}$`];
    if (role) filters.push('--filter', `label=yoloharness.role=${role}`);
    try { output = await operation(command, ['ps', '--all', '--no-trunc', '--quiet', ...filters], spawn, { deadline }).promise; }
    catch (error) { throw Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown', cause: error }); }
    const ids = output.trim().split(/\s+/).filter(id => /^[a-f0-9]{64}$/i.test(id));
    if (ids.length > 0) {
      absentSince = null;
      for (const id of ids) {
        try { await verifyOwnedContainer(command, id, name, label, spawn, role, { deadline }); }
        catch (error) { if (error.code === 'cleanup_unknown' || /ownership mismatch/.test(error.message)) continue; throw error; }
        await cleanup(command, id, name, label, spawn, role, { deadline });
      }
    } else {
      absentSince ??= Date.now();
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(CLEANUP_POLL_MS, remaining)));
  }
  if (absentSince !== null && Date.now() - absentSince >= CLEANUP_STABLE_ABSENCE_MS) return;
  throw Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown' });
}

function dockerErrorOutput(error) {
  let current = error; const parts = [];
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current.dockerOutput) parts.push(String(current.dockerOutput));
    current = current.cause;
  }
  return parts.join('\\n');
}

async function verifyOwnedContainer(command, id, name, label, spawn, role = undefined, { deadline } = {}) {
  let output;
  try { output = await operation(command, ['inspect', '--format', '{{json .}}', id], spawn, { deadline }).promise; }
  catch (error) { throw Object.assign(new Error('container ownership could not be verified'), { code: 'cleanup_unknown', cause: error }); }
  let inspected;
  try { inspected = JSON.parse(output.trim()); } catch (error) { throw Object.assign(new Error('container ownership could not be verified'), { code: 'cleanup_unknown', cause: error }); }
  const labels = inspected?.Config?.Labels ?? {};
  if (!/^[a-f0-9]{64}$/i.test(inspected?.Id ?? '') || inspected.Id !== id || inspected?.Name !== `/${name}` || labels['yoloharness.run'] !== label || (role !== undefined && labels['yoloharness.role'] !== role)) throw new Error(`container ownership mismatch (id=${inspected?.Id ?? 'missing'}, name=${inspected?.Name ?? 'missing'}, label=${labels['yoloharness.run'] ?? 'missing'}, role=${labels['yoloharness.role'] ?? 'missing'})`);
  return inspected.Id;
}

async function cleanup(command, id, name, label, spawn, role = undefined, { deadline } = {}) {
  if (typeof name === 'function') { spawn = name; name = null; label = null; }
  if (name && label) await verifyOwnedContainer(command, id, name, label, spawn, role, { deadline });
  // Give the runtime a chance to trap SIGTERM and emit its partial receipt
  // before the hard kill fallback. This is important when a provider stream
  // has started but the container deadline/SIGINT arrives mid-response.
  try { await operation(command, ['stop', '--time', '5', id], spawn, { timeoutMs: 5500, deadline }).promise; } catch {}
  try { await operation(command, ['kill', '--signal', 'KILL', id], spawn, { deadline }).promise; } catch {}
  try { await operation(command, ['rm', '--force', id], spawn, { deadline }).promise; } catch (error) { throw Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown', cause: error }); }
  await waitForContainerAbsence(command, id, spawn, { deadline });
}

async function waitForContainerAbsence(command, id, spawn, { deadline = Date.now() + CLEANUP_TOTAL_MS } = {}) {
  const startedAt = Date.now(); let absentSince = null; let lastError;
  while (Date.now() < deadline) {
    try {
      await operation(command, ['inspect', id], spawn, { deadline }).promise;
      absentSince = null;
    } catch (error) {
      lastError = error;
      if (/no such (?:container|object)|not found/i.test(dockerErrorOutput(error))) absentSince ??= Date.now();
      else throw Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown', cause: error });
    }
    if (absentSince !== null && Date.now() - absentSince >= CLEANUP_STABLE_ABSENCE_MS) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(CLEANUP_POLL_MS, Math.max(1, deadline - Date.now()))));
  }
  throw Object.assign(new Error('cleanup_unknown'), { code: 'cleanup_unknown', cause: lastError });
}

export async function validateWorkspace(workspace, { signal, deadline } = {}) {
  const check = () => { if (signal?.aborted) throw signal.reason; if (deadline && Date.now() >= deadline) throw Object.assign(new Error('container deadline exceeded'), { code: 'deadline' }); };
  check();
  const source = await realpath(workspace);
  const info = await lstat(source);
  if (!info.isDirectory()) throw new TypeError('workspace must be a directory');
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(source)) throw new TypeError('workspace path contains unsupported control characters');
  await rejectNestedMounts(source);
  // Reject regular-file hardlinks: they can alias data outside the selected project.
  async function scan(dir) {
    check();
    for (const name of await readdir(dir)) {
      const path = join(dir, name); const entry = await lstat(path);
      if (entry.isSymbolicLink()) {
        const linkTarget = await readlink(path);
        if (KNOWN_CONTAINER_SYMLINK_TARGETS.has(linkTarget)) continue;
        let target;
        try { target = await realpath(path); } catch {
          throw new TypeError(`workspace contains an unresolved symlink: ${relative(source, path)}`);
        }
        const outside = relative(source, target);
        if (outside === '..' || outside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || outside.startsWith('/')) throw new TypeError(`workspace symlink resolves outside workspace: ${relative(source, path)}`);
        continue;
      }
      if (entry.isFile() && entry.nlink > 1) throw new TypeError(`workspace contains a multiply-linked file: ${relative(source, path)}`);
      if (entry.isDirectory()) await scan(path);
    }
  }
  await scan(source);
  return source;
}

async function rejectNestedMounts(source) {
  if (process.platform !== 'linux') return;
  const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
  const targets = decodeMountInfoTargets(mountInfo);
  if (targets.some(target => target.startsWith(`${source}/`))) {
    throw new TypeError('workspace contains a nested mount; choose a directory without submounts');
  }
}

export function decodeMountInfoTargets(mountInfo) {
  return mountInfo.split('\n').map(line => line.split(' - ')[0]?.split(' ')[4])
    .filter(Boolean)
    .map(target => target.replaceAll('\\040', ' ').replaceAll('\\011', '\t').replaceAll('\\012', '\n').replaceAll('\\134', '\\'));
}
