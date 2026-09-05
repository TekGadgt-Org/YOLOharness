import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, stat, rm, utimes, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

import { execFileSync } from 'node:child_process';
import { AuthClient, AuthStore } from '../src/auth.mjs';
import { ResponsesClient, parseSSE } from '../src/responses.mjs';
import { DockerExecutor, DockerUnavailableError, OutputLimitError, validateReceipt } from '../src/docker-executor.mjs';
import { configuredProvider } from '../src/cli.mjs';
import { runOnce, EXEC_TOOL } from '../src/runtime.mjs';
import { ConfiguredProvider } from '../src/provider.mjs';
import { ConfigStore, validateModel, ConfigError, configPath, configRoot } from '../src/config.mjs';
import { main, resolveModel } from '../src/cli.mjs';

const json = (res, value, status=200) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(value)); };
function server(handler) { return new Promise(async resolve => { const s=http.createServer(handler); await new Promise(r=>s.listen(0,'127.0.0.1',r)); resolve({s, base:`http://127.0.0.1:${s.address().port}`}); }); }

test('model configuration roundtrips in XDG config and preserves exact spelling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-config-')); const path = join(dir, 'yoloharness', 'config.json');
  const store = new ConfigStore(path); await store.save('Provider/MODEL:v2');
  assert.deepEqual(await store.load(), { version: 1, model: 'Provider/MODEL:v2' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('model configuration rejects invalid identifiers and malformed schemas without fallback', async () => {
  for (const value of ['', 'has space', 'has\nnewline', '\u0000', '\u009b']) assert.throws(() => validateModel(value), ConfigError);
  const dir = await mkdtemp(join(tmpdir(), 'yolo-config-invalid-')); const path = join(dir, 'config.json');
  await writeFile(path, '{not json'); await assert.rejects(new ConfigStore(path).load(), /malformed JSON/);
  await writeFile(path, JSON.stringify({ version: 2, model: 'fallback' })); await assert.rejects(new ConfigStore(path).load(), /unsupported schema/);
});

test('config command preserves malformed and unsupported configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-config-command-invalid-')); const old = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = dir;
  const errors = []; const out = { stdout: { write() {} }, stderr: { write(value) { errors.push(value); } } };
  try {
    const path = configPath(); await mkdir(join(dir, 'yoloharness'), { recursive: true });
    await writeFile(path, '{not json'); assert.equal(await main(['config', 'set', 'model', 'replacement'], out), 1); assert.equal(await readFile(path, 'utf8'), '{not json'); assert.match(errors.at(-1), /malformed JSON/);
    await writeFile(path, JSON.stringify({ version: 2, model: 'future' })); assert.equal(await main(['config', 'set', 'model', 'replacement'], out), 1); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 2, model: 'future' }); assert.match(errors.at(-1), /unsupported schema/);
  } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
});

test('interactive auth saves the prompted model and retains an existing model on Enter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-model-')); const old = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = dir;
  const output = []; const io = { stdin: Readable.from(['Prompted/Model\n']), stdout: { write(value) { output.push(value); } }, stderr: { write() {} } }; io.stdin.isTTY = true;
  const clientFactory = () => ({ async begin() { return { verificationUrl: 'https://example.test/device', userCode: 'CODE' }; }, async finish() {} });
  try {
    assert.equal(await main(['auth', 'login'], io, { clientFactory }), 0); assert.equal((await new ConfigStore(configPath()).load()).model, 'Prompted/Model'); assert.equal(output.some(value => value.includes('Model name?')), true);
    const retained = { stdin: Readable.from(['\n']), stdout: { write() {} }, stderr: { write() {} } }; retained.stdin.isTTY = true;
    assert.equal(await main(['auth', 'login'], retained, { clientFactory }), 0); assert.equal((await new ConfigStore(configPath()).load()).model, 'Prompted/Model');
  } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
});

test('noninteractive auth does not read stdin and reports missing model guidance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-nontty-')); const old = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = dir;
  let guidance = false; const io = { stdin: { isTTY: false, on() { throw new Error('must not read stdin'); } }, stdout: { write() {} }, stderr: { write(value) { if (value.includes('set a model')) guidance = true; } } };
  const clientFactory = () => ({ async begin() { return { verificationUrl: 'https://example.test/device', userCode: 'CODE' }; }, async finish() {} });
  try { assert.equal(await main(['auth', 'login'], io, { clientFactory }), 0); assert.equal(guidance, true); assert.equal(await new ConfigStore(configPath()).load(), null); } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
});

test('interactive auth reports unfinished model setup on EOF without erasing prior config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-eof-')); const old = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = dir;
  const store = new ConfigStore(configPath()); await store.save('existing-model'); const errors = [];
  const stdin = Readable.from([]); stdin.isTTY = true; const io = { stdin, stdout: { write() {} }, stderr: { write(value) { errors.push(value); } } };
  const clientFactory = () => ({ async begin() { return { verificationUrl: 'https://example.test/device', userCode: 'CODE' }; }, async finish() {} });
  try { assert.equal(await main(['auth', 'login'], io, { clientFactory }), 0); assert.equal((await store.load()).model, 'existing-model'); assert.match(errors.at(-1), /model setup unfinished/); } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
});

test('configPath falls back to isolated HOME config when XDG_CONFIG_HOME is absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yolo-config-home-')); const path = configPath({ HOME: home });
  assert.equal(path, join(home, '.config', 'yoloharness', 'config.json'));
  await new ConfigStore(path).save('home-model'); assert.equal((await new ConfigStore(path).load()).model, 'home-model');
});

