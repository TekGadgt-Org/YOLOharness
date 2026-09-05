import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ContainerLauncher } from '../src/container-launcher.mjs';
import { runtimeSourceIdentity, main } from '../src/cli.mjs';

const enabled = process.env.YOLO_REAL_DOCKER === '1';
const image = process.env.YOLO_DOCKER_IMAGE ?? 'yoloharness-local:0.1.0';
const skip = !enabled;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' });

test('shipped CLI runs the whole runtime in the configured immutable image against an isolated synthetic provider', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-whole-runtime-');
  const capture = await mkdtemp('/tmp/yoloharness-provider-capture-');
  const network = `yoloharness-test-${process.pid}`;
  const providerScript = "const http=require('http'),fs=require('fs');let n=0;const s=http.createServer((q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{n++;fs.writeFileSync('/capture/request-'+n+'.json',JSON.stringify({body:b,remote:q.socket.remoteAddress,pid:process.pid}));r.writeHead(200,{'content-type':'text/event-stream'});const e=n===1?{type:'response.output_item.done',item:{type:'function_call',id:'item-1',call_id:'synthetic-1',name:'exec',arguments:JSON.stringify({command:'printf',args:['whole-runtime-ok']}),status:'completed'}}:{type:'response.completed',response:{id:'synthetic-2',status:'completed'}};const events=n===1?[e,{type:'response.completed',response:{id:'synthetic-1',status:'completed'}}]:[{type:'response.output_text.delta',delta:'whole-runtime-ok'},e];r.end(events.map(x=>'data: '+JSON.stringify(x)+'\\n\\n').join(''))})});s.listen(8080,'0.0.0.0',()=>fs.writeFileSync('/capture/ready','ready'));";
  const imageId = docker('image', 'inspect', '--format', '{{.Id}}', image).trim();
  const sourceIdentity = await runtimeSourceIdentity();
  const dataHome = await mkdtemp('/tmp/yoloharness-image-metadata-');
  const configHome = await mkdtemp('/tmp/yoloharness-config-');
  const originalCwd = process.cwd();
  const oldEnv = { xdgConfig: process.env.XDG_CONFIG_HOME, xdgData: process.env.XDG_DATA_HOME, auth: process.env.YOLO_AUTH_FILE, endpoint: process.env.YOLO_RESPONSES_URL };
  try {
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = dataHome;
    process.env.YOLO_AUTH_FILE = join(configHome, 'yoloharness', 'credentials.json');
    process.env.YOLO_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
    docker('network', 'create', network);
    docker('run', '--detach', '--pull=never', '--network', network, '--name', `${network}-provider`, '--mount', `type=bind,src=${capture},dst=/capture,readonly=false`, '--entrypoint', 'node', image, '-e', providerScript);
    for (let i = 0; i < 100; i += 1) {
      if (await access(join(capture, 'ready')).then(() => true).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await access(join(capture, 'ready')).then(() => true).catch(() => false), true);
    await mkdir(join(dataHome, 'yoloharness'), { recursive: true });
    await mkdir(join(configHome, 'yoloharness'), { recursive: true });
    await writeFile(join(dataHome, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId, ...sourceIdentity }));
    await writeFile(join(configHome, 'yoloharness', 'credentials.json'), JSON.stringify({ accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', clientId: 'synthetic-client', expiresAt: Date.now() + 1_800_000 }));
    await writeFile(join(configHome, 'yoloharness', 'config.json'), JSON.stringify({ version: 1, model: 'synthetic-model' }));
    process.chdir(workspace);
    const output = [];
    const errors = [];
    const recordCode = await main(['--json', 'whole-runtime nonce synthetic'], { stdin: { isTTY: false }, stdout: { write(value) { output.push(value); } }, stderr: { write(value) { errors.push(value); } } }, {
      allowTestSeams: true,
      launcherFactory: ({ image: configured, workspace: selected, timeoutMs, testOnly }) => new ContainerLauncher({ image: configured, workspace: selected, timeoutMs, network, responsesUrl: `http://${network}-provider:8080/responses`, testOnly }),
    });
    assert.equal(recordCode, 0, `${errors.join('')}${output.join('')}`);
    const record = JSON.parse(output.at(-1));
    assert.equal(record.status, 'completed');
    assert.equal(record.result, 'whole-runtime-ok');
    const request = JSON.parse(await readFile(join(capture, 'request-1.json'), 'utf8'));
    assert.match(request.body, /whole-runtime nonce synthetic/);
    assert.equal(request.remote.length > 0, true);
    const secondRequest = JSON.parse(await readFile(join(capture, 'request-2.json'), 'utf8'));
    assert.match(secondRequest.body, /synthetic-1/);
    assert.equal(await access(join(workspace, '.yolo', 'runs')).then(() => true).catch(() => false), true);
  } finally {
    process.chdir(originalCwd);
    docker('rm', '--force', `${network}-provider`);
    docker('network', 'rm', network);
    for (const [key, value] of [['XDG_CONFIG_HOME', oldEnv.xdgConfig], ['XDG_DATA_HOME', oldEnv.xdgData], ['YOLO_AUTH_FILE', oldEnv.auth], ['YOLO_RESPONSES_URL', oldEnv.endpoint]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(workspace, { recursive: true, force: true }); await rm(capture, { recursive: true, force: true }); await rm(dataHome, { recursive: true, force: true }); await rm(configHome, { recursive: true, force: true });
  }
});

test('final image has a read-only root and rootless UID0 workspace write/delete canary', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-image-canary-');
  try {
    const output = docker('run', '--rm', '--pull=never', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m', '--mount', `type=bind,src=${workspace},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--user', '0:0', '--entrypoint', 'sh', image, '-c', 'id -u; touch /workspace/canary; rm /workspace/canary; ! touch /app/forbidden');
    assert.match(output, /^0\n/);
    await assert.rejects(access(join(workspace, 'canary')));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});