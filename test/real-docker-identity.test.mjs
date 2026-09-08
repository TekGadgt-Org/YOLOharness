import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeSourceIdentity } from '../src/cli.mjs';
import { RUNTIME_RESOURCE_POLICY } from '../src/resource-policy.mjs';

const enabled = process.env.YOLO_REAL_DOCKER === '1';
const skip = !enabled;
const dockerPath = execFileSync('command', ['-v', 'docker'], { shell: '/bin/sh', encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync(dockerPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const image = process.env.YOLO_DOCKER_IMAGE ?? 'yoloharness-local:0.1.1';
const dockerSelectorKeys = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'];
const originalDockerSelectors = Object.fromEntries(dockerSelectorKeys.map(key => [key, process.env[key]]));
const jsonl = async path => (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const values = (argv, flag) => argv.flatMap((v, i) => v === flag ? [argv[i + 1]] : []);

function expectedCreateArgv(record, fixture, mode) {
  const uid = mode === 'rootful' ? process.getuid() : 0; const gid = mode === 'rootful' ? process.getgid() : 0;
  const groups = mode === 'rootful' ? [...new Set(process.getgroups?.() ?? [])].filter(g => g !== process.getgid()).map(String) : [];
  const args = ['create', '--pull=never', '--name', record.argv[3], '--label', record.argv[5], '--init', '-i', '--user', `${uid}:${gid}`];
  for (const group of groups) args.push('--group-add', group);
  args.push('--network', 'bridge', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--mount',
    values(record.argv, '--mount')[0], '--tmpfs',
    `/home/worker:rw,noexec,nosuid,size=${RUNTIME_RESOURCE_POLICY.homeTmpfs},uid=${uid},gid=${gid},mode=700`, '--mount',
    `type=bind,src=${fixture.workspace},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--workdir', '/workspace', '--env', 'HOME=/home/worker', '--env', 'XDG_CONFIG_HOME=/home/worker/.config', '--env', 'XDG_DATA_HOME=/home/worker/.local/share', fixture.baseId, 'node', '/app/src/container-runtime.mjs');
  return args;
}

function assertCreateContract(record, fixture, mode, selectedDockerEnv) {
  assert.deepEqual(record.env, selectedDockerEnv);
  assert.deepEqual(record.argv, expectedCreateArgv(record, fixture, mode));
  const argv = record.argv;
  assert.match(argv[3], /^yoloharness-/); assert.match(argv[5], /^yoloharness\.run=[0-9a-f-]+$/);
  assert.deepEqual(values(argv, '--user'), [mode === 'rootful' ? `${process.getuid()}:${process.getgid()}` : '0:0']);
  assert.deepEqual(values(argv, '--group-add'), mode === 'rootful' ? [...new Set(process.getgroups?.() ?? [])].filter(g => g !== process.getgid()).map(String) : []);
  assert.deepEqual(values(argv, '--tmpfs'), [`/home/worker:rw,noexec,nosuid,size=${RUNTIME_RESOURCE_POLICY.homeTmpfs},uid=${mode === 'rootful' ? process.getuid() : 0},gid=${mode === 'rootful' ? process.getgid() : 0},mode=700`]);
  assert.equal(values(argv, '--mount').length, 2); assert.match(values(argv, '--mount')[0], /^type=volume,src=yoloharness-scratch-[0-9a-f-]+,dst=\/tmp,volume-nocopy$/); assert.match(values(argv, '--mount')[1], /^type=bind,src=.+,dst=\/workspace,readonly=false,bind-propagation=rprivate$/);
  assert.deepEqual(values(argv, '--workdir'), ['/workspace']);
  assert.deepEqual(values(argv, '--network'), ['bridge']);
  assert.deepEqual(values(argv, '--pids-limit'), ['128']); assert.deepEqual(values(argv, '--memory'), ['512m']); assert.deepEqual(values(argv, '--cpus'), ['1']);
  assert.deepEqual(values(argv, '--env'), ['HOME=/home/worker', 'XDG_CONFIG_HOME=/home/worker/.config', 'XDG_DATA_HOME=/home/worker/.local/share']);
}

async function assertStableAbsence(id, name, label, foreignId, foreignName, fixture = null) {
  const observations = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    observations.push({
      id: docker('ps', '-aq', '--no-trunc', '--filter', `id=${id}`).trim(),
      name: docker('ps', '-aq', '--no-trunc', '--filter', `name=^/${name}$`).trim(),
      label: docker('ps', '-aq', '--no-trunc', '--filter', `label=yoloharness.run=${label}`).trim(),
      provider: fixture ? docker('ps', '-aq', '--no-trunc', '--filter', `name=^/${fixture.provider}$`).trim() : '',
      network: fixture ? docker('network', 'ls', '-q', '--filter', `name=^${fixture.network}$`).trim() : '',
      image: fixture ? docker('image', 'ls', '-q', fixture.tag).trim() : '',
      childMarker: fixture?.childMarker ? await readFile(fixture.childMarker, 'utf8').catch(() => '') : '',
      foreign: docker('ps', '-aq', '--no-trunc', '--filter', `name=^/${foreignName}$`).trim(),
    });
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 275));
  }
  assert.deepEqual(observations, observations.map(() => ({ id: '', name: '', label: '', provider: '', network: '', image: '', childMarker: '', foreign: foreignId })));
}

async function cleanupOwned(fixture, foreignId = null, runDocker = docker) {
  const resources = [
    ['container', fixture.provider, ['rm', '--force', fixture.provider]],
    ['network', fixture.network, ['network', 'rm', fixture.network]],
    ['image', fixture.tag, ['image', 'rm', fixture.tag]],
  ];
  const history = { attempts: [], errors: [], retries: [], successes: [] };
  for (let attempt = 0; attempt < 3 && resources.length; attempt += 1) {
    for (let index = 0; index < resources.length; index += 1) {
      const [resource, target, argv] = resources[index];
      try {
        runDocker(...argv);
        history.attempts.push({ attempt: attempt + 1, resource, target, status: 'success' });
        history.successes.push({ attempt: attempt + 1, resource, target });
        resources.splice(index, 1);
        index -= 1;
      } catch (error) {
        const message = error.stderr?.toString().trim() || error.message;
        history.attempts.push({ attempt: attempt + 1, resource, target, status: 'error', error: message });
        history.errors.push({ attempt: attempt + 1, resource, target, error: message });
      }
    }
    if (resources.length) {
      history.retries.push({ fromAttempt: attempt + 1, toAttempt: attempt + 2, resources: resources.map(([resource]) => resource) });
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  if (foreignId) assert.match(runDocker('ps', '-aq', '--no-trunc', '--filter', `id=${foreignId}`).trim(), new RegExp(`^${foreignId}$`));
  assert.deepEqual(resources, [], `owned cleanup history: ${JSON.stringify(history)}`);
  return history;
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
  const providerScript = "const https=require('https'),fs=require('fs');let n=0;https.createServer({key:fs.readFileSync('/tls/server.key'),cert:fs.readFileSync('/tls/server.crt')},(q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{n++;r.writeHead(200,{'content-type':'text/event-stream'});if(n===1)r.end('data: '+JSON.stringify({type:'response.output_item.done',item:{type:'function_call',id:b.includes('installed npm 70 MiB')?'npm-item':'identity-item',call_id:b.includes('installed npm 70 MiB')?'npm-install-call':'identity-call',name:'exec',arguments:JSON.stringify(b.includes('installed npm 70 MiB')?{command:'npm',args:['install','--offline','--ignore-scripts','--no-audit','--no-fund','/workspace/package-fixture']}:{command:'sh',args:['-c','printf identity-canary > /workspace/identity-canary']})}})+'\\n\\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\\n\\n');else r.end('data: '+JSON.stringify({type:'response.output_text.delta',delta:b.includes('installed npm 70 MiB')?'installed-npm-70m-ok':'identity-runtime-ok'})+'\\n\\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\\n\\n')})}).listen(443,'0.0.0.0')";
  const provider = `${network}-provider`; docker('run', '--detach', '--pull=never', '--network', network, '--network-alias', 'chatgpt.com', '--name', provider, '--mount', `type=bind,src=${ca},dst=/tls,readonly=true`, '--entrypoint', 'node', tag, '-e', providerScript);
  const childMarker = join(root, 'proxy-child.pid'); const cleanupFailure = join(root, 'cleanup-transient.once');
  const childFixture = join(root, 'proxy-child.cjs'); await writeFile(childFixture, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(childMarker)},String(process.pid));if(process.env.YOLO_PROXY_CHILD==='cleanup-unknown'){const p=${JSON.stringify(join(workspace, '.yolo', 'last-receipt.json'))};try{process.stdout.write(fs.readFileSync(p,'utf8'));}catch{}if(process.env.YOLO_PROXY_PRIMARY==='generic'){process.stderr.write('primary fixture failure\\n');process.exitCode=42;}else process.exitCode=0;process.exit();}setInterval(()=>{},1000);`);
  const proxy = join(root, 'docker-proxy.cjs');
  await writeFile(proxy, `#!/usr/bin/env node
const cp=require('child_process'),fs=require('fs');const a=process.argv.slice(2);let base=${JSON.stringify(dockerPath)};const net=${JSON.stringify(network)},workspace=${JSON.stringify(workspace)},id=${JSON.stringify(baseId)},der=${JSON.stringify(derivative)},log=${JSON.stringify(log)},childFixture=${JSON.stringify(childFixture)},childMarker=${JSON.stringify(childMarker)},cleanupFailure=${JSON.stringify(cleanupFailure)},provider=${JSON.stringify(provider)};const original=[...a],selection=['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','PATH'],r={argv:original,env:Object.fromEntries(selection.map(k=>[k,process.env[k]??null])),events:[]};
if(a[0]==='info'){fs.appendFileSync(log,JSON.stringify(r)+'\\n');const security=process.env.YOLO_TEST_MODE==='rootless'?['name=rootless','name=seccomp,profile=builtin']:['name=seccomp,profile=builtin'];process.stdout.write(JSON.stringify({OSType:'linux',OperatingSystem:process.env.YOLO_TEST_MODE==='darwin'?'Vendor A':'Vendor B',SecurityOptions:security}));process.exit(0)}
if(process.env.YOLO_CLEANUP_TRANSIENT==='1'&&a[0]==='network'&&a[1]==='rm'&&a[2]===net&&!fs.existsSync(cleanupFailure)){fs.writeFileSync(cleanupFailure,'injected');process.stderr.write('injected transient cleanup failure\\n');process.exit(75)}
if(a[0]==='create'){for(let i=a.length-1;i>=0;i--)if(a[i]==='--group-add')a.splice(i,2);if(process.env.YOLO_TEST_MODE==='rootful'&&!a.includes('yoloharness.role=scratch-verify')&&(process.env.YOLO_PRESERVE_RUNTIME_UID!=='1'||!a.includes('/app/src/container-runtime.mjs'))){const u=a.indexOf('--user');if(u>=0)a[u+1]='0:0';for(let i=0;i<a.length;i++)if(a[i]==='--tmpfs')a[i+1]=a[i+1].replace(/uid=[0-9]+,gid=[0-9]+/,'uid=0,gid=0')}const n=a.indexOf('--network');if(n>=0)a[n+1]=net;if(a.includes(id))a[a.indexOf(id)]=der;r.image=a.at(-3);r.translatedArgv=[...a]}
if(process.env.YOLO_PROXY_CHILD==='spawn-error'&&original[0]==='start'){base=childFixture+'-does-not-exist';r.events.push({type:'spawn'});}
else if(process.env.YOLO_PROXY_CHILD==='timeout'&&original[0]==='start'){base=process.execPath;a.splice(0,a.length,childFixture);r.events.push({type:'spawn'});}
else if(process.env.YOLO_PROXY_CHILD==='cleanup-unknown'&&original[0]==='start'){base=process.execPath;a.splice(0,a.length,childFixture);r.events.push({type:'spawn'});}
if(process.env.YOLO_PROXY_CHILD==='cleanup-unknown'&&a[0]==='rm'){process.on('SIGTERM',()=>{});r.events.push({type:'cleanup-hang'});setTimeout(()=>process.exit(0),5000);}
let child;try{child=cp.spawn(base,a,{encoding:'utf8',env:process.env,stdio:original[0]==='start'?['pipe','pipe','pipe']:['ignore','pipe','pipe']})}catch(error){r.events.push({type:'spawn-throw',message:error.message});r.status=91;fs.appendFileSync(log,JSON.stringify(r)+'\\n');process.stderr.write(error.message+'\\n');process.exit(91)}let out='',err='',done=false;const finish=code=>{if(done)return;done=true;try{const line=out.trim().split(/\\r?\\n/).at(-1);const parsed=JSON.parse(line);if(parsed?.version===1){fs.mkdirSync(workspace+'/.yolo',{recursive:true});fs.writeFileSync(workspace+'/.yolo/last-receipt.json',line+'\\n')}}catch{}try{cp.execFileSync('chmod',['-R','a+rwX',workspace])}catch{}clearTimeout(timer);r.stdout=out.trim();r.stderr=err.trim();r.status=code;if(process.env.YOLO_PROXY_CHILD==='timeout')fs.rmSync(childMarker,{force:true});fs.appendFileSync(log,JSON.stringify(r)+'\\n');process.exit(code??1)};const timer=setTimeout(()=>{r.timeout=true;r.events.push({type:'timeout'});child.kill('SIGKILL');r.events.push({type:'kill',signal:'SIGKILL'})},process.env.YOLO_PROXY_CHILD==='timeout'?250:30000);child.once('error',error=>{r.spawnError=error.message;r.events.push({type:'spawn-error',message:error.message})});child.stdout?.on('data',c=>{out+=c;process.stdout.write(c)});child.stderr?.on('data',c=>{err+=c;process.stderr.write(c)});if(original[0]==='start'){child.stdin.on('error',()=>{});process.stdin.pipe(child.stdin)}child.once('close',code=>{r.events.push({type:'close',code});finish(code)});`, { mode: 0o755 });
  const d2Output = join(root, 'runtime-output.json');
  const d2Log = join(root, 'd2-docker.jsonl');
  const d2Proxy = join(root, 'd2-docker-proxy.cjs');
  await writeFile(d2Proxy, `#!/usr/bin/env node
const cp=require('child_process'),fs=require('fs');
const argv=process.argv.slice(2), original=[...argv];
const docker=${JSON.stringify(dockerPath)}, image=${JSON.stringify(baseId)}, output=${JSON.stringify(d2Output)}, log=${JSON.stringify(d2Log)};
const record={argv:original,env:Object.fromEntries(['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','PATH'].map(k=>[k,process.env[k]??null]))};
const save=()=>fs.appendFileSync(log,JSON.stringify(record)+'\\n');
if(argv[0]==='info'){record.stdout=JSON.stringify({OSType:'linux',OperatingSystem:'D2 fixture',SecurityOptions:['name=rootless','name=seccomp,profile=builtin']});save();process.stdout.write(record.stdout);process.exit(0);}
if(argv[0]==='start'&&argv.includes('--attach')){record.intercept='runtime-output.json';record.stdout=fs.readFileSync(output,'utf8');record.status=process.env.YOLO_PROXY_PRIMARY==='generic'?42:0;save();process.stdout.write(record.stdout);process.exit(record.status);}
if(argv[0]==='rm'&&process.env.YOLO_PROXY_CHILD==='cleanup-unknown'){record.intercept='cleanup-hang';save();setTimeout(()=>process.exit(0),5000);} else {
 const child=cp.spawnSync(docker,argv,{encoding:'utf8',env:process.env,stdio:['ignore','pipe','pipe']});
 record.stdout=child.stdout??'';record.stderr=child.stderr??'';record.status=child.status;
 save();process.stdout.write(record.stdout);process.stderr.write(record.stderr);process.exit(child.status??1);
}
`, { mode: 0o755 });
  return { workspace, config, data, endpoint, baseId, network, provider, proxy, d2Proxy, d2Output, d2Log, tag, identity, log, childMarker, cleanupFailure };
}

async function installPacked(root, env) {
  const packed = join(root, 'packed'); await mkdir(packed); const name = execFileSync('npm', ['pack', '--pack-destination', packed], { cwd: process.cwd(), encoding: 'utf8' }).trim().split(/\r?\n/).at(-1); execFileSync('tar', ['-xzf', join(packed, name), '-C', packed]);
  const installed = spawnSync(process.execPath, [join(packed, 'package', 'install.mjs')], { cwd: join(packed, 'package'), env: { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: env.config, XDG_DATA_HOME: env.data }, encoding: 'utf8' }); assert.equal(installed.status, 0, installed.stderr); await writeFile(join(env.data, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: env.baseId, ...env.identity }));
  return join(root, 'home', '.local', 'bin', 'yolo');
}

function packedDockerEnvironment(endpoint, root) {
  const selected = { ...process.env, PATH: `${root}:${process.env.PATH}` };
  const explicit = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']
    .some(key => originalDockerSelectors[key] !== undefined);
  for (const key of dockerSelectorKeys) {
    if (originalDockerSelectors[key] === undefined) delete selected[key];
    else selected[key] = originalDockerSelectors[key];
  }
  if (!explicit) selected.DOCKER_HOST = endpoint;
  return selected;
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
      const records = await jsonl(fixture.log); const create = records.find(r => r.argv[0] === 'create' && r.argv.includes('/app/src/container-runtime.mjs')); assert.ok(create); assertCreateContract(create, fixture, mode === 'rootful' ? 'rootful' : mode, { DOCKER_HOST: fixture.endpoint, DOCKER_CONTEXT: null, DOCKER_CONFIG: fixture.config.replace(/\/config$/, '/docker-config'), DOCKER_TLS_VERIFY: null, DOCKER_CERT_PATH: null, PATH: `${join(root, '')}:${process.env.PATH}` });
      const runLabel = create.argv[5].split('=')[1]; assert.match(create.stdout, /^[a-f0-9]{64}$/i); const createdId = create.stdout;
      const lifecycle = records.filter(r => ['info', 'create', 'inspect', 'start', 'stop', 'kill', 'rm'].includes(r.argv[0]) && !r.argv.includes('yoloharness.role=scratch-init') && !r.argv.includes('yoloharness.role=scratch-verify'));
      assert.ok(lifecycle.some(record => record.argv[0] === 'start'));
      assert.ok(lifecycle.some(record => record.argv[0] === 'rm'));
      assert.ok(records.some(record => record.argv[0] === 'inspect' && record.stdout.includes(`\"Id\":\"${createdId}\"`)));
      assert.ok(records.some(record => record.argv[0] === 'create' && record.argv.includes('yoloharness.role=scratch-init')) === (mode === 'rootful'));
      await assertStableAbsence(createdId, create.argv[3], runLabel, foreignId, foreignName);
      await writeFile(fixture.log, '');
    }
    docker('rm', '--force', foreignId); foreignId = null;
  } finally { if (foreignId) try { docker('rm', '--force', foreignId); } catch {} if (fixture) try { await cleanupOwned(fixture); } catch {} await rm(root, { recursive: true, force: true }); }
});

