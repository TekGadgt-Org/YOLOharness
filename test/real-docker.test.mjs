import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { runtimeSourceIdentity } from '../src/cli.mjs';

const enabled = process.env.YOLO_REAL_DOCKER === '1';
const configuredImage = process.env.YOLO_DOCKER_IMAGE ?? 'yoloharness-local:0.1.0';
const skip = !enabled;
const dockerPath = execFileSync('command', ['-v', 'docker'], { shell: '/bin/sh', encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync(dockerPath, args, { encoding: 'utf8' });
const bestEffortDocker = (...args) => { try { docker(...args); } catch {} };
const waitFor = async (path, timeout = 10_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await access(path).then(() => true).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
};
const restoreEnv = (old) => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-real-'));
  const workspace = join(root, 'workspace');
  const capture = join(root, 'capture');
  const configHome = join(root, 'home', '.config');
  const dataHome = join(root, 'home', '.local', 'share');
  const wrapperDir = join(root, 'bin');
  const derivativeContext = join(root, 'derivative');
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(capture, { recursive: true }), mkdir(configHome, { recursive: true }), mkdir(dataHome, { recursive: true }), mkdir(wrapperDir, { recursive: true }), mkdir(derivativeContext, { recursive: true })]);
  const baseId = docker('image', 'inspect', '--format', '{{.Id}}', configuredImage).trim();
  assert.match(baseId, /^sha256:[0-9a-f]{64}$/i);
  const sourceIdentity = await runtimeSourceIdentity();
  const embeddedSourceDigest = docker('image', 'inspect', '--format', '{{ index .Config.Labels "org.yoloharness.source-digest" }}', configuredImage).trim();
  assert.equal(embeddedSourceDigest, sourceIdentity.sourceDigest, 'configured image must embed the source digest it was built from');
  const network = `yoloharness-internal-${process.pid}`;
  const providerName = `${network}-provider`;
  const runtimeNames = [];
  let derivativeTag;
  // Use a test-owned, credential-free Docker client configuration. Resolve the
  // already-selected daemon endpoint before redirecting HOME/XDG so the
  // shipped subprocess exercises the same verified rootless daemon without
  // consuming the invoker's real config, auth helpers, or contexts.
  const dockerConfig = join(root, 'docker-config');
  await mkdir(dockerConfig, { recursive: true });
  const daemonEndpoint = docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', docker('context', 'show').trim()).trim();
  assert.match(daemonEndpoint, /^unix:\/\//, 'real-Docker evidence requires an explicit local daemon endpoint');
  await writeFile(join(dockerConfig, 'config.json'), '{}\n');
  const oldEnv = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'YOLO_AUTH_FILE', 'PATH', 'DOCKER_CONFIG', 'DOCKER_HOST'].map(key => [key, process.env[key]]));
  try {
    const caDir = join(root, 'tls'); await mkdir(caDir);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(caDir, 'ca.key'), '-out', join(caDir, 'ca.crt'), '-subj', '/CN=yoloharness-test-ca', '-days', '1'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(caDir, 'server.key'), '-out', join(caDir, 'server.csr'), '-subj', '/CN=chatgpt.com'], { stdio: 'ignore' });
    await writeFile(join(caDir, 'san.ext'), 'subjectAltName=DNS:chatgpt.com\n');
    execFileSync('openssl', ['x509', '-req', '-in', join(caDir, 'server.csr'), '-CA', join(caDir, 'ca.crt'), '-CAkey', join(caDir, 'ca.key'), '-CAcreateserial', '-out', join(caDir, 'server.crt'), '-days', '1', '-extfile', join(caDir, 'san.ext')], { stdio: 'ignore' });
    await chmod(join(caDir, 'ca.key'), 0o600); await chmod(join(caDir, 'server.key'), 0o600);
    await writeFile(join(derivativeContext, 'ca.crt'), await readFile(join(caDir, 'ca.crt')));
    await writeFile(join(derivativeContext, 'Dockerfile'), `FROM ${configuredImage}\nCOPY ca.crt /usr/local/share/ca-certificates/yoloharness-test-ca.crt\nENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/yoloharness-test-ca.crt\n`);
    derivativeTag = `yoloharness-test-derivative:${process.pid}`;
    docker('build', '-t', derivativeTag, derivativeContext);
    const derivativeId = docker('image', 'inspect', '--format', '{{.Id}}', derivativeTag).trim();
    assert.match(derivativeId, /^sha256:[0-9a-f]{64}$/i);
    const providerScript = "const https=require('https'),fs=require('fs');let n=0;const s=https.createServer({key:fs.readFileSync('/tls/server.key'),cert:fs.readFileSync('/tls/server.crt')},(q,r)=>{if(q.url==='/health'){r.writeHead(200);return r.end('ok')}let b='';q.on('data',c=>b+=c);q.on('end',()=>{n++;fs.writeFileSync('/capture/request-'+n+'.json',JSON.stringify({body:b,remote:q.socket.remoteAddress,pid:process.pid}));r.writeHead(200,{'content-type':'text/event-stream'});const e=n===1?{type:'response.output_item.done',item:{type:'function_call',id:'item-1',call_id:'synthetic-1',name:'exec',arguments:JSON.stringify({command:'printf',args:['whole-runtime-ok']}),status:'completed'}}:{type:'response.completed',response:{id:'synthetic-2',status:'completed'}};const events=n===1?[e,{type:'response.completed',response:{id:'synthetic-1',status:'completed'}}]:[{type:'response.output_text.delta',delta:'whole-runtime-ok'},e];r.end(events.map(x=>'data: '+JSON.stringify(x)+'\\n\\n').join(''))})});s.listen(443,'0.0.0.0',()=>fs.writeFileSync('/capture/ready','ready'));";
    docker('network', 'create', '--internal', network);
    docker('run', '--detach', '--pull=never', '--network', network, '--network-alias', 'chatgpt.com', '--name', providerName, '--mount', `type=bind,src=${capture},dst=/capture,readonly=false`, '--mount', `type=bind,src=${caDir},dst=/tls,readonly=true`, '--entrypoint', 'node', derivativeTag, '-e', providerScript);
    await waitFor(join(capture, 'ready'));
    const expectedLabel = `yoloharness.run=`;
    const wrapperPath = join(wrapperDir, 'docker');
    await writeFile(wrapperPath, `#!/usr/bin/env node\nconst cp=require('child_process'),fs=require('fs');const a=process.argv.slice(2);if(a[0]==='create'){const name=a[a.indexOf('--name')+1],label=a[a.indexOf('--label')+1],ni=a.indexOf('--network'),ii=a.lastIndexOf(${JSON.stringify(baseId)});if(!name||!name.startsWith('yoloharness-')||!label||!label.startsWith(${JSON.stringify(expectedLabel)})||ni<0||a[ni+1]!=='bridge'||a.filter(x=>x==='--network').length!==1||ii<0) process.exit(91);a[ni+1]=${JSON.stringify(network)};a[ii]=${JSON.stringify(derivativeId)};fs.appendFileSync(${JSON.stringify(join(root, 'docker-argv.jsonl'))},JSON.stringify(a)+'\\n');}process.exit(cp.spawnSync(${JSON.stringify(dockerPath)},a,{stdio:'inherit'}).status??92);\n`);
    await chmod(wrapperPath, 0o755);
    await mkdir(join(configHome, 'yoloharness'), { recursive: true }); await mkdir(join(dataHome, 'yoloharness'), { recursive: true });
    await writeFile(join(dataHome, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: baseId, ...sourceIdentity }));
    await writeFile(join(configHome, 'yoloharness', 'credentials.json'), JSON.stringify({ accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', clientId: 'synthetic-client', expiresAt: Date.now() + 1_800_000 }));
    await writeFile(join(configHome, 'yoloharness', 'config.json'), JSON.stringify({ version: 1, model: 'synthetic-model' }));
    const canary = docker('run', '--rm', '--pull=never', '--network', network, '--entrypoint', 'node', derivativeTag, '-e', "require('https').get('https://chatgpt.com/health',r=>{console.log(r.statusCode);r.resume();r.on('end',()=>process.exit(0))}).on('error',e=>{console.error(e.message);process.exit(1)})");
    assert.match(canary, /200|404|401/);
    const env = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, YOLO_AUTH_FILE: join(configHome, 'yoloharness', 'credentials.json'), DOCKER_CONFIG: dockerConfig, DOCKER_HOST: daemonEndpoint, PATH: `${wrapperDir}:${process.env.PATH}` };
    const child = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--json', 'whole-runtime nonce synthetic'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(exit.code, 0, `${stderr}${stdout}\nprovider-log:\n${(() => { try { return docker('logs', providerName); } catch (error) { return error.stdout ?? error.message; } })()}\nwrapper:\n${await readFile(join(root, 'docker-argv.jsonl'), 'utf8').catch(() => 'missing')}\nnetwork:\n${(() => { try { return docker('network', 'inspect', network); } catch (error) { return error.stdout ?? error.message; } })()}`);
    const record = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); assert.equal(record.status, 'completed'); assert.equal(record.result, 'whole-runtime-ok');
    const request = JSON.parse(await readFile(join(capture, 'request-1.json'), 'utf8')); assert.match(request.body, /whole-runtime nonce synthetic/); assert.ok(request.remote);
    const secondRequest = JSON.parse(await readFile(join(capture, 'request-2.json'), 'utf8')); assert.match(secondRequest.body, /synthetic-1/);
    assert.equal(await access(join(workspace, '.yolo', 'runs')).then(() => true).catch(() => false), true);
    const wrapperLines = (await readFile(join(root, 'docker-argv.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line)); assert.equal(wrapperLines.length, 1); assert.equal(wrapperLines[0][wrapperLines[0].indexOf('--network') + 1], network);
    const inspect = JSON.parse(docker('inspect', providerName))[0]; assert.equal(Object.keys(inspect.NetworkSettings.Networks).length, 1); assert.ok(inspect.NetworkSettings.Networks[network]);
    runtimeNames.push(...docker('ps', '-aq', '--filter', 'label=yoloharness.run').trim().split(/\s+/).filter(Boolean));
  } finally {
    restoreEnv(oldEnv);
    bestEffortDocker('rm', '--force', providerName); bestEffortDocker('network', 'rm', network);
    for (const id of runtimeNames) bestEffortDocker('rm', '--force', id);
    if (derivativeTag) bestEffortDocker('image', 'rm', '--force', derivativeTag);
    await rm(root, { recursive: true, force: true });
  }
}

test('shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network', { skip }, fixture);

test('configured final image has read-only root and rootless UID0 workspace write/delete canary', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-image-canary-');
  try {
    const output = docker('run', '--rm', '--pull=never', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m', '--mount', `type=bind,src=${workspace},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--user', '0:0', '--entrypoint', 'sh', configuredImage, '-c', 'id -u; touch /workspace/canary; rm /workspace/canary; ! touch /app/forbidden');
    assert.match(output, /^0\n/); assert.equal(await access(join(workspace, 'canary')).then(() => true).catch(() => false), false);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
