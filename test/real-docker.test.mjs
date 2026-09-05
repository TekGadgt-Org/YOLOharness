import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, access, symlink } from 'node:fs/promises';
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
    const providerScript = `const https=require('https'),fs=require('fs');let n=0;const s=https.createServer({key:fs.readFileSync('/tls/server.key'),cert:fs.readFileSync('/tls/server.crt')},(q,r)=>{if(q.url==='/health'){r.writeHead(200);return r.end('ok')}let b='';q.on('data',c=>b+=c);q.on('end',()=>{n++;fs.writeFileSync('/capture/request-'+n+'.json',JSON.stringify({body:b,remote:q.socket.remoteAddress,pid:process.pid,authorization:q.headers.authorization ?? null}));if(b.includes('reauth-probe')){r.writeHead(401);return r.end('unauthorized')}r.writeHead(200,{'content-type':'text/event-stream'});const mode=b.includes('sigint-probe')?'sigint':b.includes('stdout-overflow-probe')?'stdout-overflow':b.includes('stderr-overflow-probe')?'stderr-overflow':b.includes('stdout-control-probe')?'stdout-control':b.includes('stderr-control-probe')?'stderr-control':b.includes('deadline-probe')?'deadline':'whole';const followup=b.includes('function_call_output');const commands={sigint:['sh','-c','printf started > /workspace/sigint-started; sleep 5; printf late > /workspace/sigint-late'],deadline:['sh','-c','printf started > /workspace/deadline-started; sleep 5; printf late > /workspace/deadline-late'],'stdout-overflow':['sh','-c','head -c 1048577 /dev/zero'],'stderr-overflow':['sh','-c','head -c 1048577 /dev/zero >&2'],'stdout-control':['sh','-c','sleep 0.1; printf control > /workspace/stdout-control'],'stderr-control':['sh','-c','sleep 0.1; printf control > /workspace/stderr-control']};const lifecycle=mode!=='whole';const tool={type:'response.output_item.done',item:{type:'function_call',id:mode==='whole'?'item-1':mode+'-item',call_id:mode==='whole'?'synthetic-1':mode+'-call',name:'exec',arguments:JSON.stringify(lifecycle?{command:commands[mode][0],args:commands[mode].slice(1)}:{command:'sh',args:['-c','test "$(cat /workspace/.env)" = "SYNTHETIC_ENV=visible-to-agent" && test "$(cat /workspace/fixture.key)" = synthetic-key && test "$(cat /workspace/fixture.token)" = synthetic-token-file && test -z "$ACCESS_TOKEN$REFRESH_TOKEN$DOCKER_CONFIG" && test ! -e /proc/1/fd/3 && test "$(id -u)" = "$(stat -c %u /proc/1)" && printf whole-runtime-ok']}),status:'completed'}};const completed={type:'response.completed',response:{id:mode==='whole'?'synthetic-1':mode+'-response',status:'completed'}};const events=!followup?[tool,completed]:[{type:'response.output_text.delta',delta:lifecycle?'control-complete':'whole-runtime-ok'},completed];r.end(events.map(x=>'data: '+JSON.stringify(x)+'\\n\\n').join(''))})});s.listen(443,'0.0.0.0',()=>fs.writeFileSync('/capture/ready','ready'));`;
    docker('network', 'create', '--internal', network);
    docker('run', '--detach', '--pull=never', '--network', network, '--network-alias', 'chatgpt.com', '--name', providerName, '--mount', `type=bind,src=${capture},dst=/capture,readonly=false`, '--mount', `type=bind,src=${caDir},dst=/tls,readonly=true`, '--entrypoint', 'node', derivativeTag, '-e', providerScript);
    await waitFor(join(capture, 'ready'));
    const expectedLabel = `yoloharness.run=`;
    const wrapperPath = join(wrapperDir, 'docker');
    await writeFile(wrapperPath, `#!/usr/bin/env node\nconst cp=require('child_process'),fs=require('fs');const a=process.argv.slice(2);if(a[0]==='create'){const name=a[a.indexOf('--name')+1],label=a[a.indexOf('--label')+1],ni=a.indexOf('--network'),ii=a.lastIndexOf(${JSON.stringify(baseId)});if(!name||!name.startsWith('yoloharness-')||!label||!label.startsWith(${JSON.stringify(expectedLabel)})||ni<0||a[ni+1]!=='bridge'||a.filter(x=>x==='--network').length!==1||ii<0) process.exit(91);a[ni+1]=${JSON.stringify(network)};a[ii]=${JSON.stringify(derivativeId)};fs.appendFileSync(${JSON.stringify(join(root, 'docker-argv.jsonl'))},JSON.stringify(a)+'\\n');}const result=cp.spawnSync(${JSON.stringify(dockerPath)},a,{stdio:'inherit'});if(a[0]==='start'&&result.status===0){const inspected=cp.spawnSync(${JSON.stringify(dockerPath)},['inspect',a.at(-1)],{encoding:'utf8'});if(inspected.status===0)fs.writeFileSync(${JSON.stringify(runtimeInspectPath)},inspected.stdout);}process.exit(result.status??92);\n`, { mode: 0o755 });
    await mkdir(join(configHome, 'yoloharness'), { recursive: true }); await mkdir(join(dataHome, 'yoloharness'), { recursive: true });
    await writeFile(join(dataHome, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: baseId, ...sourceIdentity }));
    await writeFile(join(configHome, 'yoloharness', 'credentials.json'), JSON.stringify({ accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', clientId: 'synthetic-client', expiresAt: Date.now() + 1_800_000 }));
    await writeFile(join(configHome, 'yoloharness', 'config.json'), JSON.stringify({ version: 1, model: 'synthetic-model' }));
    await writeFile(join(workspace, '.env'), 'SYNTHETIC_ENV=visible-to-agent\n');
    await writeFile(join(workspace, 'fixture.key'), 'synthetic-key\n');
    await writeFile(join(workspace, 'fixture.token'), 'synthetic-token-file\n');
    await symlink('/etc/hosts', join(workspace, 'container-known-target'));
    const canary = docker('run', '--rm', '--pull=never', '--network', network, '--entrypoint', 'node', derivativeTag, '-e', "require('https').get('https://chatgpt.com/health',r=>{console.log(r.statusCode);r.resume();r.on('end',()=>process.exit(0))}).on('error',e=>{console.error(e.message);process.exit(1)})");
    assert.match(canary, /200|404|401/);
    const env = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, YOLO_AUTH_FILE: join(configHome, 'yoloharness', 'credentials.json'), DOCKER_CONFIG: dockerConfig, DOCKER_HOST: daemonEndpoint, PATH: `${wrapperDir}:${process.env.PATH}` };
    for (const key of ['DOCKER_CONTEXT', 'DOCKER_HOSTNAME', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
    const child = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--json', 'whole-runtime nonce synthetic'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(exit.code, 0, `${stderr}${stdout}\nprovider-log:\n${(() => { try { return docker('logs', providerName); } catch (error) { return error.stdout ?? error.message; } })()}\nwrapper:\n${await readFile(join(root, 'docker-argv.jsonl'), 'utf8').catch(() => 'missing')}\nnetwork:\n${(() => { try { return docker('network', 'inspect', network); } catch (error) { return error.stdout ?? error.message; } })()}`);
    assert.match(stderr, /Warning: files in the selected project are intentionally exposed/);
    const record = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); assert.equal(record.status, 'completed'); assert.equal(record.result, 'whole-runtime-ok');
    const request = JSON.parse(await readFile(join(capture, 'request-1.json'), 'utf8')); assert.match(request.body, /whole-runtime nonce synthetic/); assert.ok(request.remote);
    const secondRequest = JSON.parse(await readFile(join(capture, 'request-2.json'), 'utf8')); assert.match(secondRequest.body, /synthetic-1/);
    const runProbe = async (prompt, minutes = '0.2') => {
      const child = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--json', '-t', minutes, prompt], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
      return { ...(await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))), out, err };
    };
    const reauth = await runProbe('reauth-probe', '0.2');
    assert.equal(reauth.code, 1, `${reauth.err}${reauth.out}`);
    assert.match(reauth.out, /reauth_required/);
    assert.doesNotMatch(`${reauth.out}${reauth.err}`, /synthetic-(?:access|refresh)-token/);
    const reauthRequests = (await readdir(capture)).filter(name => /^request-\d+\.json$/.test(name));
    assert.equal(reauthRequests.length, 3, '401 must be issued exactly once without a retry');
    const reauthRequest = JSON.parse(await readFile(join(capture, 'request-3.json'), 'utf8'));
    assert.equal(reauthRequest.authorization, 'Bearer synthetic-access-token');
    assert.equal(await access(join(workspace, '.yolo', 'runs')).then(() => true).catch(() => false), true);
    const wrapperLines = (await readFile(join(root, 'docker-argv.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(wrapperLines.length, 2);
    const runtimeArgs = wrapperLines[0];
    assert.equal(runtimeArgs[runtimeArgs.indexOf('--network') + 1], network);
    assert.equal(runtimeArgs.filter(value => value === '--network').length, 1);
    assert.ok(runtimeArgs.includes('--read-only'));
    assert.ok(runtimeArgs.includes('--cap-drop=ALL'));
    assert.ok(runtimeArgs.includes('--security-opt') && runtimeArgs.includes('no-new-privileges'));
    assert.ok(runtimeArgs.includes('--pids-limit') && runtimeArgs.includes('128'));
    assert.ok(runtimeArgs.includes('--memory') && runtimeArgs.includes('512m'));
    assert.ok(runtimeArgs.includes('--cpus') && runtimeArgs.includes('1'));
    assert.equal(runtimeArgs.filter(value => value === '--mount').length, 1);
    assert.match(runtimeArgs[runtimeArgs.indexOf('--mount') + 1], /^type=bind,src=.*\/workspace,dst=\/workspace,readonly=false,bind-propagation=rprivate$/s);
    assert.equal(runtimeArgs.some(value => /docker\.sock|DOCKER_CONFIG|ACCESS_TOKEN|REFRESH_TOKEN/i.test(value)), false);
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
    assert.equal(runtimeInspect.Mounts.filter(mount => mount.Destination === '/workspace').length, 1);
    assert.equal(runtimeInspect.Mounts.some(mount => /(?:docker\.sock|\/\.ssh|\/\.config|\/\.local\/share)/i.test(mount.Source ?? '')), false);
    assert.equal(runtimeInspect.Config.Env.some(value => /DOCKER_CONFIG|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN/i.test(value)), false);
    assert.equal(runtimeInspect.HostConfig.NetworkMode, network);
    assert.equal(runtimeInspect.NetworkSettings.Networks[network] !== undefined, true);
    const inspect = JSON.parse(docker('inspect', providerName))[0]; assert.equal(Object.keys(inspect.NetworkSettings.Networks).length, 1); assert.ok(inspect.NetworkSettings.Networks[network]);
    // A workspace symlink must not turn the single project bind into an escape
    // hatch. The shipped CLI rejects it before creating a runtime; the normal
    // workspace run above is the positive control.
    await writeFile(outsideSentinel, 'outside sentinel');
    await symlink(outsideSentinel, join(workspace, 'outside-link.txt'));
    const symlinkChild = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--json', 'symlink escape probe'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const deadlineChild = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--json', '-t', '0.05', 'deadline-probe'], {
      cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let deadlineStdout = ''; let deadlineStderr = '';
    deadlineChild.stdout.on('data', chunk => { deadlineStdout += chunk; }); deadlineChild.stderr.on('data', chunk => { deadlineStderr += chunk; });
    await waitFor(join(workspace, 'deadline-started'));
    const deadlineExit = await new Promise(resolve => deadlineChild.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(deadlineExit.code, 124, `${deadlineStderr}${deadlineStdout}`);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    assert.equal(await access(join(workspace, 'deadline-late')).then(() => true).catch(() => false), false);
    assert.equal(docker('ps', '-aq', '--filter', 'label=yoloharness.run').trim(), '');

    const assertOwnedRuntimeAbsent = (runtimeArgs) => {
      const name = runtimeArgs[runtimeArgs.indexOf('--name') + 1];
      assert.match(name, /^yoloharness-[0-9a-f-]+$/);
      assert.equal(docker('ps', '-aq', '--filter', `name=^/${name}$`).trim(), '');
    };
    const sigint = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--json', 'sigint-probe'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let sigintOut = ''; let sigintErr = ''; sigint.stdout.on('data', chunk => { sigintOut += chunk; }); sigint.stderr.on('data', chunk => { sigintErr += chunk; });
    await waitFor(join(workspace, 'sigint-started')); sigint.kill('SIGINT');
    const sigintExit = await new Promise(resolve => sigint.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(sigintExit.code, 130, `${sigintErr}${sigintOut}`); await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(await access(join(workspace, 'sigint-late')).then(() => true).catch(() => false), false);
    const sigintArgs = JSON.parse((await readFile(join(root, 'docker-argv.jsonl'), 'utf8')).trim().split(/\r?\n/).at(-1)); assertOwnedRuntimeAbsent(sigintArgs);

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
    const hostile = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--json', 'hostile provenance'], {
      cwd: workspace,
      env: { ...env, YOLO_AUTH_FILE: join(root, 'missing-credentials.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let hostileStderr = ''; hostile.stderr.on('data', chunk => { hostileStderr += chunk; });
    const hostileExit = await new Promise(resolve => hostile.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(hostileExit.code, 1);
    assert.match(hostileStderr, /installation-owned image tag/);
    await writeFile(join(dataHome, 'yoloharness', 'image.json'), JSON.stringify({ version: 1, imageId: baseId, ...sourceIdentity }));
    const newline = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--json', 'newline cwd'], {
      cwd: newlineWorkspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let newlineStderr = ''; newline.stderr.on('data', chunk => { newlineStderr += chunk; });
    const newlineExit = await new Promise(resolve => newline.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(newlineExit.code, 1);
    assert.match(newlineStderr, /workspace path contains unsupported control characters/);
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