test('empty and relative XDG_CONFIG_HOME use the absolute HOME root for model and credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yolo-config-root-'));
  const old = { xdg: process.env.XDG_CONFIG_HOME, home: process.env.HOME, auth: process.env.YOLO_AUTH_FILE };
  try {
    process.env.HOME = home;
    for (const xdg of ['', 'relative-config']) {
      process.env.XDG_CONFIG_HOME = xdg;
      assert.equal(configRoot(), join(home, '.config'));
      assert.equal(configPath(), join(home, '.config', 'yoloharness', 'config.json'));
      let credentialPath;
      const io = { stdin: { isTTY: false }, stdout: { write() {} }, stderr: { write() {} } };
      const clientFactory = store => { credentialPath = store.path; return { async begin() { return { verificationUrl: 'https://example.test/device', userCode: 'CODE' }; }, async finish() {} }; };
      assert.equal(await main(['auth', 'login'], io, { clientFactory }), 0);
      assert.equal(credentialPath, join(home, '.config', 'yoloharness', 'credentials.json'));
    }
  } finally {
    for (const [key, value] of [['XDG_CONFIG_HOME', old.xdg], ['HOME', old.home], ['YOLO_AUTH_FILE', old.auth]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('missing model command reports actionable guidance without inventing a model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yolo-missing-model-'));
  const old = { xdg: process.env.XDG_CONFIG_HOME, home: process.env.HOME, url: process.env.YOLO_RESPONSES_URL, model: process.env.YOLO_MODEL };
  const errors = [];
  try {
    process.env.HOME = home; delete process.env.XDG_CONFIG_HOME; delete process.env.YOLO_MODEL;
    process.env.YOLO_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
    assert.equal(await main(['prompt'], { stdout: { write() {} }, stderr: { write(value) { errors.push(value); } } }), 1);
    assert.match(errors.at(-1), /no model configured; run `yolo config set model <model-id>`/);
  } finally {
    for (const [key, value] of [['XDG_CONFIG_HOME', old.xdg], ['HOME', old.home], ['YOLO_RESPONSES_URL', old.url], ['YOLO_MODEL', old.model]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('interactive auth reports unfinished model setup on SIGINT without erasing prior config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-sigint-')); const old = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = dir;
  const store = new ConfigStore(configPath()); await store.save('existing-model'); const errors = [];
  const stdin = Readable.from(['\u0003']); stdin.isTTY = true; const io = { stdin, stdout: { write() {} }, stderr: { write(value) { errors.push(value); } } };
  const clientFactory = () => ({ async begin() { return { verificationUrl: 'https://example.test/device', userCode: 'CODE' }; }, async finish() {} });
  try { assert.equal(await Promise.race([main(['auth', 'login'], io, { clientFactory }), new Promise((_, reject) => setTimeout(() => reject(new Error('prompt hung')), 1000))]), 0); assert.equal((await store.load()).model, 'existing-model'); assert.match(errors.at(-1), /model setup unfinished/); }
  finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
});

test('shipped default I/O handles PTY SIGINT after auth and preserves config and credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-pty-'));
  const config = new ConfigStore(configPath({ XDG_CONFIG_HOME: dir }));
  await config.save('Existing/Exact-Case');
  const script = `import { main } from ${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)}; const clientFactory = store => ({ async begin() { return { verificationUrl: 'https://example.test/device', userCode: 'CODE' }; }, async finish() { await store.save({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', clientId: 'synthetic-client' }); } }); await main(['auth', 'login'], undefined, { clientFactory });`;
  const relay = `import os, pty, select, sys, time\npid, fd = pty.fork()\nif pid == 0:\n os.execvpe(${JSON.stringify(process.execPath)}, ${JSON.stringify([process.execPath, '--input-type=module', '-e', script])}, os.environ)\nsent = False\ndeadline = time.time() + 5\nwhile time.time() < deadline:\n r, _, _ = select.select([fd, sys.stdin], [], [], 0.1)\n if fd in r:\n  try: data = os.read(fd, 4096)\n  except OSError:\n   waited, status = os.waitpid(pid, 0); sys.exit(os.waitstatus_to_exitcode(status))\n  if not data:\n   waited, status = os.waitpid(pid, 0); sys.exit(os.waitstatus_to_exitcode(status))\n  os.write(sys.stdout.fileno(), data)\n  if b'Model name?' in data and not sent:\n   os.write(fd, b'\\x03'); sent = True\n if sys.stdin in r:\n  data = os.read(sys.stdin.fileno(), 4096)\n  if data: os.write(fd, data)\n try: waited, status = os.waitpid(pid, os.WNOHANG)\n except ChildProcessError: break\n if waited: sys.exit(os.waitstatus_to_exitcode(status))\ntry: os.kill(pid, 9)\nexcept ProcessLookupError: pass\nsys.exit(124)`;
  const child = spawn('python3', ['-c', relay], { cwd: process.cwd(), env: { ...process.env, XDG_CONFIG_HOME: dir, YOLO_AUTH_FILE: join(dir, 'credentials.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let error = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, error || output); assert.match(output, /Model name\?/); assert.match(output, /model setup unfinished/);
  assert.deepEqual(await config.load(), { version: 1, model: 'Existing/Exact-Case' });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8')), { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', clientId: 'synthetic-client' });
});

test('failed model config writes preserve the old file and remove temporary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-config-fault-')); const path = join(dir, 'config.json'); const original = new ConfigStore(path); await original.save('old-model');
  const failing = new ConfigStore(path, { syncFile: async () => { throw new Error('file fsync failed'); } }); await assert.rejects(failing.save('new-model'), /file fsync failed/);
  assert.deepEqual(await original.load(), { version: 1, model: 'old-model' }); assert.deepEqual((await readdir(dir)).filter(name => name.includes('.tmp')), []);
});

test('config command persists model and runtime override is non-persistent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-config-cli-')); const old = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = dir;
  try {
    const out = { stdout: { write() {} }, stderr: { write() {} } }; assert.equal(await main(['config', 'set', 'model', 'Exact-Case'], out), 0); assert.equal((await new ConfigStore(configPath()).load()).model, 'Exact-Case');
    delete process.env.YOLO_MODEL; assert.equal(await resolveModel(), 'Exact-Case'); process.env.YOLO_MODEL = 'Transient'; assert.equal(await resolveModel(), 'Transient'); assert.equal((await new ConfigStore(configPath()).load()).model, 'Exact-Case');
  } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; delete process.env.YOLO_MODEL; }
});

test('device auth issues, polls, exchanges, and stores restrictive credentials', async t => {
  const calls=[]; const {s,base}=await server((req,res)=>{ calls.push([req.method,req.url]); if(req.url==='/issue') return json(res,{user_code:'TEST-CODE',device_auth_id:'fixture-device',interval:1}); if(req.url==='/poll') return json(res,{authorization_code:'auth-code',code_verifier:'verifier'}); if(req.url==='/token') return json(res,{access_token:'access-secret',refresh_token:'refresh-secret',expires_in:3600}); }); t.after(()=>s.close());
  const dir=await mkdtemp(join(tmpdir(),'yolo-auth-')); const store=new AuthStore(join(dir,'credentials.json'));
  const client=new AuthClient({clientId:'fixture-client',issueUrl:`${base}/issue`,pollUrl:`${base}/poll`,tokenUrl:`${base}/token`,verificationUrl:`${base}/verify`,redirectUri:'http://localhost/cb',store,fetch});
  const attempt=await client.begin(); assert.equal(attempt.userCode,'TEST-CODE'); const ref=await client.finish(attempt,{sleep:async()=>{}}); assert.equal(ref.accessToken,'access-secret'); assert.deepEqual(calls.map(x=>x[1]),['/issue','/poll','/token']); assert.equal((await stat(store.path)).mode & 0o777,0o600); assert.match(await readFile(store.path,'utf8'),/access-secret/);
});

