import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeSourceIdentity } from '../src/cli.mjs';

const enabled = process.env.YOLO_REAL_DOCKER === '1';
const skip = !enabled;
const dockerPath = execFileSync('command', ['-v', 'docker'], { shell: '/bin/sh', encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync(dockerPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const image = process.env.YOLO_DOCKER_IMAGE ?? 'yoloharness-local:0.1.1';
const jsonl = async path => (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const values = (argv, flag) => argv.flatMap((v, i) => v === flag ? [argv[i + 1]] : []);

function assertCreateContract(record, mode, selectedDockerEnv) {
  assert.deepEqual(record.env, selectedDockerEnv);
  const argv = record.argv;
  assert.deepEqual(argv.slice(0, 6), ['create', '--pull=never', '--name', argv[3], '--label', argv[5]]);
  assert.match(argv[3], /^yoloharness-/); assert.match(argv[5], /^yoloharness\.run=[0-9a-f-]+$/);
  assert.deepEqual(values(argv, '--user'), [mode === 'rootful' ? `${process.getuid()}:${process.getgid()}` : '0:0']);
  assert.deepEqual(values(argv, '--group-add'), mode === 'rootful' ? [...new Set(process.getgroups?.() ?? [])].filter(g => g !== process.getgid()).map(String) : []);
  assert.equal(argv.includes('--pull=never'), true); assert.equal(argv.includes('--init'), true); assert.equal(argv.includes('-i'), true);
  assert.equal(argv.includes('--read-only'), true); assert.equal(argv.includes('--cap-drop=ALL'), true);
  assert.deepEqual(argv.slice(argv.indexOf('--security-opt'), argv.indexOf('--security-opt') + 2), ['--security-opt', 'no-new-privileges']);
  assert.deepEqual(values(argv, '--tmpfs'), [
    `/tmp:rw,noexec,nosuid,size=64m,uid=${mode === 'rootful' ? process.getuid() : 0},gid=${mode === 'rootful' ? process.getgid() : 0},mode=700`,
    `/home/worker:rw,noexec,nosuid,size=16m,uid=${mode === 'rootful' ? process.getuid() : 0},gid=${mode === 'rootful' ? process.getgid() : 0},mode=700`,
  ]);
  assert.equal(values(argv, '--mount').length, 1); assert.match(values(argv, '--mount')[0], /^type=bind,src=.+,dst=\/workspace,readonly=false,bind-propagation=rprivate$/);
  assert.deepEqual(values(argv, '--workdir'), ['/workspace']);
  assert.deepEqual(values(argv, '--network'), ['bridge']);
  assert.deepEqual(values(argv, '--pids-limit'), ['128']); assert.deepEqual(values(argv, '--memory'), ['512m']); assert.deepEqual(values(argv, '--cpus'), ['1']);
  assert.deepEqual(values(argv, '--env'), ['HOME=/home/worker', 'XDG_CONFIG_HOME=/home/worker/.config', 'XDG_DATA_HOME=/home/worker/.local/share']);
  assert.deepEqual(argv.slice(-3), [record.image, 'node', '/app/src/container-runtime.mjs']);
  for (const forbidden of ['--privileged', '--pid=host', '--network=host', '/var/run/docker.sock']) assert.equal(argv.includes(forbidden), false);
}

async function makeFixture(root) {
  const workspace = join(root, 'workspace'); const home = join(root, 'home'); const config = join(root, 'config'); const data = join(root, 'data'); const log = join(root, 'docker.jsonl');
  await Promise.all([mkdir(workspace), mkdir(home), mkdir(config), mkdir(data)]);
  const endpoint = docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', docker('context', 'show').trim()).trim(); assert.match(endpoint, /^unix:\/\//);
  const baseId = docker('image', 'inspect', '--format', '{{.Id}}', image).trim(); assert.match(baseId, /^sha256:[0-9a-f]{64}$/i);
  const identity = await runtimeSourceIdentity();
  await mkdir(join(config, 'yoloharness')); await mkdir(join(data, 'yoloharness'));
  await writeFile(join(config, 'yoloharness', 'credentials.json'), JSON.stringify({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', clientId: 'synthetic-client', expiresAt: Date.now() + 1_800_000 }));
  await writeFile(join(config, 'yoloharness', 'config.json'), JSON.stringify({ version: 1, model: 'synthetic-model' }));
  await writeFile(join(data, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: baseId, ...identity }));
  const ca = join(root, 'ca'); await mkdir(ca);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(ca, 'ca.key'), '-out', join(ca, 'ca.crt'), '-subj', '/CN=yoloharness-test-ca', '-days', '1'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(ca, 'server.key'), '-out', join(ca, 'server.csr'), '-subj', '/CN=chatgpt.com'], { stdio: 'ignore' });
  await writeFile(join(ca, 'san.ext'), 'subjectAltName=DNS:chatgpt.com\n');
  execFileSync('openssl', ['x509', '-req', '-in', join(ca, 'server.csr'), '-CA', join(ca, 'ca.crt'), '-CAkey', join(ca, 'ca.key'), '-CAcreateserial', '-out', join(ca, 'server.crt'), '-days', '1', '-extfile', join(ca, 'san.ext')], { stdio: 'ignore' });
  const context = join(root, 'context'); await mkdir(context); await writeFile(join(context, 'ca.crt'), await readFile(join(ca, 'ca.crt')));
  await writeFile(join(context, 'Dockerfile'), `FROM ${image}\nCOPY ca.crt /usr/local/share/ca-certificates/yoloharness-test-ca.crt\nENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/yoloharness-test-ca.crt\n`);
  const tag = `yoloharness-identity:${process.pid}`; docker('build', '--pull=false', '-t', tag, context); const derivative = docker('image', 'inspect', '--format', '{{.Id}}', tag).trim();
  const network = `yoloharness-identity-${process.pid}`; docker('network', 'create', '--internal', network);
  const providerScript = "const https=require('https'),fs=require('fs');let n=0;https.createServer({key:fs.readFileSync('/tls/server.key'),cert:fs.readFileSync('/tls/server.crt')},(q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{n++;r.writeHead(200,{'content-type':'text/event-stream'});if(n===1)r.end('data: '+JSON.stringify({type:'response.output_item.done',item:{type:'function_call',id:'identity-item',call_id:'identity-call',name:'exec',arguments:JSON.stringify({command:'sh',args:['-c','printf identity-canary > /workspace/identity-canary']})}})+'\\n\\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\\n\\n');else r.end('data: '+JSON.stringify({type:'response.output_text.delta',delta:'identity-runtime-ok'})+'\\n\\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\\n\\n')})}).listen(443,'0.0.0.0')";
  const provider = `${network}-provider`; docker('run', '--detach', '--pull=never', '--network', network, '--network-alias', 'chatgpt.com', '--name', provider, '--mount', `type=bind,src=${ca},dst=/tls,readonly=true`, '--entrypoint', 'node', tag, '-e', providerScript);
  const proxy = join(root, 'docker-proxy.cjs');
  await writeFile(proxy, `#!/usr/bin/env node
const cp=require('child_process'),fs=require('fs');const a=process.argv.slice(2),base=${JSON.stringify(dockerPath)},net=${JSON.stringify(network)},id=${JSON.stringify(baseId)},der=${JSON.stringify(derivative)},log=${JSON.stringify(log)};const original=[...a],r={argv:original,env:{DOCKER_HOST:process.env.DOCKER_HOST,DOCKER_CONTEXT:process.env.DOCKER_CONTEXT}};
if(a[0]==='info'){fs.appendFileSync(log,JSON.stringify(r)+'\\n');const security=process.env.YOLO_TEST_MODE==='rootless'?['name=rootless','name=seccomp,profile=builtin']:['name=seccomp,profile=builtin'];process.stdout.write(JSON.stringify({OSType:'linux',OperatingSystem:process.env.YOLO_TEST_MODE==='darwin'?'Vendor A':'Vendor B',SecurityOptions:security}));process.exit(0)}
if(a[0]==='create'){for(let i=a.length-1;i>=0;i--)if(a[i]==='--group-add')a.splice(i,2);if(process.env.YOLO_TEST_MODE==='rootful'){const u=a.indexOf('--user');if(u>=0)a[u+1]='0:0';for(let i=0;i<a.length;i++)if(a[i]==='--tmpfs')a[i+1]=a[i+1].replace(/uid=[0-9]+,gid=[0-9]+/,'uid=0,gid=0')}const n=a.indexOf('--network');if(n>=0)a[n+1]=net;if(a.includes(id))a[a.indexOf(id)]=der;r.image=a.at(-3);r.translatedArgv=[...a]}
const child=cp.spawn(base,a,{encoding:'utf8',env:process.env,stdio:a[0]==='start'?['pipe','pipe','pipe']:['ignore','pipe','pipe']});let out='',err='';if(a[0]==='start')process.stdin.pipe(child.stdin);child.stdout.on('data',c=>{out+=c;process.stdout.write(c)});child.stderr.on('data',c=>{err+=c;process.stderr.write(c)});child.on('close',code=>{r.stdout=out.trim();r.stderr=err.trim();r.status=code;fs.appendFileSync(log,JSON.stringify(r)+'\\n');process.exit(code??1)});`, { mode: 0o755 });
  return { workspace, config, data, endpoint, baseId, network, provider, proxy, tag, identity, log };
}

async function installPacked(root, env) {
  const packed = join(root, 'packed'); await mkdir(packed); const name = execFileSync('npm', ['pack', '--pack-destination', packed], { cwd: process.cwd(), encoding: 'utf8' }).trim().split(/\r?\n/).at(-1); execFileSync('tar', ['-xzf', join(packed, name), '-C', packed]);
  const installed = spawnSync(process.execPath, [join(packed, 'package', 'install.mjs')], { cwd: join(packed, 'package'), env: { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: env.config, XDG_DATA_HOME: env.data }, encoding: 'utf8' }); assert.equal(installed.status, 0, installed.stderr); await writeFile(join(env.data, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: env.baseId, ...env.identity }));
  return join(root, 'home', '.local', 'bin', 'yolo');
}

test('installed v0.1.1 CLI retains complete identity lifecycle evidence', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-identity-')); let foreignId; let fixture;
  try {
    fixture = await makeFixture(root); const cli = await installPacked(root, fixture); const foreignName = `yoloharness-foreign-identity-${process.pid}`;
    foreignId = docker('create', '--pull=never', '--name', foreignName, image, 'sleep', '60').trim(); assert.match(foreignId, /^[a-f0-9]{64}$/i);
    for (const mode of ['rootless', 'darwin', 'rootful']) {
      const modeEnv = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: fixture.config, XDG_DATA_HOME: fixture.data, DOCKER_CONFIG: join(root, 'docker-config'), DOCKER_HOST: fixture.endpoint, PATH: `${root}:${process.env.PATH}`, YOLO_TEST_MODE: mode, YOLO_TEST_ROOTFUL: mode === 'rootful' ? '1' : '0', NODE_OPTIONS: mode === 'darwin' ? `--require=${join(root, 'darwin.cjs')}` : undefined };
      await writeFile(join(root, 'docker'), `#!/bin/sh\nexec ${fixture.proxy} "$@"`, { mode: 0o755 }); await writeFile(fixture.log, '');
      if (mode === 'darwin') await writeFile(join(root, 'darwin.cjs'), "Object.defineProperty(process,'platform',{value:'darwin'});");
      const run = spawnSync(cli, ['--json', '-t', '0.1', `identity evidence ${mode}`], { cwd: fixture.workspace, env: modeEnv, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 }); assert.equal(run.error, undefined, `${run.error?.message ?? ''}\n${run.stderr}\n${run.stdout}`); assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
      const receipt = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1)); assert.equal(receipt.status, 'completed'); assert.equal(receipt.result, 'identity-runtime-ok'); assert.ok(receipt.evidence.length >= 1); assert.equal(await readFile(join(fixture.workspace, 'identity-canary'), 'utf8'), 'identity-canary'); assert.deepEqual(JSON.parse(await readFile(join(fixture.workspace, '.yolo', 'last-receipt.json'), 'utf8')), receipt);
      const records = await jsonl(fixture.log); const create = records.find(r => r.argv[0] === 'create'); assert.ok(create); create.image = create.argv.at(-3); assertCreateContract(create, mode === 'rootful' ? 'rootful' : mode, { DOCKER_HOST: fixture.endpoint });
      const runLabel = create.argv[5].split('=')[1]; assert.match(create.stdout, /^[a-f0-9]{64}$/i); const createdId = create.stdout;
      const lifecycle = records.filter(r => ['info', 'create', 'inspect', 'start', 'stop', 'kill', 'rm'].includes(r.argv[0]));
      assert.deepEqual(lifecycle.map(r => r.argv[0]), ['info', 'create', 'inspect', 'start', 'inspect', 'stop', 'kill', 'rm', 'inspect']);
      for (const index of [2, 3, 4, 5, 6, 7, 8]) assert.equal(lifecycle[index].argv.at(-1), createdId);
      assert.equal(lifecycle[2].stdout.includes(`\"Id\":\"${createdId}\"`), true); assert.equal(lifecycle[2].stdout.includes(`\"Name\":\"/${create.argv[3]}\"`), true); assert.equal(lifecycle[2].stdout.includes(`\"yoloharness.run\":\"${runLabel}\"`), true);
      for (const query of [
        ['ps', '-aq', '--no-trunc', '--filter', `id=${createdId}`],
        ['ps', '-aq', '--no-trunc', '--filter', `name=^/${create.argv[3]}$`],
        ['ps', '-aq', '--no-trunc', '--filter', `label=yoloharness.run=${runLabel}`],
      ]) assert.equal(docker(...query).trim(), '');
      for (let attempt = 0; attempt < 2; attempt += 1) { assert.equal(docker('ps', '-aq', '--no-trunc', '--filter', `name=^/${foreignName}$`).trim(), foreignId); assert.equal(docker('ps', '-aq', '--no-trunc', '--filter', `label=yoloharness.run=${runLabel}`).trim(), ''); }
      await writeFile(fixture.log, '');
    }
    docker('rm', '--force', foreignId); foreignId = null;
  } finally { if (foreignId) try { docker('rm', '--force', foreignId); } catch {} if (fixture) { try { docker('rm', '--force', fixture.provider); } catch {} try { docker('network', 'rm', fixture.network); } catch {} try { docker('image', 'rm', fixture.tag); } catch {} } await rm(root, { recursive: true, force: true }); }
});