test('installed production CLI traverses provider/runtime/executor for exact 70 MiB workload as selected UID', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-installed-npm-')); let foreignId; let fixture;
  try {
    fixture = await makeFixture(root);
    await chmod(fixture.workspace, 0o777);
    await mkdir(join(fixture.workspace, '.yolo'));
    await chmod(join(fixture.workspace, '.yolo'), 0o777);
    await mkdir(join(fixture.workspace, 'package-fixture'));
    await writeFile(join(fixture.workspace, 'package-fixture', 'package.json'), JSON.stringify({ name: 'installed-capacity-fixture', version: '1.0.0' }));
    await writeFile(join(fixture.workspace, 'package-fixture', 'payload.bin'), Buffer.alloc(73_400_320, 7));
    const cli = await installPacked(root, fixture);
    const foreignName = `yoloharness-foreign-installed-${process.pid}`;
    foreignId = docker('create', '--pull=never', '--name', foreignName, image, 'sleep', '60').trim();
    const modeEnv = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: fixture.config, XDG_DATA_HOME: fixture.data, DOCKER_CONFIG: join(root, 'docker-config'), DOCKER_HOST: fixture.endpoint, DOCKER_CONTEXT: undefined, DOCKER_TLS_VERIFY: undefined, DOCKER_CERT_PATH: undefined, PATH: `${root}:${process.env.PATH}`, YOLO_TEST_MODE: 'rootful', YOLO_TEST_ROOTFUL: '1', YOLO_PRESERVE_RUNTIME_UID: '1' };
    await writeFile(join(root, 'docker'), `#!/bin/sh\nexec ${fixture.proxy} "$@"`, { mode: 0o755 }); await writeFile(fixture.log, '');
    const run = spawnSync(cli, ['--json', '-t', '1', 'installed npm 70 MiB'], { cwd: fixture.workspace, env: modeEnv, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    assert.equal(run.error, undefined, run.error?.message); assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const receipt = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(receipt.status, 'completed'); assert.equal(receipt.effect_state, 'none'); assert.equal(receipt.result, 'installed-npm-70m-ok');
    assert.equal((await readFile(join(fixture.workspace, 'node_modules', 'installed-capacity-fixture', 'payload.bin'))).length, 73_400_320);
    const records = await jsonl(fixture.log); const create = records.find(r => r.argv.includes('/app/src/container-runtime.mjs')); assert.ok(create);
    assert.deepEqual(values(create.argv, '--user'), [`${process.getuid()}:${process.getgid()}`]);
    assert.equal(create.translatedArgv.at(create.translatedArgv.indexOf('--user') + 1), `${process.getuid()}:${process.getgid()}`);
    const evidence = receipt.evidence.find(value => value && value.call_id === 'npm-install-call'); assert.ok(evidence); assert.equal(evidence.ok, true); assert.equal(evidence.code, 0);
    const persisted = docker('run', '--rm', '--pull=never', '--user', '0:0', '--mount', `type=bind,src=${fixture.workspace},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--entrypoint', 'sh', image, '-c', 'cat /workspace/.yolo/last-receipt.json');
    assert.deepEqual(JSON.parse(persisted), receipt);
    await assertStableAbsence(create.stdout, create.argv[3], create.argv[5].split('=')[1], foreignId, foreignName);
    assert.match(docker('ps', '-aq', '--no-trunc', '--filter', `id=${foreignId}`).trim(), new RegExp(`^${foreignId}$`));
    docker('rm', '--force', foreignId); foreignId = null;
    docker('run', '--rm', '--pull=never', '--user', '0:0', '--mount', `type=bind,src=${fixture.workspace},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--entrypoint', 'sh', image, '-c', 'rm -rf /workspace/.yolo');
  } finally { if (foreignId) try { docker('rm', '--force', foreignId); } catch {} if (fixture) { try { docker('run', '--rm', '--pull=never', '--user', '0:0', '--mount', `type=bind,src=${fixture.workspace},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--entrypoint', 'sh', image, '-c', 'rm -rf /workspace'); } catch {} try { await cleanupOwned(fixture); } catch {} } await rm(root, { recursive: true, force: true }); }
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
    const fake = `#!/usr/bin/env node\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(historyLog)},JSON.stringify(a)+'\\n');if(a[0]==='info'){process.stdout.write('["name=seccomp,profile=builtin"]');process.exit(0)}if(a[0]==='image'){process.stdout.write(JSON.stringify({Id:'sha256:${'a'.repeat(64)}',RepoTags:['yoloharness-local:0.1.0'],Config:{Labels:{'org.yoloharness.source-digest':${JSON.stringify(oldDigest)}},Entrypoint:['node','/app/src/container-runtime.mjs']}}));process.exit(0)}process.stderr.write('unexpected docker operation: '+a[0]+'\\n');process.exit(91)\n`;
    const bin = join(root, 'bin'); await mkdir(bin); await writeFile(join(bin, 'docker'), fake, { mode: 0o755 });
    await writeFile(join(config, 'yoloharness', 'config.json'), JSON.stringify({ version: 1, model: 'synthetic-model' })); await writeFile(join(config, 'yoloharness', 'credentials.json'), JSON.stringify({ accessToken: 'synthetic', refreshToken: 'synthetic', expiresAt: Date.now() + 3_600_000 }));
    const installed = spawnSync(process.execPath, [join(packed, 'package', 'install.mjs')], { cwd: join(packed, 'package'), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data }, encoding: 'utf8' }); assert.equal(installed.status, 0, installed.stderr); await writeFile(join(data, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: `sha256:${'a'.repeat(64)}`, sourceDigest: oldDigest, sourceVersion: '0.1.0' }));
    const run = spawnSync(join(home, '.local', 'bin', 'yolo'), ['--json', 'historical identity RED'], { cwd: root, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, PATH: `${bin}:${process.env.PATH}`, YOLO_RESPONSES_URL: 'https://chatgpt.com/backend-api/codex/responses' }, encoding: 'utf8' });
    assert.equal(run.status, 1); assert.equal(run.stderr, 'starting bounded run (10 minutes)\nWarning: files in the selected project are intentionally exposed to the agent and may be disclosed\nrefusing launch: Docker rootless mode was not verified\n'); assert.equal(run.stdout, '');
    const history = (await readFile(historyLog, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line)); assert.deepEqual(history, [
      ['image', 'inspect', '--format', '{{json .}}', `sha256:${'a'.repeat(64)}`],
      ['info', '--format', '{{json .SecurityOptions}}'],
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const childMode of ['spawn-error', 'timeout']) test(`proxy ${childMode} is bounded, reaped, and cleanup retains exact ownership boundaries`, { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-proxy-failure-')); let foreignId; let fixture;
  try {
    fixture = await makeFixture(root); const cli = await installPacked(root, fixture);
    const foreignName = `yoloharness-foreign-${childMode}-${process.pid}`;
    foreignId = docker('create', '--pull=never', '--name', foreignName, image, 'sleep', '60').trim();
    const modeEnv = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: fixture.config, XDG_DATA_HOME: fixture.data, DOCKER_CONFIG: join(root, 'docker-config'), DOCKER_HOST: fixture.endpoint, DOCKER_CONTEXT: undefined, DOCKER_TLS_VERIFY: undefined, DOCKER_CERT_PATH: undefined, PATH: `${root}:${process.env.PATH}`, YOLO_TEST_MODE: 'rootless', YOLO_TEST_ROOTFUL: '0', YOLO_PROXY_CHILD: childMode };
    await writeFile(join(root, 'docker'), `#!/bin/sh\nexec ${fixture.proxy} "$@"`, { mode: 0o755 }); await writeFile(fixture.log, '');
    const started = Date.now(); const run = spawnSync(cli, ['--json', '-t', childMode === 'timeout' ? '1' : '0.1', `identity evidence induced-${childMode}`], { cwd: fixture.workspace, env: modeEnv, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    const duration = Date.now() - started; assert.ok(duration < 120_000); assert.equal(run.error, undefined, run.error?.message); assert.notEqual(run.status, 0);
    const records = await jsonl(fixture.log); const create = records.find(r => r.argv[0] === 'create'); assert.ok(create); const createdId = create.stdout; const label = create.argv[5].split('=')[1];
    const start = records.find(r => r.argv[0] === 'start'); assert.ok(start); assert.deepEqual(start.env, { DOCKER_HOST: fixture.endpoint, DOCKER_CONTEXT: null, DOCKER_CONFIG: join(root, 'docker-config'), DOCKER_TLS_VERIFY: null, DOCKER_CERT_PATH: null, PATH: `${root}:${process.env.PATH}` });
    if (childMode === 'spawn-error') assert.deepEqual(start.events.map(e => e.type), ['spawn', 'spawn-error', 'close']);
    else assert.deepEqual(start.events.map(e => e.type), ['spawn', 'timeout', 'kill', 'close']);
    assert.ok(duration >= (childMode === 'timeout' ? 200 : 0) && duration < 120_000);
    const previousTransient = process.env.YOLO_CLEANUP_TRANSIENT;
    process.env.YOLO_CLEANUP_TRANSIENT = '1';
    let cleanupHistory;
    try { cleanupHistory = await cleanupOwned(fixture, foreignId, (...args) => execFileSync(fixture.proxy, args, { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })); } finally {
      if (previousTransient === undefined) delete process.env.YOLO_CLEANUP_TRANSIENT;
      else process.env.YOLO_CLEANUP_TRANSIENT = previousTransient;
    }
    assert.deepEqual(cleanupHistory, {
      attempts: [
        { attempt: 1, resource: 'container', target: fixture.provider, status: 'success' },
        { attempt: 1, resource: 'network', target: fixture.network, status: 'error', error: 'injected transient cleanup failure' },
        { attempt: 1, resource: 'image', target: fixture.tag, status: 'success' },
        { attempt: 2, resource: 'network', target: fixture.network, status: 'success' },
      ],
      errors: [{ attempt: 1, resource: 'network', target: fixture.network, error: 'injected transient cleanup failure' }],
      retries: [{ fromAttempt: 1, toAttempt: 2, resources: ['network'] }],
      successes: [
        { attempt: 1, resource: 'container', target: fixture.provider },
        { attempt: 1, resource: 'image', target: fixture.tag },
        { attempt: 2, resource: 'network', target: fixture.network },
      ],
    });
    await assertStableAbsence(createdId, create.argv[3], label, foreignId, foreignName, fixture);
  } finally { if (foreignId) try { docker('rm', '--force', foreignId); } catch {} if (fixture) try { await cleanupOwned(fixture); } catch {} await rm(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: 'completed', prior: { version: 1, run_id: 'run-completed', status: 'completed', effect_state: 'none', result: 'completed result', evidence: [{ call_id: 'completed-call', ok: true }], artifacts: ['completed.txt'], errors: ['primary completed'], cleanup_history: [{ action: 'stop', success: true }] } },
  { name: 'partial', prior: { version: 1, run_id: 'run-partial', status: 'failed', effect_state: 'uncertain', result: 'partial result', evidence: [{ call_id: 'partial-call', ok: false }], artifacts: ['partial.txt'], errors: ['primary partial'], cleanup_history: [{ action: 'stop', success: false }] } },
  { name: 'generic-primary', primary: true },
  { name: 'no-prior' },
  { name: 'control', control: true, prior: { version: 1, run_id: 'run-control', status: 'completed', effect_state: 'none', result: 'control result', evidence: [{ call_id: 'control-call', ok: true }], artifacts: ['control.txt'], errors: [], cleanup_history: [] } },
]) test(`packed public executable preserves ${scenario.name} receipt through nested cleanup_unknown`, { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), `yoloharness-packed-cleanup-${scenario.name}-`)); let fixture; let createdId;
  try {
    fixture = await makeFixture(root);
    await writeFile(fixture.d2Output, scenario.prior && !scenario.control ? `${JSON.stringify(scenario.prior)}\n` : scenario.control ? `${JSON.stringify(scenario.prior)}\n` : '');
    if (scenario.prior && !scenario.control) { await mkdir(join(fixture.workspace, '.yolo'), { recursive: true }); await writeFile(join(fixture.workspace, '.yolo', 'last-receipt.json'), `${JSON.stringify(scenario.prior)}\n`); }
    const cli = await installPacked(root, fixture);
    const modeEnv = { ...packedDockerEnvironment(fixture.endpoint, root), HOME: join(root, 'home'), XDG_CONFIG_HOME: fixture.config, XDG_DATA_HOME: fixture.data, YOLO_TEST_MODE: 'rootless', YOLO_TEST_ROOTFUL: '0', ...(scenario.control ? {} : { YOLO_PROXY_CHILD: 'cleanup-unknown' }), ...(scenario.primary ? { YOLO_PROXY_PRIMARY: 'generic' } : {}) };
    await writeFile(join(root, 'docker'), `#!/bin/sh\nexec ${fixture.d2Proxy} \"$@\"`, { mode: 0o755 }); await writeFile(fixture.d2Log, '');
    const run = spawnSync(cli, ['--json', '-t', '0.1', `packed cleanup ${scenario.name}`], { cwd: fixture.workspace, env: modeEnv, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    assert.equal(run.error, undefined, run.error?.message); if (scenario.control) assert.equal(run.status, 0); else assert.notEqual(run.status, 0);
    const lines = run.stdout.trim().split(/\r?\n/).filter(Boolean); assert.equal(lines.length, 1, `status=${run.status} signal=${run.signal} stdout=${JSON.stringify(run.stdout)} stderr=${run.stderr}`); const receipt = JSON.parse(lines[0]);
    assert.equal(receipt.version, 1, `status=${run.status} signal=${run.signal} stdout=${JSON.stringify(run.stdout)} stderr=${run.stderr}`); assert.equal(receipt.status, scenario.control ? 'completed' : 'cleanup_unknown'); assert.equal(receipt.effect_state, scenario.control ? 'none' : 'uncertain');
    assert.equal(await readFile(join(fixture.workspace, '.yolo', 'last-receipt.json'), 'utf8'), `${JSON.stringify(receipt)}\n`);
    if (scenario.prior) { assert.equal(receipt.run_id, scenario.prior.run_id); assert.equal(receipt.result, scenario.prior.result); assert.deepEqual(receipt.evidence, scenario.prior.evidence); assert.deepEqual(receipt.artifacts, scenario.prior.artifacts); if (!scenario.control) { assert.deepEqual(receipt.cleanup_history, scenario.prior.cleanup_history); assert.deepEqual(receipt.errors.slice(0, scenario.prior.errors.length), scenario.prior.errors); } }
    else { assert.equal(receipt.run_id, null); assert.equal(receipt.result, null); assert.deepEqual(receipt.evidence, []); assert.deepEqual(receipt.artifacts, []); assert.deepEqual(receipt.cleanup_history, []); }
    if (!scenario.control) { assert.ok(receipt.errors.length >= (scenario.primary ? 2 : scenario.prior ? scenario.prior.errors.length + 1 : 2)); assert.match(receipt.errors.at(-1), /cleanup_unknown/); if (scenario.primary) assert.match(receipt.errors[0], /container exited \(42\)/); }
    const records = await jsonl(fixture.d2Log); const create = records.find(r => r.argv[0] === 'create'); assert.ok(create); createdId = create.stdout.trim();
    const selected = records.find(r => r.argv[0] === 'image'); assert.ok(selected); assert.deepEqual(selected.env, { ...Object.fromEntries(dockerSelectorKeys.map(key => [key, originalDockerSelectors[key] ?? null])), DOCKER_HOST: originalDockerSelectors.DOCKER_HOST ?? fixture.endpoint, PATH: `${root}:${process.env.PATH}` });
    const start = records.find(r => r.intercept === 'runtime-output.json'); assert.ok(start); assert.equal(start.stdout, await readFile(fixture.d2Output, 'utf8')); assert.equal(records.filter(r => r.intercept === 'runtime-output.json').length, 1);
    assert.equal(records.some(r => JSON.stringify(r).includes('.yolo/last-receipt.json')), false); assert.equal(records.some(r => JSON.stringify(r).includes('chmod')), false); assert.doesNotMatch(await readFile(fixture.d2Proxy, 'utf8'), /last-receipt|chmod|cp\.exec/);
    if (!scenario.control) { const cleanup = records.find(r => r.intercept === 'cleanup-hang'); assert.ok(cleanup); assert.deepEqual(cleanup.argv.slice(0, 2), ['rm', '--force']); assert.equal(cleanup.argv.length, 3); }
  } finally {
    if (createdId) try { docker('rm', '--force', createdId); } catch {}
    if (fixture) try { await cleanupOwned(fixture); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});
