import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthClient, AuthStore } from '../src/auth.mjs';
import { ResponsesClient, parseSSE } from '../src/responses.mjs';
import { DockerExecutor, DockerUnavailableError, OutputLimitError, validateReceipt } from '../src/docker-executor.mjs';
import { configuredProvider } from '../src/cli.mjs';

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

test('responses client parses split SSE text and completed tool roundtrip', async t => {
  const {s,base}=await server(async (req,res)=>{ assert.equal(req.url,'/responses'); const body=JSON.parse(await new Promise((resolve,reject)=>{let x='';req.on('data',c=>x+=c);req.on('end',()=>resolve(x));req.on('error',reject)})); assert.equal(body.store,false); res.writeHead(200,{'content-type':'text/event-stream'}); const frames=['data: {"type":"response.output_text.delta","delta":"hel','lo"}\n\n','data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item1","call_id":"call1","name":"read_file","arguments":""}}\n\n','data: {"type":"response.function_call_arguments.delta","item_id":"item1","delta":"{\\"path\\":\\"README.md\\"}"}\n\n','data: {"type":"response.output_item.done","item":{"type":"function_call","id":"item1","call_id":"call1","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}","status":"completed"}}\n\n','data: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n']; for(const f of frames) { res.write(f); await new Promise(r=>setTimeout(r,1)); } res.end(); }); t.after(()=>s.close());
  const c=new ResponsesClient({url:`${base}/responses`,fetch,accessToken:'secret',model:'fixture-model'}); const events=[]; for await(const e of c.respond({input:[{role:'user',content:'hi'}],tools:[{type:'function',name:'read_file',parameters:{type:'object'}}]})) events.push(e); assert.equal(events.at(-1).status,'completed'); assert.equal(events.find(e=>e.type==='text_delta').delta,'hello'); assert.equal(events.find(e=>e.type==='tool_call').call.call_id,'call1');
});

test('SSE parser handles BOM, comments, CRLF and multiline data', async ()=> { const got=[...parseSSE(new TextEncoder().encode('\ufeff: hi\r\ndata: {"a":\r\ndata: 1}\r\n\r\n'))]; assert.deepEqual(got,['{"a":\n1}']); assert.deepEqual(JSON.parse(got[0]),{a:1}); });

test('docker executor fails closed without docker and never runs host shell', async ()=> { const ex=new DockerExecutor({command:'definitely-not-a-real-docker', spawn:()=>{throw new Error('host execution')}, image:'yolo:test'}); await assert.rejects(ex.preflight(),DockerUnavailableError); });

test('docker executor requests interactive stdin and handles output overflow without a signal', async () => {
  let seen;
  const ex = new DockerExecutor({ image: 'yolo:test', workspace: '/tmp', maxOutput: 10, spawn: (command, args) => { if (args[0] === 'create') seen = args; const child = { stdin: { end() {} }, stdout: { on(event, fn) { if (event === 'data' && args[0] === 'start') setImmediate(() => fn('x'.repeat(20))); } }, stderr: { on() {} }, kill() {}, once(event, fn) { if (event === 'close') { this.close = fn; setImmediate(() => fn(0)); } } }; return child; }, preflight: async () => true });
  await assert.rejects(ex.execute({ call: { command: 'printf', args: ['x'], call_id: 'overflow' } }), OutputLimitError);
  assert.equal(seen.includes('-i'), true);
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
  for (const suffix of ['?exfil=1', '#fragment', ':443']) {
    process.env.YOLO_RESPONSES_URL = `https://chatgpt.com/backend-api/codex/responses${suffix}`;
    await assert.rejects(configuredProvider(), /canonical HTTPS Responses endpoint/);
  }
  for (const [key, value] of Object.entries({ YOLO_RESPONSES_URL: old.url, YOLO_MODEL: old.model, YOLO_AUTH_FILE: old.file })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