test('concurrent refresh clients reread the stored generation before consuming a rotating token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-race-')); const store = new AuthStore(join(dir, 'credentials.json'));
  await store.save({ accessToken: 'old', refreshToken: 'r0', generation: 0 }); let refreshes = 0;
  const fetcher = async () => { refreshes += 1; await new Promise(resolve => setTimeout(resolve, 10)); return { ok: true, async json() { return { access_token: `a${refreshes}`, refresh_token: `r${refreshes}`, expires_in: 3600 }; } }; };
  const config = { clientId: 'fixture', issueUrl: 'https://example.invalid/issue', pollUrl: 'https://example.invalid/poll', tokenUrl: 'https://example.invalid/token', redirectUri: 'https://example.invalid/cb', store, fetch: fetcher, lockTimeoutMs: 1000 };
  const [first, second] = await Promise.all([new AuthClient(config).refresh({ accessToken: 'old', refreshToken: 'r0', generation: 0 }), new AuthClient(config).refresh({ accessToken: 'old', refreshToken: 'r0', generation: 0 })]);
  assert.equal(refreshes, 1); assert.equal(first.accessToken, second.accessToken); assert.equal((await store.load()).generation, 1);
});

test('refresh persistence faults are observable and short receipt text is digested', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-fault-'));
  const path = join(dir, 'credentials.json');
  const baseStore = new AuthStore(path);
  await baseStore.save({ accessToken: 'old', refreshToken: 'r0', generation: 0 });
  class FaultStore extends AuthStore { async save() { throw new Error('directory fsync failed'); } }
  const client = new AuthClient({ clientId: 'fixture', issueUrl: 'https://example.invalid/i', pollUrl: 'https://example.invalid/p', tokenUrl: 'https://example.invalid/t', redirectUri: 'https://example.invalid/cb', store: new FaultStore(path), fetch: async () => ({ ok: true, async json() { return { access_token: 'new', refresh_token: 'r1' }; } }) });
  await assert.rejects(client.refresh(await baseStore.load()), /directory fsync failed/);
  const { EventLog } = await import('../src/events.mjs');
  const events = new EventLog(join(dir, 'events.jsonl'));
  await events.append('r', 'step', { prompt: 'Bearer short-secret-marker', result: 'short-result-marker', output: 'short-output-marker' });
  const raw = await readFile(join(dir, 'events.jsonl'), 'utf8');
  assert.equal(raw.includes('short-secret-marker'), false); assert.equal(raw.includes('short-result-marker'), false); assert.equal(raw.includes('short-output-marker'), false);
});


test('real AuthStore save surfaces injected temporary-file and directory fsync faults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-fsync-'));
  const path = join(dir, 'credentials.json');
  const fileStore = new AuthStore(path, { syncFile: async () => { throw new Error('file fsync failed'); } });
  await assert.rejects(fileStore.save({ accessToken: 'a', refreshToken: 'r' }), /file fsync failed/);
  assert.deepEqual((await readdir(dir)).filter(name => name.includes('.tmp')), []);
  const directoryStore = new AuthStore(path, { syncDirectory: async () => { throw new Error('directory fsync failed'); } });
  await assert.rejects(directoryStore.save({ accessToken: 'a', refreshToken: 'r' }), /directory fsync failed/);
  assert.deepEqual((await readdir(dir)).filter(name => name.includes('.tmp')), []);
});

test('two independent node processes consume one rotating refresh token', async t => {
  let refreshes = 0;
  const { s, base } = await server(async (req, res) => {
    refreshes += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return json(res, { access_token: `child-a${refreshes}`, refresh_token: `child-r${refreshes}`, expires_in: 3600 });
  });
  t.after(() => s.close());
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-process-'));
  const store = new AuthStore(join(dir, 'credentials.json'));
  await store.save({ accessToken: 'old', refreshToken: 'child-r0', generation: 0 });
  const modulePath = new URL('../src/auth.mjs', import.meta.url).href;
  const script = `import { AuthClient, AuthStore } from ${JSON.stringify(modulePath)}; const store = new AuthStore(process.env.STORE); const c = new AuthClient({ clientId: 'fixture', issueUrl: 'https://example.invalid/i', pollUrl: 'https://example.invalid/p', tokenUrl: process.env.TOKEN_URL, redirectUri: 'https://example.invalid/cb', store, fetch }); const value = await c.refresh(await store.load()); process.stdout.write(JSON.stringify(value));`;
  const run = () => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, STORE: store.path, TOKEN_URL: `${base}/token` } }); let out = ''; let err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; }); child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `child exit ${code}`))); });
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(refreshes, 1);
  assert.equal(first.generation, 1); assert.equal(second.generation, 1);
});


test('responses client parses split SSE text and completed tool roundtrip', async t => {
  const {s,base}=await server(async (req,res)=>{ assert.equal(req.url,'/responses'); const body=JSON.parse(await new Promise((resolve,reject)=>{let x='';req.on('data',c=>x+=c);req.on('end',()=>resolve(x));req.on('error',reject)})); assert.equal(body.store,false); assert.equal(body.model, 'fixture-model'); res.writeHead(200,{'content-type':'text/event-stream'}); const frames=['data: {"type":"response.output_text.delta","delta":"hel','lo"}\n\n','data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item1","call_id":"call1","name":"exec","arguments":""}}\n\n','data: {"type":"response.function_call_arguments.delta","item_id":"item1","delta":"{\\"command\\":\\"printf\\",\\"args\\":[\\"ok\\"]}"}\n\n','data: {"type":"response.output_item.done","item":{"type":"function_call","id":"item1","call_id":"call1","name":"exec","arguments":"{\\"command\\":\\"printf\\",\\"args\\":[\\"ok\\"]}","status":"completed"}}\n\n','data: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n']; for(const f of frames) { res.write(f); await new Promise(r=>setTimeout(r,1)); } res.end(); }); t.after(()=>s.close());
  const c=new ResponsesClient({url:`${base}/responses`,fetch,accessToken:'secret',model:'fixture-model'}); const events=[]; for await(const e of c.respond({input:[{role:'user',content:'hi'}],tools:[EXEC_TOOL]})) events.push(e); assert.equal(events.at(-1).status,'completed'); assert.equal(events.find(e=>e.type==='text_delta').delta,'hello'); assert.equal(events.find(e=>e.type==='tool_call').call.call_id,'call1');
});

