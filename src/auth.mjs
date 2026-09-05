import { mkdir, rename, open, readFile, chmod, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class AuthError extends Error { constructor(message, code='auth_error') { super(message); this.name='AuthError'; this.code=code; } }
export class AuthStore {
  constructor(path, { syncFile = fh => fh.sync(), syncDirectory = fh => fh.sync() } = {}) { this.path=path; this.syncFile=syncFile; this.syncDirectory=syncDirectory; }
  async load() { try { return JSON.parse(await readFile(this.path,'utf8')); } catch (e) { if(e.code==='ENOENT') return null; throw new AuthError('credential store unreadable'); } }
  async save(credentials) {
    if (!credentials?.accessToken || !credentials?.refreshToken) throw new AuthError('complete credentials required');
    await mkdir(dirname(this.path),{recursive:true,mode:0o700});
    const tmp=`${this.path}.${randomUUID()}.tmp`; const fh=await open(tmp,'wx',0o600); let committed=false;
    try {
      try { await fh.writeFile(JSON.stringify(credentials)+'\n'); await this.syncFile(fh); } finally { await fh.close(); }
      await chmod(tmp,0o600); await rename(tmp,this.path); committed=true; await chmod(this.path,0o600);
      const dir = await open(dirname(this.path), 'r');
      try { await this.syncDirectory(dir); } finally { await dir.close(); }
    } catch (error) {
      if (!committed) await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    return credentials;
  }
  async clear() { const { unlink } = await import('node:fs/promises'); await unlink(this.path).catch(e=>{if(e.code!=='ENOENT') throw e;}); }
}
function required(config) { for(const k of ['clientId','issueUrl','pollUrl','tokenUrl','redirectUri']) if(!config[k]) throw new AuthError(`missing auth configuration: ${k}`,'config_error'); }
async function body(response) { let value; try { value=await response.json(); } catch { throw new AuthError('malformed auth response','malformed_response'); } if(!value || typeof value!=='object' || Array.isArray(value)) throw new AuthError('malformed auth response','malformed_response'); return value; }
export class AuthClient {
  constructor(config) { required(config); this.config=config; this.fetch=config.fetch ?? fetch; this.store=config.store; this.refreshing=null; this.lockTimeoutMs=config.lockTimeoutMs ?? 5000; this.beforeReclaimRename=config.beforeReclaimRename; this.onLockContended=config.onLockContended; }
  async request(url, init, signal) { const r=await this.fetch(url,{...init,signal,redirect:'error'}); if(!r.ok) throw new AuthError(`auth request failed (${r.status})`,r.status===429?'rate_limited':'auth_http_error'); return body(r); }
  async begin({signal}={}) { const x=await this.request(this.config.issueUrl,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({client_id:this.config.clientId})},signal); if(typeof x.user_code!=='string'||!x.user_code||typeof x.device_auth_id!=='string'||!x.device_auth_id) throw new AuthError('malformed device authorization','malformed_response'); const n=x.interval===undefined?5:Number(x.interval); if(!Number.isFinite(n)||n<=0) throw new AuthError('invalid polling interval','malformed_response'); return {userCode:x.user_code,deviceAuthId:x.device_auth_id,interval:Math.max(3,Math.floor(n)),verificationUrl:this.config.verificationUrl}; }
  async finish(attempt,{signal,sleep=ms=>new Promise((r,j)=>{const t=setTimeout(r,ms); signal?.addEventListener('abort',()=>{clearTimeout(t);j(signal.reason)},{once:true});})}={}) { let x; const deadline=Date.now()+15*60e3; do { await sleep(attempt.interval*1000); if(signal?.aborted) throw signal.reason; const r=await this.fetch(this.config.pollUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({device_auth_id:attempt.deviceAuthId,user_code:attempt.userCode}),signal,redirect:'error'}); if(r.status===403||r.status===404) continue; if(!r.ok) throw new AuthError(`poll failed (${r.status})`); x=await body(r); } while(!x && Date.now()<deadline); if(!x?.authorization_code||!x?.code_verifier) throw new AuthError('authentication expired','auth_expired');
    const token=await this.request(this.config.tokenUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams({grant_type:'authorization_code',code:x.authorization_code,redirect_uri:this.config.redirectUri,client_id:this.config.clientId,code_verifier:x.code_verifier})},signal); if(signal?.aborted) throw signal.reason; if(typeof token.access_token!=='string'||!token.access_token||typeof token.refresh_token!=='string'||!token.refresh_token) throw new AuthError('incomplete token response','malformed_response'); const credentials={accessToken:token.access_token,refreshToken:token.refresh_token,expiresAt:token.expires_in?Date.now()+Number(token.expires_in)*1000:undefined,clientId:this.config.clientId}; await this.store.save(credentials); return credentials; }
  async refresh(credentials,{signal}={}) { if(this.refreshing) return this.refreshing; this.refreshing=(async()=>{ const lock=`${this.store.path}.lock`; const owner=randomUUID(); const started=Date.now(); let owned=false; try { while (!owned) { const acquire=`${lock}.acquire-${owner}`; try { await mkdir(acquire, { mode: 0o700 }); await writeFile(`${acquire}/owner.json`, JSON.stringify({ owner, pid: process.pid })); await rename(acquire, lock); owned=true; } catch (error) { await rm(acquire, { recursive: true, force: true }).catch(() => {}); if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || Date.now() - started >= this.lockTimeoutMs) throw new AuthError('credential refresh lock unavailable','lock_timeout'); if (this.onLockContended) await this.onLockContended({ lock, owner }); let stale=false; let age=0; let info; try { age=Date.now() - (await stat(lock)).mtimeMs; info=JSON.parse(await readFile(`${lock}/owner.json`,'utf8')); } catch {} if (age > this.lockTimeoutMs * 2) { if (!info?.owner || !Number.isInteger(info.pid)) stale=true; else { try { process.kill(info.pid, 0); } catch (e) { if (e.code === 'ESRCH') stale=true; } } } if (stale) {
   const quarantine=`${lock}.reclaim-${randomUUID()}`;
   // A single marker serializes reclaimers before the lock is moved. Unique
   // marker names would let two contenders both pass the pre-rename check.
   const reclaimMarker = `${lock}/reclaiming`;
   let markerCreated = false;
   try {
     await mkdir(reclaimMarker, { mode: 0o700 });
     markerCreated = true;
     let before = info?.owner ?? null;
     try { const latest = JSON.parse(await readFile(`${lock}/owner.json`,'utf8')); if ((latest.owner ?? null) !== before) { await rm(reclaimMarker,{recursive:true,force:true}); await new Promise(resolve=>setTimeout(resolve,25)); continue; } } catch { if (before !== null) { await rm(reclaimMarker,{recursive:true,force:true}); await new Promise(resolve=>setTimeout(resolve,25)); continue; } }
     if (this.beforeReclaimRename) await this.beforeReclaimRename({ lock, owner: before });
    await rename(lock, quarantine);
     let moved = null;
     try { moved = JSON.parse(await readFile(`${quarantine}/owner.json`,'utf8')); } catch {}
     if ((moved?.owner ?? null) === before) await rm(quarantine,{recursive:true,force:true});
     else {
       try { await stat(lock); } catch (e) { if (e.code === 'ENOENT') await rename(quarantine, lock); }
     }
   } catch (e) { if (markerCreated) await rm(reclaimMarker,{recursive:true,force:true}).catch(() => {}); if (!['ENOENT','EEXIST'].includes(e.code)) throw new AuthError('credential refresh lock unavailable','lock_timeout'); }
 } await new Promise(resolve=>setTimeout(resolve,25)); } }
      const current = await this.store.load() ?? credentials;
      if ((current.generation ?? 0) > (credentials.generation ?? 0)) return current;
      const token=await this.request(this.config.tokenUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:current.refreshToken,client_id:this.config.clientId})},signal); if(!token.access_token) throw new AuthError('refresh returned no access token','reauth_required'); const next={...current,accessToken:token.access_token,generation:(current.generation ?? 0)+1}; if(token.refresh_token) next.refreshToken=token.refresh_token; if(token.expires_in) next.expiresAt=Date.now()+Number(token.expires_in)*1000; await this.store.save(next); return next;
    } finally { if (owned) { try { const current=JSON.parse(await readFile(`${lock}/owner.json`,'utf8')); if (current.owner===owner && (await readdir(lock)).every(entry => !entry.startsWith('reclaim-'))) await rm(lock,{recursive:true,force:true}); } catch {} } } })(); try{return await this.refreshing;} finally{this.refreshing=null;} }
}
