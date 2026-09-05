import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AuthClient, AuthStore } from '../src/auth.mjs';
import { ResponsesClient, parseSSE } from '../src/responses.mjs';
import { DockerExecutor, DockerUnavailableError, OutputLimitError, validateReceipt } from '../src/docker-executor.mjs';
import { configuredProvider } from '../src/cli.mjs';
import { runOnce, EXEC_TOOL } from '../src/runtime.mjs';
import { ConfiguredProvider } from '../src/provider.mjs';

const json = (res, value, status=200) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(value)); };
function server(handler) { return new Promise(async resolve => { const s=http.createServer(handler); await new Promise(r=>s.listen(0,'127.0.0.1',r)); resolve({s, base:`http://127.0.0.1:${s.address().port}`}); }); }

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
  const {s,base}=await server(async (req,res)=>{ assert.equal(req.url,'/responses'); const body=JSON.parse(await new Promise((resolve,reject)=>{let x='';req.on('data',c=>x+=c);req.on('end',()=>resolve(x));req.on('error',reject)})); assert.equal(body.store,false); res.writeHead(200,{'content-type':'text/event-stream'}); const frames=['data: {"type":"response.output_text.delta","delta":"hel','lo"}\n\n','data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item1","call_id":"call1","name":"exec","arguments":""}}\n\n','data: {"type":"response.function_call_arguments.delta","item_id":"item1","delta":"{\\"command\\":\\"printf\\",\\"args\\":[\\"ok\\"]}"}\n\n','data: {"type":"response.output_item.done","item":{"type":"function_call","id":"item1","call_id":"call1","name":"exec","arguments":"{\\"command\\":\\"printf\\",\\"args\\":[\\"ok\\"]}","status":"completed"}}\n\n','data: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n']; for(const f of frames) { res.write(f); await new Promise(r=>setTimeout(r,1)); } res.end(); }); t.after(()=>s.close());
  const c=new ResponsesClient({url:`${base}/responses`,fetch,accessToken:'secret',model:'fixture-model'}); const events=[]; for await(const e of c.respond({input:[{role:'user',content:'hi'}],tools:[EXEC_TOOL]})) events.push(e); assert.equal(events.at(-1).status,'completed'); assert.equal(events.find(e=>e.type==='text_delta').delta,'hello'); assert.equal(events.find(e=>e.type==='tool_call').call.call_id,'call1');
});

test('local HTTP provider to runtime to executor preserves the exec bridge contract', async t => {
  let requestCount = 0;
  const { s, base } = await server(async (req, res) => {
    requestCount += 1;
    const body = JSON.parse(await new Promise(resolve => { let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => resolve(raw)); }));
    assert.deepEqual(body.tools, [EXEC_TOOL]);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = requestCount === 1
      ? { type: 'response.output_item.done', item: { type: 'function_call', id: 'item-bridge', call_id: 'bridge-1', name: 'exec', arguments: JSON.stringify({ command: 'printf', args: ['ok'] }), status: 'completed' } }
      : { type: 'response.completed', response: { id: 'response-2', status: 'completed' } };
    res.end(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: `response-${requestCount}`, status: 'completed' } })}\n\n`);
  });
  t.after(() => s.close());
  const calls = [];
  const provider = new ConfiguredProvider({ credentials: { accessToken: 'synthetic-token' }, url: `${base}/responses`, model: 'fixture', fetch });
  const executor = { async execute({ call }) { calls.push(call); return { version: 1, ok: true, call_id: call.call_id, code: 0, output: 'ok' }; } };
  const record = await runOnce({ prompt: 'bridge', provider, executor, tools: [EXEC_TOOL], workspace: await mkdtemp(join(tmpdir(), 'yolo-')) });
  assert.equal(record.status, 'completed');
  assert.deepEqual(calls, [{ command: 'printf', args: ['ok'], call_id: 'bridge-1' }]);
});

test('SSE parser handles BOM, comments, CRLF and multiline data', async ()=> { const got=[...parseSSE(new TextEncoder().encode('\ufeff: hi\r\ndata: {"a":\r\ndata: 1}\r\n\r\n'))]; assert.deepEqual(got,['{"a":\n1}']); assert.deepEqual(JSON.parse(got[0]),{a:1}); });

test('docker executor fails closed without docker and never runs host shell', async ()=> { const ex=new DockerExecutor({command:'definitely-not-a-real-docker', spawn:()=>{throw new Error('host execution')}, image:'yolo:test'}); await assert.rejects(ex.preflight(),DockerUnavailableError); });

test('docker executor requests interactive stdin and handles output overflow without a signal', async () => {
  let seen;
  const ex = new DockerExecutor({ image: 'yolo:test', workspace: '/tmp', maxOutput: 10, spawn: (command, args) => { if (args[0] === 'create') seen = args; const child = { stdin: { end() {} }, stdout: { on(event, fn) { if (event === 'data' && args[0] === 'start') setImmediate(() => fn('x'.repeat(20))); } }, stderr: { on() {} }, kill() {}, once(event, fn) { if (event === 'close') { this.close = fn; setImmediate(() => fn(args[0] === 'inspect' ? 1 : 0)); } } }; return child; }, preflight: async () => true });
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
    else if (args[0] === 'inspect') setImmediate(() => child.close?.(1));
    else setImmediate(() => child.close?.(0));
    return child;
  }, preflight: async () => true });
  await assert.rejects(ex.execute({ call: { command: 'true', args: [], call_id: 'cancel-create' }, signal: controller.signal }));
  assert.equal(commands[0][0], 'create');
  assert.deepEqual(commands.slice(1).map(args => args[0]), ['kill', 'rm', 'inspect']);
  assert.equal(commands.slice(1).every(args => args.at(-1).startsWith('yoloharness-')), true);
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
