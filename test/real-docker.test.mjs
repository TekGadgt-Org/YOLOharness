import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, access, symlink, link, stat, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runtimeSourceIdentity } from '../src/cli.mjs';
import { RUNTIME_RESOURCE_POLICY } from '../src/resource-policy.mjs';

const enabled = process.env.YOLO_REAL_DOCKER === '1';
const configuredImage = process.env.YOLO_DOCKER_IMAGE ?? 'yoloharness-local:0.1.1';
const skip = !enabled;
const dockerPath = execFileSync('command', ['-v', 'docker'], { shell: '/bin/sh', encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync(dockerPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const bestEffortDocker = (...args) => { try { execFileSync(dockerPath, args, { stdio: 'ignore' }); } catch {} };
const waitFor = async (path, timeout = 10_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await access(path).then(() => true).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
};
const restoreEnv = (old) => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
const fileEvidence = async (path) => {
  const bytes = await readFile(path);
  const metadata = await stat(path);
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), nlink: metadata.nlink };
};

// Generated only inside the disposable fixture. This observes the shipped CLI
// host process without adding production execution hooks.
const writeHostTraceFixture = async (path, tracePath) => {
  await writeFile(path, `const fs=require('fs'),cp=require('child_process');const {syncBuiltinESMExports}=require('module');let busy=false;const record=(kind,args)=>{if(busy)return;busy=true;try{fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({at:new Date().toISOString(),kind,args:args.map(value=>typeof value==='string'?value:(value?.toString?.()??typeof value))})+'\\n')}finally{busy=false}};for(const name of ['spawn','spawnSync','fork']){const original=cp[name];cp[name]=function(...args){record('child_process.'+name,args.slice(0,2));return original.apply(this,args)}}for(const name of ['readFile','writeFile','access','mkdir','readdir','open','cp','rm','stat','lstat','realpath','readlink']){const original=fs.promises[name];if(original)fs.promises[name]=function(...args){record('fs.promises.'+name,args.slice(0,1));return original.apply(this,args)}}syncBuiltinESMExports();`);
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-real-'));
  const workspace = join(root, 'workspace');
  const outsideSentinel = join(root, 'outside-sentinel.txt');
  // Docker's CLI mount grammar cannot safely represent a literal newline in a
  // source path. The shipped CLI must reject this cwd rather than handing an
  // ambiguous mount string to Docker; the ordinary workspace is the positive
  // control below.
  const newlineWorkspace = join(root, 'workspace\ncwd');
  const capture = join(root, 'capture');
  const configHome = join(root, 'home', '.config');
  const dataHome = join(root, 'home', '.local', 'share');
  const wrapperDir = join(root, 'bin');
  const hostTraceModule = join(root, 'host-trace.cjs');
  const hostTraceLog = join(root, 'host-trace.jsonl');
  const runtimeInspectPath = join(root, 'runtime-inspect.json');
  const derivativeContext = join(root, 'derivative');
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(newlineWorkspace, { recursive: true }), mkdir(capture, { recursive: true }), mkdir(configHome, { recursive: true }), mkdir(dataHome, { recursive: true }), mkdir(wrapperDir, { recursive: true }), mkdir(derivativeContext, { recursive: true })]);
  const baseId = docker('image', 'inspect', '--format', '{{.Id}}', configuredImage).trim();
  assert.match(baseId, /^sha256:[0-9a-f]{64}$/i);
  const sourceIdentity = await runtimeSourceIdentity();
  const embeddedSourceDigest = docker('image', 'inspect', '--format', '{{ index .Config.Labels "org.yoloharness.source-digest" }}', configuredImage).trim();
  assert.equal(embeddedSourceDigest, sourceIdentity.sourceDigest, 'configured image must embed the source digest it was built from');
  const network = `yoloharness-internal-${process.pid}`;
  const providerName = `${network}-provider`;
  const ownedRuntimes = new Map();
  let derivativeTag;
  let foreignId;
  // Use a test-owned, credential-free Docker client configuration. Resolve the
  // already-selected daemon endpoint before redirecting HOME/XDG so the
  // shipped subprocess exercises the same verified rootless daemon without
  // consuming the invoker's real config, auth helpers, or contexts.
  const dockerConfig = join(root, 'docker-config');
  await mkdir(dockerConfig, { recursive: true });
  const daemonEndpoint = docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', docker('context', 'show').trim()).trim();
  assert.match(daemonEndpoint, /^unix:\/\//, 'real-Docker evidence requires an explicit local daemon endpoint');
  await writeFile(join(dockerConfig, 'config.json'), '{}\n');
  const oldEnv = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'YOLO_AUTH_FILE', 'PATH', 'DOCKER_CONFIG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_HOSTNAME', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].map(key => [key, process.env[key]]));
  try {
    const caDir = join(root, 'tls'); await mkdir(caDir);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(caDir, 'ca.key'), '-out', join(caDir, 'ca.crt'), '-subj', '/CN=yoloharness-test-ca', '-days', '1'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(caDir, 'server.key'), '-out', join(caDir, 'server.csr'), '-subj', '/CN=chatgpt.com'], { stdio: 'ignore' });
    await writeFile(join(caDir, 'san.ext'), 'subjectAltName=DNS:chatgpt.com\n');
    execFileSync('openssl', ['x509', '-req', '-in', join(caDir, 'server.csr'), '-CA', join(caDir, 'ca.crt'), '-CAkey', join(caDir, 'ca.key'), '-CAcreateserial', '-out', join(caDir, 'server.crt'), '-days', '1', '-extfile', join(caDir, 'san.ext')], { stdio: 'ignore' });

    await writeFile(join(derivativeContext, 'ca.crt'), await readFile(join(caDir, 'ca.crt')));
    await mkdir(join(derivativeContext, 'nested'), { recursive: true });
    await writeFile(join(derivativeContext, '.dockerignore'), '.env\n**/*.key\n**/*secret*\ncredentials.json\n.git\n.yolo\nnested/\n');
    await writeFile(join(derivativeContext, '.env'), 'synthetic-layer-secret\n');
    await writeFile(join(derivativeContext, 'nested', 'secret.key'), 'synthetic-nested-secret\n');
    await mkdir(join(derivativeContext, '.git'), { recursive: true });
    await writeFile(join(derivativeContext, '.git', 'config'), 'credential = synthetic-git-secret\n');
    await mkdir(join(derivativeContext, '.yolo', 'runs'), { recursive: true });
    await writeFile(join(derivativeContext, '.yolo', 'runs', 'events.jsonl'), 'synthetic-yolo-secret\n');
    await writeFile(join(derivativeContext, 'credentials.json'), 'synthetic-credential-secret\n');
    await writeFile(join(derivativeContext, 'unrelated.txt'), 'unrelated-control\n');
    await writeFile(join(derivativeContext, 'Dockerfile'), `FROM ${configuredImage}\nCOPY ca.crt /usr/local/share/ca-certificates/yoloharness-test-ca.crt\nENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/yoloharness-test-ca.crt\n`);
    derivativeTag = `yoloharness-test-derivative:${process.pid}`;
    docker('build', '-t', derivativeTag, derivativeContext);
    const derivativeId = docker('image', 'inspect', '--format', '{{.Id}}', derivativeTag).trim();
    assert.match(derivativeId, /^sha256:[0-9a-f]{64}$/i);
    const history = docker('history', '--no-trunc', derivativeTag);
    for (const secret of ['synthetic-layer-secret', 'synthetic-nested-secret', 'synthetic-git-secret', 'synthetic-yolo-secret', 'synthetic-credential-secret']) assert.doesNotMatch(history, new RegExp(secret));
    const archive = join(root, 'derivative.tar');
    docker('save', '-o', archive, derivativeTag);
    const archiveBytes = await readFile(archive);
    assert.equal(archiveBytes.includes(Buffer.from('synthetic-layer-secret')), false);
    for (const secret of ['synthetic-layer-secret', 'synthetic-nested-secret', 'synthetic-git-secret', 'synthetic-yolo-secret', 'synthetic-credential-secret']) assert.equal(archiveBytes.includes(Buffer.from(secret)), false);
    const derivativeConfig = JSON.parse(docker('inspect', '--format', '{{json .Config}}', derivativeTag));
    assert.equal(derivativeConfig.Env.some(value => /synthetic-(?:layer|nested|git|yolo|credential)-secret/i.test(value)), false);
    assert.ok(derivativeConfig.Env.includes('NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/yoloharness-test-ca.crt'));
    const providerHostilePayload = 'provider-only-$(touch /host/provider-output-canary) ; /etc/shadow';
    const providerScript = `const https=require('https'),fs=require('fs');let n=0;const s=https.createServer({key:fs.readFileSync('/tls/server.key'),cert:fs.readFileSync('/tls/server.crt')},(q,r)=>{if(q.url==='/health'){r.writeHead(200);return r.end('ok')}let b='';q.on('data',c=>b+=c);q.on('end',()=>{n++;fs.writeFileSync('/capture/request-'+n+'.json',JSON.stringify({body:b,remote:q.socket.remoteAddress,pid:process.pid,authorization:q.headers.authorization ?? null}));if(b.includes('reauth-probe')){r.writeHead(401);return r.end('unauthorized')}r.writeHead(200,{'content-type':'text/event-stream'});if(b.includes('deadline-probe')||b.includes('sigint-probe'))r.write('data: {"type":"response.output_text.delta","delta":"partial-stream-before-interrupt"}\\n\\n');const mode=b.includes('sigint-probe')?'sigint':b.includes('stdout-overflow-probe')?'stdout-overflow':b.includes('stderr-overflow-probe')?'stderr-overflow':b.includes('stdout-control-probe')?'stdout-control':b.includes('stderr-control-probe')?'stderr-control':b.includes('boundary-probe')?'boundary':b.includes('pid-pressure-probe')?'pid-pressure':b.includes('memory-pressure-probe')?'memory-pressure':b.includes('resource-probe')?'resource':b.includes('nested-docker-probe')?'nested-docker':b.includes('python-baseline-probe')?'python-baseline':b.includes('missing-command-recovery-probe')?'missing-command-recovery':b.includes('deadline-probe')?'deadline':'whole';const followup=b.includes('function_call_output');const commands={sigint:['sh','-c','printf started > /workspace/sigint-started; sleep 5; printf late > /workspace/sigint-late'],deadline:['sh','-c','printf started > /workspace/deadline-started; sleep 5; printf late > /workspace/deadline-late'],'stdout-overflow':['sh','-c','head -c 1048577 /dev/zero'],'stderr-overflow':['sh','-c','head -c 1048577 /dev/zero >&2'],'stdout-control':['sh','-c','sleep 0.1; printf control > /workspace/stdout-control'],'stderr-control':['sh','-c','sleep 0.1; printf control > /workspace/stderr-control'],boundary:['sh','-c','set -eu; test -L /workspace/container-known-target; test -r /workspace/container-known-target; test ! -w /workspace/container-known-target; test ! -e /host-root; test ! -e /var/run/docker.sock; test ! -e /run/podman/podman.sock; test ! -e /workspace/../outside-sentinel.txt; test ! -e /host-proc; test ! -e /host-home; test ! -e /dev/kvm; test ! -e /root/.ssh; test ! -e ${JSON.stringify(outsideSentinel)}; if cat ${JSON.stringify(outsideSentinel)} >/tmp/outside-read 2>/tmp/outside-read.err; then exit 41; fi; if printf hostile > ${JSON.stringify(outsideSentinel)} 2>/tmp/outside-write.err; then exit 42; fi; printf boundary > /workspace/boundary-artifact; test "$(cat /workspace/boundary-artifact)" = boundary; rm /workspace/boundary-artifact; printf control-complete'],resource:['sh','-c','set -eu; test ! -w /app && test "$(cat /sys/fs/cgroup/memory.max)" = 536870912 && test "$(cat /sys/fs/cgroup/pids.max)" = 128 && grep -Eq "^Seccomp:[[:space:]]+2$" /proc/1/status && grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/1/status && pids=""; for i in $(seq 1 8); do (sleep 0.05)& pids="$pids $!"; done; wait $pids; printf pid-control-complete; node -e "const b=Buffer.alloc(16*1024*1024,1); if(b[0]!==1)process.exit(1)"; printf memory-control-complete; printf control-complete'],"pid-pressure":['sh','-c','set -eu; printf "128\\n" > /workspace/wrc11-pid-started; for i in $(seq 1 256); do (sleep 1)& done; wait'],"memory-pressure":['sh','-c','set -eu; printf "536870912\\n" > /workspace/wrc11-memory-started; node --max-old-space-size=1024 -e "const a=[];for(let i=0;i<100000000;i++)a.push(i);setTimeout(()=>process.exit(0),100)" & child=$!; set +e; wait "$child"; child_status=$?; set -e; events=$(cat /sys/fs/cgroup/memory.events); printf "child_status=%s\\n%s\\n" "$child_status" "$events" | tee /workspace/wrc11-memory-observed; test "$child_status" -ne 0; printf "%s\\n" "$events" | grep -Eq "^oom_kill [1-9]"; exit 1'],"nested-docker":['sh','-c','set -eu; test ! -S /var/run/docker.sock; ! command -v docker; ! command -v podman; ! docker info >/tmp/docker-attempt.out 2>/tmp/docker-attempt.err; ! podman info >/tmp/podman-attempt.out 2>/tmp/podman-attempt.err; test ! -e /run/docker.sock; command -v sh >/dev/null; printf control-complete'],'python-baseline':['python3','-c',"open('/workspace/hello.txt','w').write('hello from python'); print(open('/workspace/hello.txt').read(),end='')"],'missing-command-recovery':['definitely-not-installed-yoloharness-command'],'recovery':['sh','-c','printf recovered > /workspace/recovery-artifact']};const lifecycle=mode!=='whole';const tool={type:'response.output_item.done',item:{type:'function_call',id:mode==='whole'?'item-1':mode+'-item',call_id:mode==='whole'?'synthetic-1':mode+'-call',name:'exec',arguments:JSON.stringify(lifecycle?{command:commands[(mode==='missing-command-recovery'&&followup)?'recovery':mode][0],args:commands[(mode==='missing-command-recovery'&&followup)?'recovery':mode].slice(1)}:{command:'sh',args:['-c','test "$(cat /workspace/.env)" = "SYNTHETIC_ENV=visible-to-agent" && test "$(cat /workspace/fixture.key)" = synthetic-key && test "$(cat /workspace/fixture.token)" = synthetic-token-file && test -z "$ACCESS_TOKEN$REFRESH_TOKEN$DOCKER_CONFIG" && test ! -e /proc/1/fd/3 && test "$(id -u)" = "$(stat -c %u /proc/1)" && printf whole-runtime-ok']}),status:'completed'}};const completed={type:'response.completed',response:{id:mode==='whole'?'synthetic-1':mode+'-response',status:'completed'}};const hostile={type:'response.output_text.delta',delta:${JSON.stringify(providerHostilePayload)}};if(mode==='whole'&&n===1)fs.writeFileSync('/capture/emitted-hostile-sse.txt',hostile.delta+'\\n');const events=mode==='whole'&&n===1?[hostile,tool,completed]:mode==='missing-command-recovery'&&followup&&!b.includes('recovery-artifact')?[tool,completed]:!followup?[tool,completed]:[{type:'response.output_text.delta',delta:lifecycle?'control-complete':(b.includes('whole-runtime')?${JSON.stringify(providerHostilePayload)}+' whole-runtime-ok':'whole-runtime-ok')},completed];r.end(events.map(x=>'data: '+JSON.stringify(x)+'\\n\\n').join(''))})});s.listen(443,'0.0.0.0',()=>fs.writeFileSync('/capture/ready','ready'));`;
    docker('network', 'create', '--internal', network);
    docker('run', '--detach', '--pull=never', '--network', network, '--network-alias', 'chatgpt.com', '--name', providerName, '--mount', `type=bind,src=${capture},dst=/capture,readonly=false`, '--mount', `type=bind,src=${caDir},dst=/tls,readonly=true`, '--entrypoint', 'node', derivativeTag, '-e', providerScript);
    await waitFor(join(capture, 'ready'));
    const expectedLabel = `yoloharness.run=`;
    const foreignName = `yoloharness-foreign-${process.pid}`;
    foreignId = docker('create', '--pull=never', '--name', foreignName, '--label', 'yoloharness.run=foreign', configuredImage, 'sleep', '60').trim();
    assert.match(foreignId, /^[a-f0-9]{64}$/i);
    const wrapperPath = join(wrapperDir, 'docker');
    await writeFile(wrapperPath, `#!/usr/bin/env node\nconst cp=require('child_process'),fs=require('fs');const a=process.argv.slice(2);let createMeta; if(a[0]==='create'){const name=a[a.indexOf('--name')+1],label=a[a.indexOf('--label')+1],ni=a.indexOf('--network'),ii=a.lastIndexOf(${JSON.stringify(baseId)});if(!name||!name.startsWith('yoloharness-')||!label||!label.startsWith(${JSON.stringify(expectedLabel)})||ni<0||a[ni+1]!=='bridge'||a.filter(x=>x==='--network').length!==1||ii<0) process.exit(91);a[ni+1]=${JSON.stringify(network)};a[ii]=${JSON.stringify(derivativeId)};createMeta={name,label};}if(a[0]==='start'){const child=cp.spawn(${JSON.stringify(dockerPath)},a,{stdio:['inherit','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.once('close',(code,signal)=>{if(code===0){const inspected=cp.spawnSync(${JSON.stringify(dockerPath)},['inspect',a.at(-1)],{encoding:'utf8'});if(inspected.status===0)fs.writeFileSync(${JSON.stringify(runtimeInspectPath)},inspected.stdout);}if(signal)process.kill(process.pid,signal);else process.exit(code??92);});return;}const result=cp.spawnSync(${JSON.stringify(dockerPath)},a,{encoding:'utf8',stdio:['inherit','pipe','pipe']});if(a[0]==='create'&&result.status===0){const inspected=cp.spawnSync(${JSON.stringify(dockerPath)},['inspect',result.stdout.trim()],{encoding:'utf8'});fs.appendFileSync(${JSON.stringify(join(root, 'docker-argv.jsonl'))},JSON.stringify(a)+'\\n');fs.appendFileSync(${JSON.stringify(join(root, 'docker-create.jsonl'))},JSON.stringify({...createMeta,id:result.stdout.trim(),inspection:JSON.parse(inspected.stdout)[0]})+'\\n');}process.stderr.write(result.stderr??'');process.stdout.write(result.stdout??'');process.exit(result.status??92);\n`, { mode: 0o755 });
    await mkdir(join(configHome, 'yoloharness'), { recursive: true }); await mkdir(join(dataHome, 'yoloharness'), { recursive: true });
    await mkdir(join(workspace, '.agents', 'skills', 'local-skill'), { recursive: true });
    await mkdir(join(dataHome, 'yoloharness', 'skills', 'shared-skill'), { recursive: true });
    await writeFile(join(workspace, '.agents', 'skills', 'local-skill', 'SKILL.md'), '---\nname: local-skill\ndescription: local synthetic skill\n---\nLocal synthetic instructions.\n');
    await writeFile(join(dataHome, 'yoloharness', 'skills', 'shared-skill', 'SKILL.md'), '---\nname: shared-skill\ndescription: shared synthetic skill\n---\nShared synthetic instructions.\n');
    await writeFile(join(dataHome, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: baseId, ...sourceIdentity }));
    await writeFile(join(configHome, 'yoloharness', 'credentials.json'), JSON.stringify({ accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', clientId: 'synthetic-client', expiresAt: Date.now() + 1_800_000 }));
    await writeFile(join(configHome, 'yoloharness', 'config.json'), JSON.stringify({ version: 1, model: 'synthetic-model' }));
    // Exercise the actual packed installer and installed launcher for the
    // whole-runtime path; the checkout CLI must not be the test subject.
    const packedDir = join(root, 'packed'); await mkdir(packedDir);
    const packedName = execFileSync('npm', ['pack', '--pack-destination', packedDir], { cwd: process.cwd(), encoding: 'utf8' }).trim().split(/\r?\n/).at(-1);
    execFileSync('tar', ['-xzf', join(packedDir, packedName), '-C', packedDir]);
    const installed = spawnSync(process.execPath, [join(packedDir, 'package', 'install.mjs')], { cwd: join(packedDir, 'package'), env: { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome }, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    const installedCli = join(root, 'home', '.local', 'bin', 'yolo');
    await writeFile(join(workspace, '.env'), 'SYNTHETIC_ENV=visible-to-agent\n');
    await writeFile(outsideSentinel, 'outside sentinel');
    const hostModelCanary = join(root, `host-model-canary-${process.pid}`);
    await writeFile(hostModelCanary, 'host canary unchanged');
    await writeFile(join(workspace, 'fixture.key'), 'synthetic-key\n');
    await writeFile(join(workspace, 'fixture.token'), 'synthetic-token-file\n');
    await symlink('/etc/hosts', join(workspace, 'container-known-target'));
    await writeHostTraceFixture(hostTraceModule, hostTraceLog);
    const canary = docker('run', '--rm', '--pull=never', '--network', network, '--entrypoint', 'node', derivativeTag, '-e', "require('https').get('https://chatgpt.com/health',r=>{console.log(r.statusCode);r.resume();r.on('end',()=>process.exit(0))}).on('error',e=>{console.error(e.message);process.exit(1)})");
    assert.match(canary, /200|404|401/);
    const env = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, YOLO_AUTH_FILE: join(configHome, 'yoloharness', 'credentials.json'), DOCKER_CONFIG: dockerConfig, DOCKER_HOST: daemonEndpoint, PATH: `${wrapperDir}:${process.env.PATH}`, NODE_OPTIONS: `--require=${hostTraceModule}`, HTTP_PROXY: 'http://hostile.invalid:9', HTTPS_PROXY: 'http://hostile.invalid:9', ALL_PROXY: 'http://hostile.invalid:9', AWS_SECRET_ACCESS_KEY: 'synthetic-hostile-secret', GITHUB_TOKEN: 'synthetic-hostile-token', SSH_AUTH_SOCK: '/tmp/hostile-agent.sock', NPM_CONFIG_USERCONFIG: '/tmp/hostile.npmrc', YOLO_DOCKER_IMAGE: 'hostile-image', YOLO_DOCKER_COMMAND: 'sh -c hostile', YOLO_PROVIDER_TOKEN: 'synthetic-hostile-provider-token' };
    for (const key of ['DOCKER_CONTEXT', 'DOCKER_HOSTNAME', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
    const wrc02Argv = [installedCli, '--json', `whole-runtime nonce synthetic $(touch ${hostModelCanary}) /etc/shadow`];
    const wrc02StartedAt = new Date().toISOString();
    const child = spawn(process.execPath, wrc02Argv, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const wrc02EndedAt = new Date().toISOString();
    assert.equal(exit.code, 0, `${stderr}${stdout}\nprovider-log:\n${(() => { try { return docker('logs', providerName); } catch (error) { return error.stdout ?? error.message; } })()}\nwrapper:\n${await readFile(join(root, 'docker-argv.jsonl'), 'utf8').catch(() => 'missing')}\nnetwork:\n${(() => { try { return docker('network', 'inspect', network); } catch (error) { return error.stdout ?? error.message; } })()}`);
    assert.match(stderr, /Warning: files in the selected project are intentionally exposed/);
    const record = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); assert.equal(record.status, 'completed'); assert.equal(record.result, `${providerHostilePayload} whole-runtime-ok`);
    const emittedHostile = await readFile(join(capture, 'emitted-hostile-sse.txt'), 'utf8');
    assert.equal(emittedHostile, `${providerHostilePayload}\n`, 'WRC-02 must retain the provider-emitted hostile SSE payload, not only the request');
    assert.ok(stdout.includes(providerHostilePayload), 'WRC-02 must observe the hostile SSE after it crosses the provider/client boundary');
    const request = JSON.parse(await readFile(join(capture, 'request-1.json'), 'utf8')); assert.match(request.body, new RegExp(`whole-runtime nonce synthetic \\$\\(touch ${hostModelCanary.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\) /etc/shadow`)); assert.ok(request.remote);
    assert.match(request.body, /local-skill/); assert.match(request.body, /shared-skill/); assert.match(request.body, /\\"source\\":\\"local\\"/); assert.match(request.body, /\\"source\\":\\"shared\\"/);
    const secondRequest = JSON.parse(await readFile(join(capture, 'request-2.json'), 'utf8')); assert.match(secondRequest.body, /synthetic-1/);
      const hostTrace = (await readFile(hostTraceLog, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      assert.ok(hostTrace.some(entry => entry.kind === 'child_process.spawn'), 'host process instrumentation must record launcher process creation');
      assert.ok(hostTrace.some(entry => entry.kind.startsWith('fs.promises.')), 'host filesystem instrumentation must record launcher filesystem calls');
      assert.equal(await readFile(hostModelCanary, 'utf8'), 'host canary unchanged');
      assert.equal(hostTrace.some(entry => entry.args.some(value => /host-model-canary|provider-output-canary|etc\/shadow|\$\(touch|hostile-image|YOLO_DOCKER_COMMAND/i.test(value))), false, 'provider-emitted model values must not reach host operations');
      if (process.env.YOLO_EVIDENCE_DIR) {
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-02-host-trace.jsonl'), `${hostTrace.map(entry => JSON.stringify(entry)).join('\n')}\n`);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-02-provider-payload.txt'), emittedHostile);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-02-command'), `${JSON.stringify({ executable: process.execPath, argv: wrc02Argv, cwd: workspace, phase: 'shipped CLI provider-emitted hostile payload boundary', started_at: wrc02StartedAt, ended_at: wrc02EndedAt })}\n`);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-02-stdout'), stdout);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-02-stderr'), stderr);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-02-status'), `${exit.code}\n`);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-02-timestamps.json'), `${JSON.stringify({ started_at: wrc02StartedAt, ended_at: wrc02EndedAt })}\n`);
      }
      const lines = (await readFile(join(root, 'docker-argv.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.ok(lines.length >= 1);
      assert.equal(lines.some(args => args.some(value => /host-model-canary|etc\/shadow|\$\(touch|hostile-image|YOLO_DOCKER_COMMAND/i.test(value))), false);
      assert.equal(lines.every(args => args[0] === 'create' && args.includes('--network') && args.includes('--read-only')), true);
      if (process.env.YOLO_EVIDENCE_DIR) {
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-02-control-command'), `${JSON.stringify({ argv: lines[0], phase: 'test-only fixed Docker argv self-control', started_at: wrc02StartedAt, ended_at: wrc02EndedAt })}\n`);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-02-control-stdout'), `${JSON.stringify(lines[0])}\n`);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-02-control-status'), '0\n');
      }
    const runShippedProbe = async (prompt) => {
      const child = spawn(process.execPath, [installedCli, '--json', prompt], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
      const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      assert.equal(exit.signal, null, `${err}${out}`); return { ...exit, out, err };
    };
    const createdRuntimeRecords = async () => (await readFile(join(root, 'docker-create.jsonl'), 'utf8').catch(() => '')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const assertProbeRuntimeAbsent = async (records, label) => {
      assert.equal(records.length, 1, `${label} must create exactly one owned runtime`);
      const { id, name } = records[0];
      assert.match(id, /^[a-f0-9]{64}$/i);
      assert.equal(docker('ps', '-aq', '--filter', `id=${id}`).trim(), '', `${label} runtime must be absent before fixture teardown`);
      assert.equal(docker('ps', '-aq', '--filter', `name=^/${name}$`).trim(), '', `${label} runtime name must be absent before fixture teardown`);
      const scratch = records[0].inspection?.Mounts?.find(mount => mount.Type === 'volume' && mount.Destination === '/tmp')?.Name;
      assert.match(scratch ?? '', /^yoloharness-scratch-[0-9a-f-]+$/);
      assert.throws(() => docker('volume', 'inspect', scratch), `${label} scratch volume must be absent before fixture teardown`);
    };
    const pythonProbe = await runShippedProbe('python-baseline-probe');
    assert.equal(pythonProbe.code, 0, `${pythonProbe.err}${pythonProbe.out}`);
    assert.match(pythonProbe.out, /hello from python/);
    assert.equal(await readFile(join(workspace, 'hello.txt'), 'utf8'), 'hello from python');
    const pythonRecord = JSON.parse(pythonProbe.out.trim().split(/\r?\n/).at(-1));
    assert.equal(pythonRecord.status, 'completed');
    assert.deepEqual(pythonRecord.evidence.filter(value => value?.call_id === 'python-baseline-call'), [{ version: 1, ok: true, call_id: 'python-baseline-call', code: 0, output: 'hello from python' }]);
    const pythonRequest = JSON.parse(await readFile(join(capture, 'request-3.json'), 'utf8'));
    assert.match(pythonRequest.body, /Guaranteed baseline:.*python3.*python3 -m pip.*python3 -m venv/);
    assert.match(pythonRequest.body, /python3/);
    await assertProbeRuntimeAbsent((await createdRuntimeRecords()).slice(-1), 'python baseline');
    const recoveryProbe = await runShippedProbe('missing-command-recovery-probe');
    assert.equal(recoveryProbe.code, 0, `${recoveryProbe.err}${recoveryProbe.out}`);
    assert.match(recoveryProbe.out, /completed/);
    assert.equal(await readFile(join(workspace, 'recovery-artifact'), 'utf8'), 'recovered');
    assert.match(recoveryProbe.out, /definitely-not-installed-yoloharness-command/);
    assert.match(recoveryProbe.out, /127/);
    const recoveryRecord = JSON.parse(recoveryProbe.out.trim().split(/\r?\n/).at(-1));
    assert.equal(recoveryRecord.status, 'completed');
    assert.deepEqual(recoveryRecord.evidence.filter(value => value?.call_id === 'missing-command-recovery-call'), [
      { version: 1, ok: false, call_id: 'missing-command-recovery-call', code: 127, output: '', error: 'spawn definitely-not-installed-yoloharness-command ENOENT' },
      { version: 1, ok: true, call_id: 'missing-command-recovery-call', code: 0, output: '' },
    ]);
    const recoveryRequests = (await readdir(capture)).filter(name => /^request-\d+\.json$/.test(name));
    assert.ok(recoveryRequests.length >= 5, 'provider must observe failed output before recovery call');
    const recoveryBodies = await Promise.all(recoveryRequests.slice(-3).map(name => readFile(join(capture, name), 'utf8')));
    assert.ok(recoveryBodies.some(body => body.includes('function_call_output') && body.includes('definitely-not-installed-yoloharness-command')));
    assert.ok(recoveryBodies.some(body => body.includes('recovery-artifact')));
    assert.equal(await readFile(hostModelCanary, 'utf8'), 'host canary unchanged');
    const recoveryDockerArgv = await readFile(join(root, 'docker-argv.jsonl'), 'utf8');
    assert.doesNotMatch(recoveryDockerArgv, /definitely-not-installed-yoloharness-command|recovery-artifact|hello\.txt/);
    await assertProbeRuntimeAbsent((await createdRuntimeRecords()).slice(-1), 'missing-command recovery');

    const runProbe = async (prompt, minutes = '0.2') => {
      const child = spawn(process.execPath, [installedCli, '--json', '-t', minutes, prompt], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
      return { ...(await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))), out, err };
    };
    for (const [prompt, artifact] of [['boundary-probe', 'wrc-05-06-boundary'], ['resource-probe', 'wrc-10-11-resource'], ['nested-docker-probe', 'wrc-19-nested-docker']]) {
      const probe = await runProbe(prompt);
      assert.equal(probe.code, 0, `${probe.err}${probe.out}`);
      assert.match(probe.out, /control-complete/);
      if (prompt === 'resource-probe') {
        assert.match(probe.out, /pid-control-complete/);
        assert.match(probe.out, /memory-control-complete/);
      }
      if (prompt === 'boundary-probe') assert.equal(await readFile(outsideSentinel, 'utf8'), 'outside sentinel', 'outside sentinel must remain unchanged after absolute and parent traversal attempts');
      if (process.env.YOLO_EVIDENCE_DIR) {
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, `${artifact}.stdout`), probe.out);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, `${artifact}.stderr`), probe.err);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, `${artifact}.status`), `${probe.code}\n`);
      }
    }
    const pidPressure = await runProbe('pid-pressure-probe', '0.2');
    assert.equal(pidPressure.code, 0, `${pidPressure.err}${pidPressure.out}`);
    assert.equal(await readFile(join(workspace, 'wrc11-pid-started'), 'utf8').then(value => /^128\n$/.test(value)), true, 'PID probe must record the configured cgroup limit before pressure');
    assert.match(`${pidPressure.out}${pidPressure.err}`, /(?:cannot fork|failed|denied|container exited|effect|128)/i, 'PID pressure must retain an attributable child-creation failure');
    const memoryPressure = await runProbe('memory-pressure-probe', '0.2');
    assert.equal(memoryPressure.code, 0, `${memoryPressure.err}${memoryPressure.out}`);
    assert.equal(await readFile(join(workspace, 'wrc11-memory-started'), 'utf8').then(value => /^536870912\n$/.test(value)), true, 'memory probe must record the configured cgroup limit before pressure');
    const memoryObserved = await readFile(join(workspace, 'wrc11-memory-observed'), 'utf8');
    assert.match(memoryObserved, /child_status=\d+/);
    assert.match(memoryObserved, /(?:oom_kill|oom|out of memory)/i, 'memory pressure must retain an attributable memory-enforcement event');
    await rm(join(workspace, 'wrc11-pid-started'), { force: true });
    await rm(join(workspace, 'wrc11-memory-started'), { force: true });
    if (process.env.YOLO_EVIDENCE_DIR) {
      await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-11-shipped-pid-pressure-v2.stdout'), pidPressure.out);
      await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-11-shipped-pid-pressure-v2.stderr'), pidPressure.err);
      await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-11-shipped-pid-pressure-v2.status'), `${pidPressure.code}\n`);
      await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-11-shipped-memory-pressure.stdout'), memoryObserved);
      await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-11-shipped-memory-pressure.stderr'), memoryPressure.err);
      await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-11-shipped-memory-pressure.status'), `${memoryPressure.code}\n`);
    }
    const requestsBeforeReauth = (await readdir(capture)).filter(name => /^request-\d+\.json$/.test(name)).length;
    const reauth = await runProbe('reauth-probe', '0.2');
    assert.equal(reauth.code, 1, `${reauth.err}${reauth.out}`);
    assert.match(reauth.out, /reauth_required/);
    assert.doesNotMatch(`${reauth.out}${reauth.err}`, /synthetic-(?:access|refresh)-token/);
    const reauthRequests = (await readdir(capture)).filter(name => /^request-\d+\.json$/.test(name));
    assert.equal(reauthRequests.length, requestsBeforeReauth + 1, '401 must be issued exactly once without a retry');
    const reauthRequest = JSON.parse(await readFile(join(capture, `request-${requestsBeforeReauth + 1}.json`), 'utf8'));
    assert.equal(reauthRequest.authorization, 'Bearer synthetic-access-token');
    assert.equal(await access(join(workspace, '.yolo', 'runs')).then(() => true).catch(() => false), true);
    const wrapperLines = (await readFile(join(root, 'docker-argv.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(wrapperLines.length >= 5, 'whole runtime and named shipped probe launches must be retained');
    const runtimeArgs = wrapperLines[0];
    assert.equal(runtimeArgs[runtimeArgs.indexOf('--network') + 1], network);
    assert.equal(runtimeArgs.filter(value => value === '--network').length, 1);
    assert.ok(runtimeArgs.includes('--read-only'));
    assert.ok(runtimeArgs.includes('--cap-drop=ALL'));
    assert.ok(runtimeArgs.includes('--security-opt') && runtimeArgs.includes('no-new-privileges'));
    assert.ok(runtimeArgs.includes('--pids-limit') && runtimeArgs.includes('128'));
    assert.ok(runtimeArgs.includes('--memory') && runtimeArgs.includes('512m'));
    assert.ok(runtimeArgs.includes('--cpus') && runtimeArgs.includes('1'));
    assert.equal(runtimeArgs.filter(value => value === '--mount').length, 2);
    const runtimeMounts = runtimeArgs.flatMap((value, index) => value === '--mount' ? [runtimeArgs[index + 1]] : []);
    assert.match(runtimeMounts[0], /^type=volume,src=yoloharness-scratch-[0-9a-f-]+,dst=\/tmp,volume-nocopy$/);
    assert.match(runtimeMounts[1], /^type=bind,src=.*\/workspace,dst=\/workspace,readonly=false,bind-propagation=rprivate$/s);
    assert.equal(runtimeArgs.some(value => /docker\.sock|DOCKER_CONFIG|ACCESS_TOKEN|REFRESH_TOKEN|hostile|synthetic-hostile/i.test(value)), false);
    const runtimeInspect = JSON.parse(await readFile(runtimeInspectPath, 'utf8'))[0];
    if (process.env.YOLO_EVIDENCE_DIR) {
      await mkdir(process.env.YOLO_EVIDENCE_DIR, { recursive: true });
      await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'runtime-inspect.stdout'), `${JSON.stringify(runtimeInspect)}\n`);
    }
    assert.equal(runtimeInspect.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(runtimeInspect.HostConfig.CapDrop, ['ALL']);
    assert.equal(runtimeInspect.HostConfig.SecurityOpt.includes('no-new-privileges'), true);
    assert.equal(runtimeInspect.HostConfig.PidsLimit, 128);
    assert.equal(runtimeInspect.HostConfig.Memory, 512 * 1024 * 1024);
    assert.equal(runtimeInspect.HostConfig.NanoCpus, 1 * 1e9);
    assert.equal(runtimeInspect.HostConfig.Init, true);
    assert.equal(runtimeInspect.Config.User, '0:0');
    assert.equal(runtimeInspect.Config.Labels['yoloharness.run']?.length > 0, true);
    assert.equal(runtimeInspect.HostConfig.IpcMode, 'private');
    assert.equal(runtimeInspect.HostConfig.PidMode, '');
    assert.equal(runtimeInspect.Mounts.some(mount => mount.Type === 'volume' && mount.Destination === '/tmp' && mount.Name.startsWith('yoloharness-scratch-')), true);
    assert.equal(runtimeInspect.HostConfig.Tmpfs['/home/worker'].includes(`size=${RUNTIME_RESOURCE_POLICY.homeTmpfs}`), true);
    assert.equal(runtimeInspect.Image, derivativeId);
    assert.equal(runtimeInspect.Mounts.filter(mount => mount.Destination === '/workspace').length, 1);
    assert.equal(runtimeInspect.Mounts.some(mount => mount.Type === 'bind' && /(?:docker\.sock|\/\.ssh|\/\.config|\/\.local\/share)/i.test(mount.Source ?? '')), false);
    assert.equal(runtimeInspect.Config.Env.some(value => /DOCKER_CONFIG|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN|PROXY|AWS_|GITHUB_|SSH_AUTH|NPM_CONFIG|YOLO_DOCKER|YOLO_PROVIDER/i.test(value)), false);
    assert.equal(runtimeInspect.Config.Env.includes('HOME=/home/worker'), true, 'explicit non-secret HOME allowlist value must reach the runtime');
    assert.equal(runtimeInspect.HostConfig.NetworkMode, network);
    assert.equal(runtimeInspect.NetworkSettings.Networks[network] !== undefined, true);
    assert.equal(runtimeInspect.HostConfig.SecurityOpt.includes('no-new-privileges'), true, 'shipped runtime must retain the seccomp/NNP hardening option');
      assert.equal(runtimeInspect.Config.Env.some(value => /PROXY|AWS_|GITHUB_|SSH_AUTH|NPM_CONFIG|YOLO_DOCKER|YOLO_PROVIDER|TOKEN|SECRET/i.test(value)), false);
      assert.equal(runtimeArgs.some(value => /hostile|synthetic-hostile|DOCKER_CONFIG|ACCESS_TOKEN|REFRESH_TOKEN/i.test(value)), false);
    const inspect = JSON.parse(docker('inspect', providerName))[0]; assert.equal(Object.keys(inspect.NetworkSettings.Networks).length, 1); assert.ok(inspect.NetworkSettings.Networks[network]);
    // A workspace symlink must not turn the single project bind into an escape
    // hatch. The shipped CLI rejects it before creating a runtime; the normal
    // workspace run above is the positive control.
    await symlink(outsideSentinel, join(workspace, 'outside-link.txt'));
    const symlinkChild = spawn(process.execPath, [installedCli, '--json', 'symlink escape probe'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let symlinkStderr = ''; symlinkChild.stderr.on('data', chunk => { symlinkStderr += chunk; });
    const symlinkExit = await new Promise(resolve => symlinkChild.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(symlinkExit.code, 1);
    assert.match(symlinkStderr, /symlink resolves outside workspace/);
    assert.equal(await readFile(outsideSentinel, 'utf8'), 'outside sentinel');
    await rm(join(workspace, 'container-known-target'));
    await rm(join(workspace, 'outside-link.txt'));


    // Exercise the shipped deadline path with a started marker. The command
    // deliberately has a descendant that would write after cancellation; the
    // marker synchronizes the assertion so a fast provider response cannot
    // produce a false positive.
    const deadlineChild = spawn(process.execPath, [installedCli, '--json', '-t', '0.05', 'deadline-probe'], {
      cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let deadlineStdout = ''; let deadlineStderr = '';
    deadlineChild.stdout.on('data', chunk => { deadlineStdout += chunk; }); deadlineChild.stderr.on('data', chunk => { deadlineStderr += chunk; });
    await waitFor(join(workspace, 'deadline-started'));
    const deadlineExit = await new Promise(resolve => deadlineChild.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(deadlineExit.code, 124, `${deadlineStderr}${deadlineStdout}`);
    const deadlineRecord = JSON.parse(deadlineStdout.trim().split(/\r?\n/).at(-1));
    assert.equal(deadlineRecord.result, 'partial-stream-before-interrupt');
    assert.equal(deadlineRecord.effect_state, 'uncertain');

    await new Promise(resolve => setTimeout(resolve, 1_200));
    assert.equal(await access(join(workspace, 'deadline-late')).then(() => true).catch(() => false), false);
    const assertOwnedRuntimeAbsent = (runtimeArgs) => {
      const name = runtimeArgs[runtimeArgs.indexOf('--name') + 1];
      assert.match(name, /^yoloharness-[0-9a-f-]+$/);
      assert.equal(docker('ps', '-aq', '--filter', `name=^/${name}$`).trim(), '');
    };
    const sigint = spawn(process.execPath, [installedCli, '--json', 'sigint-probe'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let sigintOut = ''; let sigintErr = ''; sigint.stdout.on('data', chunk => { sigintOut += chunk; }); sigint.stderr.on('data', chunk => { sigintErr += chunk; });
    await waitFor(join(workspace, 'sigint-started'));
    const sigintArgsBeforeSignal = JSON.parse((await readFile(join(root, 'docker-argv.jsonl'), 'utf8')).trim().split(/\r?\n/).at(-1));
    const sigintName = sigintArgsBeforeSignal[sigintArgsBeforeSignal.indexOf('--name') + 1];
    const sigintInspection = JSON.parse(docker('inspect', sigintName))[0];
    assert.equal(sigintInspection.State.Running, true, 'WRC-13 requires daemon-confirmed runtime presence before SIGINT');
    sigint.kill('SIGINT');
    const sigintExit = await new Promise(resolve => sigint.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(sigintExit.code, 130, `${sigintErr}${sigintOut}`); await new Promise(resolve => setTimeout(resolve, 600));
    const sigintRecord = JSON.parse(sigintOut.trim().split(/\r?\n/).at(-1));
    assert.equal(sigintRecord.result, 'partial-stream-before-interrupt');
    assert.equal(sigintRecord.effect_state, 'uncertain');

    assert.equal(await access(join(workspace, 'sigint-late')).then(() => true).catch(() => false), false);
    const sigintArgs = JSON.parse((await readFile(join(root, 'docker-argv.jsonl'), 'utf8')).trim().split(/\r?\n/).at(-1)); assertOwnedRuntimeAbsent(sigintArgs);

    const noSignal = await runProbe('sigint-probe', '0.2');
    assert.equal(noSignal.code, 0, `${noSignal.err}${noSignal.out}`);
    assert.match(noSignal.out, /completed/);
    assert.equal(await access(join(workspace, 'sigint-late')).then(() => true).catch(() => false), true, 'same-command no-SIGINT control must observe the delayed completion marker');
    await rm(join(workspace, 'sigint-late'));

    const createRecords = (await readFile(join(root, 'docker-create.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert.ok(createRecords.length > 0, 'created runtime identity must be retained');
    for (const record of createRecords) {
      assert.match(record.id, /^[a-f0-9]{64}$/i);
      const inspected = record.inspection;
      assert.equal(inspected.Id, record.id);
      assert.equal(inspected.Name, `/${record.name}`);
      assert.equal(inspected.Config.Labels['yoloharness.run'], record.label.split('=').slice(1).join('='));
    }
    const foreignInspection = JSON.parse(docker('inspect', foreignId))[0];
    assert.equal(foreignInspection.Id, foreignId, 'foreign labeled control must survive owned-runtime reconciliation');
    assert.equal(foreignInspection.Config.Labels['yoloharness.run'], 'foreign');

    await t.test('WRC-08 shipped CLI rejects a hardlink alias before model execution', async () => {
      const hardlinkSource = join(root, 'outside-hardlink-sentinel.txt');
      const hardlinkAlias = join(workspace, 'hardlink-alias.txt');
      await writeFile(hardlinkSource, 'outside hardlink sentinel');
      await link(hardlinkSource, hardlinkAlias);
      const sentinelBefore = await fileEvidence(hardlinkSource);
      const requestsBefore = (await readdir(capture)).filter(name => /^request-\d+\.json$/.test(name)).length;
      const negative = spawn(process.execPath, [installedCli, '--json', 'hardlink negative probe'], {
        cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let negativeOut = ''; let negativeErr = '';
      negative.stdout.on('data', chunk => { negativeOut += chunk; });
      negative.stderr.on('data', chunk => { negativeErr += chunk; });
      const negativeExit = await new Promise(resolve => negative.once('close', (code, signal) => resolve({ code, signal })));
      assert.equal(negativeExit.code, 1);
      assert.equal(negativeExit.signal, null);
      assert.equal(negativeOut, '');
      assert.match(negativeErr, /workspace contains a multiply-linked file: hardlink-alias\.txt/);
      assert.equal(await readFile(hardlinkSource, 'utf8'), 'outside hardlink sentinel');
      const sentinelAfter = await fileEvidence(hardlinkSource);
      assert.deepEqual(sentinelAfter, sentinelBefore, 'outside sentinel must remain byte-for-byte unchanged');
      assert.equal((await readdir(capture)).filter(name => /^request-\d+\.json$/.test(name)).length, requestsBefore);
      if (process.env.YOLO_EVIDENCE_DIR) {
        await mkdir(process.env.YOLO_EVIDENCE_DIR, { recursive: true });
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-08-negative.command'), `${process.execPath} ${installedCli} --json hardlink negative probe\n`);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-08-negative.stdout'), negativeOut);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-08-negative.stderr'), negativeErr);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-08-negative.status'), `${negativeExit.code}\n`);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-08-negative.fixture.json'), `${JSON.stringify({ cwd: workspace, layout: { workspace, hardlinkAlias, outsideSentinel: hardlinkSource }, sentinelBefore, sentinelAfter, providerRequestsBefore: requestsBefore, providerRequestsAfter: requestsBefore }, null, 2)}\n`);
      }
      await rm(hardlinkAlias);

      const ordinaryFile = join(workspace, 'single-link-control.txt');
      await writeFile(ordinaryFile, 'ordinary single-link control');
      const controlSentinelBefore = await fileEvidence(hardlinkSource);
      const positive = spawn(process.execPath, [installedCli, '--json', 'single-link positive control'], {
        cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let positiveOut = ''; let positiveErr = '';
      positive.stdout.on('data', chunk => { positiveOut += chunk; });
      positive.stderr.on('data', chunk => { positiveErr += chunk; });
      const positiveExit = await new Promise(resolve => positive.once('close', (code, signal) => resolve({ code, signal })));
      assert.equal(positiveExit.code, 0, `${positiveErr}${positiveOut}`);
      assert.equal(positiveExit.signal, null);
      assert.equal(JSON.parse(positiveOut.trim()).status, 'completed');
      const controlSentinelAfter = await fileEvidence(hardlinkSource);
      assert.deepEqual(controlSentinelAfter, controlSentinelBefore, 'positive control must not alter the outside sentinel');
      if (process.env.YOLO_EVIDENCE_DIR) {
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-08-control.command'), `${process.execPath} ${installedCli} --json single-link positive control\n`);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-08-control.stdout'), positiveOut);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-08-control.stderr'), positiveErr);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-08-control.status'), `${positiveExit.code}\n`);
        await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-08-control.fixture.json'), `${JSON.stringify({ cwd: workspace, layout: { workspace, ordinaryFile, outsideSentinel: hardlinkSource }, sentinelBefore: controlSentinelBefore, sentinelAfter: controlSentinelAfter }, null, 2)}\n`);
      }
      await rm(ordinaryFile);
        if (process.env.YOLO_WRC08_ONLY === '1') return;
    });

    for (const [prompt, marker] of [['stdout-overflow-probe', 'stdout-control'], ['stderr-overflow-probe', 'stderr-control']]) {
      const overflow = await runProbe(prompt, '0.2'); assert.equal(overflow.code, 124, `${overflow.err}${overflow.out}`); assert.match(overflow.out, /output limit/i);
      const overflowArgs = JSON.parse((await readFile(join(root, 'docker-argv.jsonl'), 'utf8')).trim().split(/\r?\n/).at(-1)); assertOwnedRuntimeAbsent(overflowArgs);
      const control = await runProbe(`${marker}-probe`, '0.2'); assert.equal(control.code, 0, `${control.err}${control.out}`); assert.match(control.out, /control-complete/);
      assert.equal(await access(join(workspace, marker)).then(() => true).catch(() => false), true);
      const controlArgs = JSON.parse((await readFile(join(root, 'docker-argv.jsonl'), 'utf8')).trim().split(/\r?\n/).at(-1)); assertOwnedRuntimeAbsent(controlArgs);
    }

    // The shipped subprocess must reject an XDG-selected derivative before it
    // attempts to read credentials. Keep the credential path intentionally
    // unreadable so the observed error identifies the provenance check.
    await writeFile(join(dataHome, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: derivativeId, ...sourceIdentity }));
    const hostile = spawn(process.execPath, [installedCli, '--json', 'hostile provenance'], {
      cwd: workspace,
      env: { ...env, YOLO_AUTH_FILE: join(root, 'missing-credentials.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let hostileStderr = ''; hostile.stderr.on('data', chunk => { hostileStderr += chunk; });
    const hostileExit = await new Promise(resolve => hostile.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(hostileExit.code, 1);
    assert.match(hostileStderr, /installation-owned image tag/);
    await writeFile(join(dataHome, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: baseId, ...sourceIdentity }));
    const newline = spawn(process.execPath, [installedCli, '--json', 'newline cwd'], {
      cwd: newlineWorkspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let newlineStderr = ''; newline.stderr.on('data', chunk => { newlineStderr += chunk; });
    const newlineExit = await new Promise(resolve => newline.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(newlineExit.code, 1);
    assert.match(newlineStderr, /workspace path contains unsupported control characters/);
  } finally {
    const createdLog = await readFile(join(root, 'docker-create.jsonl'), 'utf8').catch(() => '');
    for (const line of createdLog.split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        if (/^[a-f0-9]{64}$/i.test(record.id) && record.name && record.label) ownedRuntimes.set(record.id, record);
      } catch {}
    }
    restoreEnv(oldEnv);
    bestEffortDocker('rm', '--force', providerName); bestEffortDocker('network', 'rm', network); bestEffortDocker('rm', '--force', foreignId);
    for (const [id, record] of ownedRuntimes) {
      try {
        const inspected = JSON.parse(docker('inspect', id))[0];
        const actualName = inspected?.Name?.replace(/^\//, '');
        const actualLabel = inspected?.Config?.Labels?.['yoloharness.run'];
        if (inspected?.Id === id && actualName === record.name && actualLabel === record.label.split('=').slice(1).join('=')) bestEffortDocker('rm', '--force', id);
      } catch {}
    }
    if (derivativeTag) bestEffortDocker('image', 'rm', '--force', derivativeTag);
    await rm(root, { recursive: true, force: true });
  }
}

test('shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network (WRC-08 hardlink rejection and ordinary single-link positive control)', { skip }, fixture);

test('configured final image has read-only root and rootless UID0 workspace write/delete canary', { skip }, async () => {
  const workspace = await mkdtemp('/tmp/yoloharness-image-canary-');
  const volume = `yoloharness-canary-${process.pid}`;
  try {
    docker('volume', 'create', '--label', `yoloharness.run=${volume}`, volume);
    const output = docker('run', '--rm', '--pull=never', '--read-only', '--mount', `type=volume,src=${volume},dst=/tmp,volume-nocopy`, '--mount', `type=bind,src=${workspace},dst=/workspace,readonly=false,bind-propagation=rprivate`, '--user', '0:0', '--entrypoint', 'sh', configuredImage, '-c', 'id -u; touch /workspace/canary; rm /workspace/canary; ! touch /app/forbidden');
    assert.match(output, /^0\n/); assert.equal(await access(join(workspace, 'canary')).then(() => true).catch(() => false), false);
  } finally { try { docker('volume', 'rm', volume); } catch {} await rm(workspace, { recursive: true, force: true }); }
});

test('WRC-11 final image bounded PID and memory enforcement has below-limit controls', { skip: skip || process.env.YOLO_WRC11_ONLY !== '1' }, async () => {
  const daemonSecurityOptions = JSON.parse(docker('info', '--format', '{{json .SecurityOptions}}').trim());
  assert.ok(Array.isArray(daemonSecurityOptions));
  assert.ok(daemonSecurityOptions.includes('name=seccomp,profile=builtin'), 'daemon must report builtin seccomp');
  assert.ok(daemonSecurityOptions.includes('name=rootless'), 'daemon must report rootless mode');
  if (process.env.YOLO_EVIDENCE_DIR) await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-11-daemon-security-options.stdout'), `${JSON.stringify(daemonSecurityOptions)}\n`);
  const below = docker('run', '--rm', '--pull=never', '--pids-limit', '8', '--memory', '64m', '--entrypoint', 'node', configuredImage, '-e', "require('fs').writeFileSync('/tmp/below-limit','ok')");
  assert.equal(below, '');
  const pidProbe = docker('run', '--rm', '--pull=never', '--pids-limit', '8', '--entrypoint', 'node', configuredImage, '-e', "const cp=require('child_process');let rejected=0;for(let i=0;i<64;i++){const child=cp.spawnSync(process.execPath,['-e','process.exit(0)']);if(child.error||child.status===null)rejected++};process.exit(rejected>0?0:1)");
  assert.equal(pidProbe, '');
  let memoryError;
  try { docker('run', '--rm', '--pull=never', '--memory', '32m', '--entrypoint', 'node', configuredImage, '-e', "const b=Buffer.alloc(128*1024*1024,1);setTimeout(()=>console.log(b[0]),100)"); } catch (error) { memoryError = error; }
  assert.ok(memoryError, 'bounded memory probe must be rejected by the daemon');
  assert.notEqual(memoryError.status, 0);
});

test('WRC-07 records safe nested-bind setup denial and ordinary nested-directory control', { skip: skip || process.env.YOLO_WRC07_ONLY !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-wrc07-'));
  const nested = join(root, 'nested');
  try {
    await mkdir(nested);
    await writeFile(join(nested, 'ordinary-control.txt'), 'ordinary nested directory control');
    assert.equal(await readFile(join(nested, 'ordinary-control.txt'), 'utf8'), 'ordinary nested directory control');
    let status = 0; let output = '';
    const nestedBindCommand = ['unshare', '--user', '--map-root-user', '--mount', '--', 'mount', '--bind', root, nested];
    try { output = execFileSync(nestedBindCommand[0], nestedBindCommand.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { status = error.status ?? 1; output = `${error.stdout ?? ''}${error.stderr ?? ''}`; }
    if (process.env.YOLO_EVIDENCE_DIR) await writeFile(join(process.env.YOLO_EVIDENCE_DIR, 'wrc-07-nested-bind-denial.json'), `${JSON.stringify({ version: 1, command: nestedBindCommand, cwd: root, environment: { platform: process.platform, kernel: execFileSync('uname', ['-sr'], { encoding: 'utf8' }).trim(), uid: typeof process.getuid === 'function' ? process.getuid() : null, euid: typeof process.geteuid === 'function' ? process.geteuid() : null }, phase: 'safe unprivileged nested-bind fixture setup', status, output, control: 'ordinary nested directory read succeeded' }, null, 2)}\n`);
    assert.notEqual(status, 0);
    assert.match(output, /(?:operation not permitted|permission denied|unshare|invalid argument)/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('WRC-18 shipped setup uses only the package/src build context and emits secret-free layers', { skip: skip || process.env.YOLO_WRC18_ONLY !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoloharness-wrc18-'));
  const bin = join(root, 'bin'); const captured = join(root, 'captured-context'); const config = join(root, 'config'); const data = join(root, 'data');
  const installation = join(root, 'installation');
  const runTag = `yoloharness-wrc18:${process.pid}`; const installedTag = 'yoloharness-local:0.1.1';
  await mkdir(bin, { recursive: true }); await mkdir(config, { recursive: true }); await mkdir(data, { recursive: true }); await mkdir(installation, { recursive: true });
  await cp(new URL('../package.json', import.meta.url), join(installation, 'package.json'));
  await cp(new URL('../src', import.meta.url), join(installation, 'src'), { recursive: true });
  await cp(new URL('../assets', import.meta.url), join(installation, 'assets'), { recursive: true });
  for (const [name, contents] of [['.env', 'synthetic-layer-secret'], ['nested/.env', 'synthetic-nested-secret'], ['credentials.json', 'synthetic-credential-secret'], ['id_rsa', 'synthetic-key-secret'], ['.git/config', 'synthetic-git-secret'], ['.yolo/runs/events.jsonl', 'synthetic-yolo-secret'], ['unrelated.txt', 'unrelated-marker']]) {
    const target = join(installation, name); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, contents);
  }
  const wrapper = join(bin, 'docker');
  const productionBefore = docker('image', 'inspect', '--format', '{{.Id}}', installedTag).trim();
  assert.match(productionBefore, /^sha256:[0-9a-f]{64}$/i);
  await writeFile(wrapper, `#!/usr/bin/env node\nconst cp=require('child_process'),fs=require('fs');const a=process.argv.slice(2);const original=${JSON.stringify(installedTag)},run=${JSON.stringify(runTag)},capture=${JSON.stringify(captured)};if(a[0]==='build'){const context=a.at(-1);fs.cpSync(context,capture,{recursive:true});const ti=a.indexOf('-t');if(ti>=0)a[ti+1]=run;}if(a[0]==='image'&&a[1]==='inspect'&&a.at(-1)===original)a[a.length-1]=run;if(a[0]==='image'&&a[1]==='rm'&&a.at(-1)===original)a[a.length-1]=run;const r=cp.spawnSync(${JSON.stringify(dockerPath)},a,{encoding:'utf8',stdio:['ignore','pipe','pipe']});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??92);\n`, { mode: 0o755 });
  try {
    const setup = execFileSync(process.execPath, [join(installation, 'src', 'cli.mjs'), 'setup'], { cwd: installation, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data }, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(setup, /runtime image ready: sha256:[0-9a-f]{64}/i);
    const contextFiles = [];
    const collect = async (dir, prefix = '') => { for (const entry of await readdir(dir, { withFileTypes: true })) { const name = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) await collect(join(dir, entry.name), name); else contextFiles.push(name); } };
    await collect(captured);
    const sourceFiles = (await readdir(join(captured, 'src'))).map(name => `src/${name}`);
    assert.deepEqual(contextFiles.sort(), ['package.json', ...sourceFiles].sort());
    assert.equal(await access(join(captured, '.env')).then(() => true).catch(() => false), false);
    const history = docker('history', '--no-trunc', runTag);
    for (const secret of ['synthetic-layer-secret', 'synthetic-nested-secret', 'synthetic-key-secret', 'synthetic-git-secret', 'synthetic-yolo-secret', 'synthetic-credential-secret']) assert.doesNotMatch(history, new RegExp(secret));
    const archive = join(root, 'image.tar'); docker('save', '-o', archive, runTag);
    const bytes = await readFile(archive); for (const secret of ['synthetic-layer-secret', 'synthetic-nested-secret', 'synthetic-key-secret', 'synthetic-git-secret', 'synthetic-yolo-secret', 'synthetic-credential-secret']) assert.equal(bytes.includes(Buffer.from(secret)), false);
    assert.equal(docker('image', 'inspect', '--format', '{{.Id}}', installedTag).trim(), productionBefore, 'shipped setup probe must not mutate the installation-owned production image');
  } finally { bestEffortDocker('image', 'rm', '--force', runTag); await rm(root, { recursive: true, force: true }); }
});