test('local HTTP provider to runtime to executor preserves the exec bridge contract', async t => {
  let requestCount = 0;
  const { s, base } = await server(async (req, res) => {
    requestCount += 1;
    const body = JSON.parse(await new Promise(resolve => { let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => resolve(raw)); }));
    assert.deepEqual(body.tools, [EXEC_TOOL]);
    if (requestCount === 2) {
      const functionCall = body.input.find(item => item.type === 'function_call');
      const functionOutput = body.input.find(item => item.type === 'function_call_output');
      assert.equal(functionCall.call_id, 'bridge-1');
      assert.equal(functionOutput.call_id, 'bridge-1');
      assert.equal(JSON.parse(functionOutput.output).ok, false);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = requestCount === 1
      ? { type: 'response.output_item.done', item: { type: 'function_call', id: 'item-bridge', call_id: 'bridge-1', name: 'exec', arguments: JSON.stringify({ command: '/definitely/not-a-command', args: [] }), status: 'completed' } }
      : { type: 'response.completed', response: { id: 'response-2', status: 'completed' } };
    res.end(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: `response-${requestCount}`, status: 'completed' } })}\n\n`);
  });
  t.after(() => s.close());
  const calls = [];
  const provider = new ConfiguredProvider({ credentials: { accessToken: 'synthetic-token' }, url: `${base}/responses`, model: 'fixture', fetch });
  let envelope;
  const executor = new DockerExecutor({
    image: 'yolo:test', workspace: await mkdtemp(join(tmpdir(), 'yolo-bridge-')), preflight: async () => true,
    spawn: (command, args, options) => {
      const operation = args[0];
      if (operation === 'start') {
        const child = spawn(process.execPath, ['worker.mjs'], { ...options, cwd: process.cwd() });
        const originalEnd = child.stdin.end.bind(child.stdin);
        child.stdin.end = value => { envelope = JSON.parse(value); calls.push(envelope.call); return originalEnd(value); };
        return child;
      }
      const child = {
        stdin: { end(value) { if (operation === 'start') { envelope = JSON.parse(value); calls.push(envelope.call); } } },
        stdout: { on(event, fn) { if (event === 'data' && operation === 'inspect') setImmediate(() => fn(`Error: No such container: ${args.at(-1)}`)); } },
        stderr: { on() {} },
        kill() {},
        once(event, fn) { if (event === 'close') setImmediate(() => fn(operation === 'start' ? 0 : operation === 'inspect' ? 1 : 0)); },
      };
      return child;
    },
  });
  const record = await runOnce({ prompt: 'bridge', provider, executor, tools: [EXEC_TOOL] });
  assert.equal(record.status, 'completed', JSON.stringify(record));
  assert.deepEqual(calls, [{ command: '/definitely/not-a-command', args: [] }]);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.call_id, 'bridge-1');
});

test('SSE parser handles BOM, comments, CRLF and multiline data', async ()=> { const got=[...parseSSE(new TextEncoder().encode('\ufeff: hi\r\ndata: {"a":\r\ndata: 1}\r\n\r\n'))]; assert.deepEqual(got,['{"a":\n1}']); assert.deepEqual(JSON.parse(got[0]),{a:1}); });

test('docker executor fails closed without docker and never runs host shell', async ()=> { const ex=new DockerExecutor({command:'definitely-not-a-real-docker', spawn:()=>{throw new Error('host execution')}, image:'yolo:test'}); await assert.rejects(ex.preflight(),DockerUnavailableError); });

test('docker executor preserves the host Docker context for rootless CLI operations', async () => {
  let startOptions;
  const ex = new DockerExecutor({ image: 'yolo:test', workspace: '/tmp', preflight: async () => true, spawn: (command, args, options) => {
    const operation = args[0];
    const child = { stdin: { end() {} }, stdout: { on() {} }, stderr: { on() {} }, kill() {}, once(event, fn) { if (event === 'close') setImmediate(() => fn(operation === 'start' ? 0 : operation === 'inspect' ? 1 : 0)); } };
    if (operation === 'start') startOptions = options;
    if (operation === 'inspect') child.stdout.on = (event, fn) => event === 'data' && setImmediate(() => fn(`Error: No such container: ${args.at(-1)}`));
    return child;
  }});
  await assert.rejects(ex.execute({ call: { command: 'true', args: [], call_id: 'rootless-context' } }));
  assert.equal(startOptions.env.HOME, process.env.HOME);
  assert.equal(startOptions.env.XDG_RUNTIME_DIR, process.env.XDG_RUNTIME_DIR);
});

test('docker executor requests interactive stdin and handles output overflow without a signal', async () => {
  let seen;
  const ex = new DockerExecutor({ image: 'yolo:test', workspace: '/tmp', maxOutput: 10, spawn: (command, args) => { if (args[0] === 'create') seen = args; const child = { stdin: { end() {} }, stdout: { on(event, fn) { if (event === 'data' && args[0] === 'start') setImmediate(() => fn('x'.repeat(20))); if (event === 'data' && args[0] === 'inspect') setImmediate(() => fn(`Error: No such container: ${args.at(-1)}`)); } }, stderr: { on() {} }, kill() {}, once(event, fn) { if (event === 'close') { this.close = fn; setImmediate(() => fn(args[0] === 'inspect' ? 1 : 0)); } } }; return child; }, preflight: async () => true });
  await assert.rejects(ex.execute({ call: { command: 'printf', args: ['x'], call_id: 'overflow' } }), OutputLimitError);
  assert.equal(seen.includes('-i'), true);
});

test('docker create cancellation reaps and reconciles the exact generated identity', async () => {
  const commands = [];
  const controller = new AbortController();
  const ex = new DockerExecutor({ image: 'yolo:test', workspace: '/tmp', timeoutMs: 100, spawn: (command, args) => {
    commands.push(args);
    const child = { stdin: { end() {} }, stdout: { on() {} }, stderr: { on() {} }, kill() { setImmediate(() => child.close?.(137)); }, once(event, fn) { if (event === 'close') child.close = fn; } };
    if (args[0] === 'create') setImmediate(() => { controller.abort(new Error('cancelled')); });
    else if (args[0] === 'inspect') setImmediate(() => child.close?.(1)); else setImmediate(() => child.close?.(0));
    return child;
  }, preflight: async () => true });
  await assert.rejects(ex.execute({ call: { command: 'true', args: [], call_id: 'cancel-create' }, signal: controller.signal }));
  assert.equal(commands[0][0], 'create');
  assert.deepEqual(commands.slice(1).map(args => args[0]), ['kill', 'rm', 'inspect']);
  assert.equal(commands.slice(1).every(args => args.at(-1).startsWith('yoloharness-')), true);
});

test('docker executor rejects pre-aborted calls before creating a container', async () => {
  const controller = new AbortController(); controller.abort(new Error('pre-aborted'));
  let spawned = false;
  const ex = new DockerExecutor({ image: 'yolo:test', workspace: '/tmp', spawn: () => { spawned = true; throw new Error('must not spawn'); }, preflight: async () => true });
  await assert.rejects(ex.execute({ call: { command: 'true', args: [], call_id: 'pre-abort' }, signal: controller.signal }), /pre-aborted/);
  assert.equal(spawned, false);
});

test('docker create timeout waits for delayed child before exact cleanup', async () => {
  const commands = [];
  const ex = new DockerExecutor({ image: 'yolo:test', workspace: '/tmp', timeoutMs: 10, spawn: (command, args) => {
    commands.push(args);
    const child = { stdout: { on(event, fn) { if (event === 'data' && args[0] === 'inspect') setImmediate(() => fn(`Error: No such container: ${args.at(-1)}`)); } }, stderr: { on() {} }, kill() { setTimeout(() => child.close?.(137), 1); }, once(event, fn) { if (event === 'close') child.close = fn; } };
    if (args[0] === 'inspect') setImmediate(() => child.close?.(1)); else if (args[0] !== 'create') setImmediate(() => child.close?.(0));
    return child;
  }, preflight: async () => true });
  await assert.rejects(ex.execute({ call: { command: 'true', args: [], call_id: 'create-timeout' } }));
  assert.deepEqual(commands.map(args => args[0]), ['create', 'kill', 'rm', 'inspect']);
  assert.equal(commands.slice(1).every(args => args.at(-1) === commands[0][3]), true);
});

test('docker create output overflow waits for termination before exact cleanup', async () => {
  const commands = [];
  const ex = new DockerExecutor({ image: 'yolo:test', workspace: '/tmp', maxOutput: 4, spawn: (command, args) => {
    commands.push(args);
    const child = { stdout: { on(event, fn) { if (event === 'data' && args[0] === 'create') setImmediate(() => fn('xxxxx')); if (event === 'data' && args[0] === 'inspect') setImmediate(() => fn(`Error: No such container: ${args.at(-1)}`)); } }, stderr: { on() {} }, kill() { setImmediate(() => child.close?.(137)); }, once(event, fn) { if (event === 'close') child.close = fn; } };
    if (args[0] === 'inspect') setImmediate(() => child.close?.(1)); else if (args[0] !== 'create') setImmediate(() => child.close?.(0));
    return child;
  }, preflight: async () => true });
  await assert.rejects(ex.execute({ call: { command: 'true', args: [], call_id: 'create-overflow' } }), /cleanup/);
  assert.deepEqual(commands.map(args => args[0]), ['create', 'kill', 'rm', 'inspect']);
});

test('docker start cancellation reaps before exact cleanup and reconciliation', async () => {
  const commands = [];
  const controller = new AbortController();
  const ex = new DockerExecutor({ image: 'yolo:test', workspace: '/tmp', timeoutMs: 100, spawn: (command, args) => {
    commands.push(args);
    const child = { stdin: { end() {} }, stdout: { on() {} }, stderr: { on() {} }, kill() { setImmediate(() => child.close?.(137)); }, once(event, fn) { if (event === 'close') child.close = fn; } };
    if (args[0] === 'start') setImmediate(() => controller.abort(new Error('start cancelled')));
    else if (args[0] === 'inspect') setImmediate(() => child.close?.(1)); else setImmediate(() => child.close?.(0));
    return child;
  }, preflight: async () => true });
  await assert.rejects(ex.execute({ call: { command: 'true', args: [], call_id: 'start-cancel' }, signal: controller.signal }));
  assert.deepEqual(commands.map(args => args[0]), ['create', 'start', 'kill', 'rm', 'inspect']);
});

test('refresh reclaims a lock left by an actually crashed child process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-crash-')); const store = new AuthStore(join(dir, 'credentials.json'));
  await store.save({ accessToken: 'old', refreshToken: 'r0', generation: 0 });
  const lock = `${store.path}.lock`;
  const script = `import { mkdir, writeFile, utimes } from 'node:fs/promises'; await mkdir(process.env.LOCK); await writeFile(process.env.LOCK + '/owner.json', JSON.stringify({owner:'crashed-child',pid:process.pid})); const d=new Date(Date.now()-5000); await utimes(process.env.LOCK,d,d); process.exit(0);`;
  await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, LOCK: lock } }); child.on('close', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`))); });
  const client = new AuthClient({ clientId: 'fixture', issueUrl: 'https://example.invalid/i', pollUrl: 'https://example.invalid/p', tokenUrl: 'https://example.invalid/t', redirectUri: 'https://example.invalid/cb', store, lockTimeoutMs: 100, fetch: async () => ({ ok: true, async json() { return { access_token: 'new', refresh_token: 'r1' }; } }) });
  assert.equal((await client.refresh(await store.load())).accessToken, 'new');
});

