import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthClient, AuthStore } from '../src/auth.mjs';
import { ResponsesClient, parseSSE } from '../src/responses.mjs';
import { DockerExecutor, DockerUnavailableError } from '../src/docker-executor.mjs';

const json = (res, value, status=200) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(value)); };
function server(handler) { return new Promise(async resolve => { const s=http.createServer(handler); await new Promise(r=>s.listen(0,'127.0.0.1',r)); resolve({s, base:`http://127.0.0.1:${s.address().port}`}); }); }

test('device auth issues, polls, exchanges, and stores restrictive credentials', async t => {
  const calls=[]; const {s,base}=await server((req,res)=>{ calls.push([req.method,req.url]); if(req.url==='/issue') return json(res,{user_code:'TEST-CODE',device_auth_id:'fixture-device',interval:1}); if(req.url==='/poll') return json(res,{authorization_code:'auth-code',code_verifier:'verifier'}); if(req.url==='/token') return json(res,{access_token:'access-secret',refresh_token:'refresh-secret',expires_in:3600}); }); t.after(()=>s.close());
  const dir=await mkdtemp(join(tmpdir(),'yolo-auth-')); const store=new AuthStore(join(dir,'credentials.json'));
  const client=new AuthClient({clientId:'fixture-client',issueUrl:`${base}/issue`,pollUrl:`${base}/poll`,tokenUrl:`${base}/token`,verificationUrl:`${base}/verify`,redirectUri:'http://localhost/cb',store,fetch});
  const attempt=await client.begin(); assert.equal(attempt.userCode,'TEST-CODE'); const ref=await client.finish(attempt,{sleep:async()=>{}}); assert.equal(ref.accessToken,'access-secret'); assert.deepEqual(calls.map(x=>x[1]),['/issue','/poll','/token']); assert.equal((await stat(store.path)).mode & 0o777,0o600); assert.match(await readFile(store.path,'utf8'),/access-secret/);
});

test('responses client parses split SSE text and completed tool roundtrip', async t => {
  const {s,base}=await server(async (req,res)=>{ assert.equal(req.url,'/responses'); const body=JSON.parse(await new Promise((resolve,reject)=>{let x='';req.on('data',c=>x+=c);req.on('end',()=>resolve(x));req.on('error',reject)})); assert.equal(body.store,false); res.writeHead(200,{'content-type':'text/event-stream'}); const frames=['data: {"type":"response.output_text.delta","delta":"hel','lo"}\n\n','data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item1","call_id":"call1","name":"read_file","arguments":""}}\n\n','data: {"type":"response.function_call_arguments.delta","item_id":"item1","delta":"{\\"path\\":\\"README.md\\"}"}\n\n','data: {"type":"response.output_item.done","item":{"type":"function_call","id":"item1","call_id":"call1","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}","status":"completed"}}\n\n','data: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n']; for(const f of frames) { res.write(f); await new Promise(r=>setTimeout(r,1)); } res.end(); }); t.after(()=>s.close());
  const c=new ResponsesClient({url:`${base}/responses`,fetch,accessToken:'secret',model:'fixture-model'}); const events=[]; for await(const e of c.respond({input:[{role:'user',content:'hi'}],tools:[{type:'function',name:'read_file',parameters:{type:'object'}}]})) events.push(e); assert.equal(events.at(-1).status,'completed'); assert.equal(events.find(e=>e.type==='text_delta').delta,'hello'); assert.equal(events.find(e=>e.type==='tool_call').call.call_id,'call1');
});

test('SSE parser handles BOM, comments, CRLF and multiline data', async ()=> { const got=[...parseSSE(new TextEncoder().encode('\ufeff: hi\r\ndata: {"a":\r\ndata: 1}\r\n\r\n'))]; assert.deepEqual(got,['{"a":\n1}']); assert.deepEqual(JSON.parse(got[0]),{a:1}); });

test('docker executor fails closed without docker and never runs host shell', async ()=> { const ex=new DockerExecutor({command:'definitely-not-a-real-docker', spawn:()=>{throw new Error('host execution')}, image:'yolo:test'}); await assert.rejects(ex.preflight(),DockerUnavailableError); });