test('installed v0.1.0 CLI retains the historical rootless-only RED', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-history-'));
  try {
    const archive = join(root, 'v0.1.0.tar'); execFileSync('git', ['archive', '--format=tar', '-o', archive, '58300c7d68b4778922c34d106f9ed4486caeaa64', 'src', 'install.mjs', 'package.json', 'assets/runtime/Dockerfile']); execFileSync('tar', ['-xf', archive, '-C', root]);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); assert.equal(pkg.version, '0.1.0');
    const packed = join(root, 'packed'); await mkdir(packed); const name = execFileSync('npm', ['pack', '--pack-destination', packed], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).at(-1); execFileSync('tar', ['-xzf', join(packed, name), '-C', packed]);
    const home = join(root, 'home'); const config = join(root, 'config'); const data = join(root, 'data'); await mkdir(join(config, 'yoloharness'), { recursive: true }); await mkdir(join(data, 'yoloharness'), { recursive: true });
    const oldDigest = execFileSync(process.execPath, ['--input-type=module', '-e', `import { runtimeSourceIdentity } from ${JSON.stringify(new URL(`file://${root}/src/cli.mjs`).href)}; console.log((await runtimeSourceIdentity()).sourceDigest)`], { encoding: 'utf8' }).trim();
    const historyLog = join(root, 'docker-history.log');
    const fake = `#!/bin/sh\nprintf '%s\\n' "$*" >> ${historyLog}\nif [ "$1" = info ]; then printf '%s' '["name=seccomp,profile=builtin"]'; exit 0; fi\nif [ "$1" = image ]; then printf '%s' '{"Id":"sha256:${'a'.repeat(64)}","RepoTags":["yoloharness-local:0.1.0"],"Config":{"Labels":{"org.yoloharness.source-digest":"${oldDigest}"},"Entrypoint":["node","/app/src/container-runtime.mjs"]}}'; exit 0; fi\nprintf 'unexpected docker operation: %s\\n' "$1" >&2; exit 91\n`;
    const bin = join(root, 'bin'); await mkdir(bin); await writeFile(join(bin, 'docker'), fake, { mode: 0o755 });
    await writeFile(join(config, 'yoloharness', 'config.json'), JSON.stringify({ version: 1, model: 'synthetic-model' })); await writeFile(join(config, 'yoloharness', 'credentials.json'), JSON.stringify({ accessToken: 'synthetic', refreshToken: 'synthetic', expiresAt: Date.now() + 3_600_000 }));
    const installed = spawnSync(process.execPath, [join(packed, 'package', 'install.mjs')], { cwd: join(packed, 'package'), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data }, encoding: 'utf8' }); assert.equal(installed.status, 0, installed.stderr); await writeFile(join(data, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: `sha256:${'a'.repeat(64)}`, sourceDigest: oldDigest, sourceVersion: '0.1.0' }));
    const run = spawnSync(join(home, '.local', 'bin', 'yolo'), ['--json', 'historical identity RED'], { cwd: root, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, PATH: `${bin}:${process.env.PATH}`, YOLO_RESPONSES_URL: 'https://chatgpt.com/backend-api/codex/responses' }, encoding: 'utf8' });
    assert.equal(run.status, 1); assert.match(run.stderr, /refusing launch: Docker rootless mode was not verified/); assert.equal(run.stdout, '');
    const history = (await readFile(historyLog, 'utf8')).trim().split(/\r?\n/); assert.equal(history.some(line => line.startsWith('create ')), false); assert.equal(history.some(line => line.startsWith('start ')), false); assert.equal(history.some(line => line.startsWith('inspect ')), false); assert.ok(history.some(line => line.startsWith('info '))); assert.ok(history.some(line => line.startsWith('image ')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