test('stale refresh lock with a dead owner is reclaimed through the atomic acquire path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-stale-')); const store = new AuthStore(join(dir, 'credentials.json'));
  await store.save({ accessToken: 'old', refreshToken: 'r0', generation: 0 });
  const lock = `${store.path}.lock`; await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ owner: 'dead-owner', pid: 999999 }));
  const old = new Date(Date.now() - 5000); await utimes(lock, old, old);
  const client = new AuthClient({ clientId: 'fixture', issueUrl: 'https://example.invalid/i', pollUrl: 'https://example.invalid/p', tokenUrl: 'https://example.invalid/t', redirectUri: 'https://example.invalid/cb', store, lockTimeoutMs: 100, fetch: async () => ({ ok: true, async json() { return { access_token: 'new', refresh_token: 'r1' }; } }) });
  assert.equal((await client.refresh(await store.load())).accessToken, 'new');
});

test('actual child replacement owner survives a stale-lock reclaim interleaving', async t => {
  let refreshes = 0;
  const { s, base } = await server(async (req, res) => {
    refreshes += 1;
    return json(res, { access_token: `child-a${refreshes}`, refresh_token: `child-r${refreshes}`, expires_in: 3600 });
  });
  t.after(() => s.close());
  const dir = await mkdtemp(join(tmpdir(), 'yolo-auth-replacement-'));
  const store = new AuthStore(join(dir, 'credentials.json'));
  await store.save({ accessToken: 'old', refreshToken: 'child-r0', generation: 0 });
  const lock = `${store.path}.lock`;
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ owner: 'dead-owner', pid: 999999 }));
  const old = new Date(Date.now() - 30000); await utimes(lock, old, old);
  const modulePath = new URL('../src/auth.mjs', import.meta.url).href;
  const script = `import { AuthClient, AuthStore } from ${JSON.stringify(modulePath)}; import { writeFile, access } from 'node:fs/promises'; const store = new AuthStore(process.env.STORE); const config = { clientId: 'fixture', issueUrl: 'https://example.invalid/i', pollUrl: 'https://example.invalid/p', tokenUrl: process.env.TOKEN_URL, redirectUri: 'https://example.invalid/cb', store, lockTimeoutMs: 10000, fetch }; if (process.env.PAUSE) config.beforeReclaimRename = async () => { await writeFile(process.env.SIGNAL, 'ready'); while (true) { try { await access(process.env.RELEASE); break; } catch { await new Promise(r => setTimeout(r, 5)); } } }; if (process.env.CONTENDER) config.onLockContended = async () => { await writeFile(process.env.CONTENDER, 'entered'); }; if (process.env.ACQUIRED) config.onLockAcquired = async () => { await writeFile(process.env.ACQUIRED, 'acquired'); }; const value = await new AuthClient(config).refresh(await store.load()); process.stdout.write(JSON.stringify(value));`;
  const run = (extra = {}) => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...extra, STORE: store.path, TOKEN_URL: `${base}/token` } }); let out = ''; let err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; }); child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `child exit ${code}`))); });
  const signal = join(dir, 'reclaimer-ready');
  const first = run({ PAUSE: '1', SIGNAL: signal, RELEASE: join(dir, 'reclaimer-release') });
  for (let i = 0; i < 100 && !(await stat(signal).catch(() => null)); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.notEqual(await stat(signal).catch(() => null), null);
  const contender = join(dir, 'replacement-contender');
  const acquired = join(dir, 'replacement-acquired');
  const second = run({ CONTENDER: contender, ACQUIRED: acquired });
  for (let i = 0; i < 100 && !(await stat(contender).catch(() => null)); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.notEqual(await stat(contender).catch(() => null), null);
  assert.equal(await stat(acquired).catch(() => null), null);
  await writeFile(join(dir, 'reclaimer-release'), 'go');
  const [reclaimed, replacement] = await Promise.all([first, second]);
  assert.notEqual(await stat(acquired).catch(() => null), null);
  await assert.rejects(stat(lock), { code: 'ENOENT' });
  assert.equal(refreshes, 1);
  assert.equal(reclaimed.generation, 1); assert.equal(replacement.generation, 1);
  assert.equal((await store.load()).refreshToken, 'child-r1');
});


test('docker reconciliation binds not-found evidence to the exact generated identity', async () => {
  const run = async inspectOutputFor => {
    const commands = [];
    const ex = new DockerExecutor({ image: 'yolo:test', workspace: '/tmp', spawn: (command, args) => {
      commands.push(args);
      const child = { stdin: { end() {} }, stdout: { on(event, fn) { if (event === 'data' && args[0] === 'inspect') setImmediate(() => fn(inspectOutputFor(args.at(-1)))); if (event === 'data' && args[0] === 'start') setImmediate(() => fn(JSON.stringify({ version: 1, ok: true, call_id: 'inspect-case', code: 0, output: '' }) + '\n')); } }, stderr: { on() {} }, kill() {}, once(event, fn) { if (event === 'close') setImmediate(() => fn.call(child, args[0] === 'inspect' ? 1 : args[0] === 'start' ? 2 : 0)); } };
      return child;
    }, preflight: async () => true });
    let error;
    try { await ex.execute({ call: { command: 'true', args: [], call_id: 'inspect-case' } }); } catch (value) { error = value; }
    return { commands: commands.map(args => args[0]), error };
  };
  const absent = await run(name => `Error: No such container: ${name}`);
  assert.deepEqual(absent.commands, ['create', 'start', 'kill', 'rm', 'inspect']);
  assert.match(absent.error.message, /executor failed/);
  const rootlessAbsent = await run(name => `error: no such object: ${name}`);
  assert.deepEqual(rootlessAbsent.commands, ['create', 'start', 'kill', 'rm', 'inspect']);
  assert.match(rootlessAbsent.error.message, /executor failed/);
  const mismatched = await run(name => `Error: No such container: ${name}-suffix`);
  assert.match(mismatched.error.message, /cleanup/);
  const ambiguous = await run(() => 'Error: permission denied contacting daemon');
  assert.match(ambiguous.error.message, /cleanup/);
});

test('configured provider refreshes expired credentials before first provider request', async () => {
  const requests = [];
  const provider = new ConfiguredProvider({
    credentials: { accessToken: 'expired', refreshToken: 'r0', expiresAt: Date.now() - 1 },
    url: 'https://chatgpt.com/backend-api/codex/responses', model: 'fixture',
    fetch: async () => { requests.push('provider'); return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')); controller.close(); } }) }; },
    authClient: { async refresh(credentials) { requests.push('refresh'); return { ...credentials, accessToken: 'fresh', expiresAt: Date.now() + 100000 }; } },
  });
  await provider.next({ messages: [], tools: [], signal: new AbortController().signal });
  assert.deepEqual(requests, ['refresh', 'provider']);
});

test('default CLI omits exec capability when Docker execution is not selected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-cli-no-docker-'));
  const envNames = ['YOLO_REAL_DOCKER', 'YOLO_CLI_SIGINT_TEST', 'YOLO_CLI_SIGINT_CONTAINER_NAME', 'YOLO_AUTH_ISSUE_URL', 'YOLO_AUTH_POLL_URL', 'YOLO_AUTH_TOKEN_URL', 'YOLO_AUTH_VERIFY_URL', 'YOLO_AUTH_REDIRECT_URI'];
  const old = { xdg: process.env.XDG_CONFIG_HOME, model: process.env.YOLO_MODEL, image: process.env.YOLO_DOCKER_IMAGE, url: process.env.YOLO_RESPONSES_URL, auth: process.env.YOLO_AUTH_FILE, fetch: globalThis.fetch, env: Object.fromEntries(envNames.map(name => [name, process.env[name]])) };
  const requests = [];
  try {
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.YOLO_MODEL;
    delete process.env.YOLO_DOCKER_IMAGE;
    process.env.YOLO_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
    process.env.YOLO_AUTH_FILE = join(dir, 'credentials.json');
    for (const name of envNames) delete process.env[name];
    await new AuthStore(process.env.YOLO_AUTH_FILE).save({ clientId: 'synthetic-client', accessToken: 'synthetic-token', refreshToken: 'synthetic-refresh' });
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')); controller.close(); } }) };
    };
    await new ConfigStore(configPath()).save('synthetic-model');
    const output = []; const errors = [];
    assert.equal(await main(['--json', 'text only'], { stdin: { isTTY: false }, stdout: { write(value) { output.push(value); } }, stderr: { write(value) { errors.push(value); } } }), 0);
    assert.deepEqual(requests.map(request => request.tools), [[]]);
    assert.equal(JSON.parse(output.at(-1)).status, 'completed');
    assert.deepEqual(errors, ['starting bounded run (10 minutes)\n']);
  } finally {
    if (old.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old.xdg;
    if (old.model === undefined) delete process.env.YOLO_MODEL; else process.env.YOLO_MODEL = old.model;
    if (old.image === undefined) delete process.env.YOLO_DOCKER_IMAGE; else process.env.YOLO_DOCKER_IMAGE = old.image;
    if (old.url === undefined) delete process.env.YOLO_RESPONSES_URL; else process.env.YOLO_RESPONSES_URL = old.url;
    if (old.auth === undefined) delete process.env.YOLO_AUTH_FILE; else process.env.YOLO_AUTH_FILE = old.auth;
    for (const name of envNames) {
      const value = old.env[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    globalThis.fetch = old.fetch;
  }
});

test('runtime rejects unsolicited tool calls without an executor', async () => {
  const record = await runOnce({ prompt: 'text only', provider: { async next() { return { tool_call: { name: 'exec', call_id: 'unexpected', arguments: JSON.stringify({ command: 'true', args: [] }) } }; } } });
  assert.equal(record.status, 'failed');
  assert.deepEqual(record.errors, ['effect dispatch unavailable: no supported executor selected']);
});

test('configured provider retries exactly one actual 401', async () => {
  let requests = 0; let refreshes = 0;
  const provider = new ConfiguredProvider({
    credentials: { accessToken: 'stale', refreshToken: 'r0' }, url: 'https://chatgpt.com/backend-api/codex/responses', model: 'fixture',
    fetch: async () => { requests += 1; if (requests === 1) return { ok: false, status: 401 }; return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')); controller.close(); } }) }; },
    authClient: { async refresh(credentials) { refreshes += 1; return { ...credentials, accessToken: 'fresh' }; } },
  });
  await provider.next({ messages: [], tools: [], signal: new AbortController().signal });
  assert.equal(requests, 2); assert.equal(refreshes, 1);
});


test('responses rejects an oversized event', async () => {
  const body = ReadableStream.from ? ReadableStream.from([new TextEncoder().encode(`data: {"type":"response.output_text.delta","delta":"${'x'.repeat(1024 * 1024 + 1)}"}\n\n`)]) : null;
  if (!body) return;
  const c = new ResponsesClient({ url: 'http://127.0.0.1', model: 'fixture', accessToken: 'secret', fetch: async () => ({ ok: true, body }) });
  await assert.rejects((async () => { for await (const _ of c.respond()) {} })(), /too large/);
});

test('worker receipts use a closed, typed success/failure schema', () => {
  assert.equal(validateReceipt({ version: 1, ok: true, call_id: 'c', code: 0, output: '' }, 'c'), true);
  assert.equal(validateReceipt({ version: 1, ok: true, call_id: 'c', code: 0, output: [] }, 'c'), false);
  assert.equal(validateReceipt({ version: 1, ok: true, call_id: 'c', code: 1, output: '' }, 'c'), false);
  assert.equal(validateReceipt({ version: 1, ok: false, call_id: 'c', code: 1, output: '', error: 'failed', extra: 1 }, 'c'), false);
});

test('DockerExecutor accepts the shipped worker validation failure through its receipt parser', async () => {
  const operations = [];
  const ex = new DockerExecutor({ image: 'yolo:test', workspace: '/tmp', spawn: (command, args, options) => {
    operations.push(args[0]);
    const child = { stdin: { end() {} }, stdout: { on(event, fn) {
      if (event !== 'data') return;
      if (args[0] === 'create') setImmediate(() => fn(`${args[3]}\n`));
      if (args[0] === 'inspect') setImmediate(() => fn(`Error: No such container: ${args.at(-1)}`));
    } }, stderr: { on() {} }, kill() {}, once(event, fn) { if (event === 'close') setImmediate(() => fn(args[0] === 'inspect' ? 1 : 0)); } };
    if (args[0] === 'start') return spawn(process.execPath, ['worker.mjs'], { ...options, cwd: process.cwd() });
    return child;
  }, preflight: async () => true });
  const receipt = await ex.execute({ call: { command: '', args: [], call_id: 'invalid-call' } });
  assert.equal(validateReceipt(receipt, 'invalid-call'), true);
  assert.equal(receipt.ok, false);
  assert.deepEqual(operations, ['create', 'start', 'kill', 'rm', 'inspect']);
});

test('worker emits paired typed failure receipts for spawn and validation errors', async () => {
  const worker = spawn(process.execPath, ['worker.mjs'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  worker.stdin.end(JSON.stringify({ version: 1, call_id: 'missing-command', call: { command: '/definitely/not-a-command', args: [] } }) + '\n');
  const chunks = [];
  for await (const chunk of worker.stdout) chunks.push(chunk);
  const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
  assert.equal(validateReceipt(receipt, 'missing-command'), true);
  assert.equal(receipt.ok, false);
  assert.equal(typeof receipt.output, 'string');
  assert.equal(Number.isInteger(receipt.code), true);
  assert.equal(receipt.call_id, 'missing-command');
  const invalid = spawn(process.execPath, ['worker.mjs'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  invalid.stdin.end(JSON.stringify({ version: 1, call_id: 'invalid-call', call: { command: '', args: [] } }) + '\n');
  const invalidChunks = [];
  for await (const chunk of invalid.stdout) invalidChunks.push(chunk);
  const invalidReceipt = JSON.parse(Buffer.concat(invalidChunks).toString('utf8').trim());
  assert.equal(validateReceipt(invalidReceipt, 'invalid-call'), true);
  assert.equal(invalidReceipt.ok, false);
  assert.equal(invalidReceipt.code > 0, true);
  assert.equal(typeof invalidReceipt.output, 'string');
  assert.equal(invalidReceipt.call_id, 'invalid-call');
});

test('production endpoint rejects query and fragment before credential reads', async () => {
  const old = { url: process.env.YOLO_RESPONSES_URL, model: process.env.YOLO_MODEL, file: process.env.YOLO_AUTH_FILE };
  process.env.YOLO_MODEL = 'fixture'; process.env.YOLO_AUTH_FILE = '/definitely/not/readable/credentials.json';
  for (const value of [
    'https://chatgpt.com/backend-api/codex/responses?exfil=1',
    'https://chatgpt.com/backend-api/codex/responses#fragment',
    'https://chatgpt.com:443/backend-api/codex/responses',
    'https://user:pass@chatgpt.com/backend-api/codex/responses',
    'https://chatgpt.com/backend-api/codex/%72esponses',
    'HTTPS://chatgpt.com/backend-api/codex/responses',
    'http://127.0.0.1:1234/responses',
  ]) {
    process.env.YOLO_RESPONSES_URL = value;
    await assert.rejects(configuredProvider(), /canonical HTTPS Responses endpoint/);
  }
  for (const [key, value] of Object.entries({ YOLO_RESPONSES_URL: old.url, YOLO_MODEL: old.model, YOLO_AUTH_FILE: old.file })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('production auth endpoint rejects poisoned token URL before credential reads', async () => {
  const old = { responses: process.env.YOLO_RESPONSES_URL, model: process.env.YOLO_MODEL, file: process.env.YOLO_AUTH_FILE, token: process.env.YOLO_AUTH_TOKEN_URL };
  process.env.YOLO_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
  process.env.YOLO_MODEL = 'fixture'; process.env.YOLO_AUTH_FILE = '/definitely/not/readable/credentials.json';
  process.env.YOLO_AUTH_TOKEN_URL = 'http://127.0.0.1:43210/capture';
  await assert.rejects(configuredProvider(), /YOLO_AUTH_TOKEN_URL must be the canonical HTTPS auth endpoint/);
  for (const [key, value] of Object.entries({ YOLO_RESPONSES_URL: old.responses, YOLO_MODEL: old.model, YOLO_AUTH_FILE: old.file, YOLO_AUTH_TOKEN_URL: old.token })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('production provider uses stored client identity when transient env is absent', async () => {
  const old = { url: process.env.YOLO_RESPONSES_URL, model: process.env.YOLO_MODEL, file: process.env.YOLO_AUTH_FILE, client: process.env.YOLO_CLIENT_ID };
  const dir = await mkdtemp(join(tmpdir(), 'yolo-cli-auth-'));
  process.env.YOLO_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
  process.env.YOLO_MODEL = 'fixture'; process.env.YOLO_AUTH_FILE = join(dir, 'credentials.json'); delete process.env.YOLO_CLIENT_ID;
  await new AuthStore(process.env.YOLO_AUTH_FILE).save({ accessToken: 'synthetic', refreshToken: 'refresh', clientId: 'stored-client' });
  const provider = await configuredProvider();
  assert.equal(provider.authClient.config.clientId, 'stored-client');
  for (const [key, value] of Object.entries({ YOLO_RESPONSES_URL: old.url, YOLO_MODEL: old.model, YOLO_AUTH_FILE: old.file, YOLO_CLIENT_ID: old.client })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('saved model reaches the production configured provider request body without YOLO_MODEL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-provider-saved-model-'));
  const old = { xdg: process.env.XDG_CONFIG_HOME, model: process.env.YOLO_MODEL, url: process.env.YOLO_RESPONSES_URL, file: process.env.YOLO_AUTH_FILE, fetch: globalThis.fetch };
  try {
    process.env.XDG_CONFIG_HOME = dir; delete process.env.YOLO_MODEL; process.env.YOLO_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'; process.env.YOLO_AUTH_FILE = join(dir, 'credentials.json');
    await new ConfigStore(configPath()).save('Saved/Exact-Case');
    await new AuthStore(process.env.YOLO_AUTH_FILE).save({ accessToken: 'synthetic', refreshToken: 'refresh', clientId: 'stored-client' });
    let requestBody;
    globalThis.fetch = async (_url, init) => { requestBody = JSON.parse(init.body); return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }); };
    const provider = await configuredProvider(); await provider.next({ messages: [{ role: 'user', content: 'saved model' }], tools: [], signal: new AbortController().signal });
    assert.equal(requestBody.model, 'Saved/Exact-Case');
  } finally {
    for (const [key, value] of [['XDG_CONFIG_HOME', old.xdg], ['YOLO_MODEL', old.model], ['YOLO_RESPONSES_URL', old.url], ['YOLO_AUTH_FILE', old.file]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    globalThis.fetch = old.fetch;
  }
});

test('packed package bin runs offline from an extracted artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-pack-'));
  try {
    const packed = execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: process.cwd(), encoding: 'utf8' }).trim().split(/\r?\n/).at(-1);
    execFileSync('tar', ['-xzf', join(dir, packed), '-C', dir]);
    const output = execFileSync(process.execPath, [join(dir, 'package', 'src/cli.mjs'), '--fixture', '--json', 'offline smoke'], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).status, 'completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
