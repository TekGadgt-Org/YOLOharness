#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const rl=createInterface({input:process.stdin});
for await (const line of rl) { let request; try { request=JSON.parse(line); } catch { process.stdout.write(JSON.stringify({version:1,ok:false,error:'invalid request'})+'\n'); continue; } const c=request.call; if(!c||typeof c.command!=='string'||!Array.isArray(c.args)) { process.stdout.write(JSON.stringify({version:1,ok:false,error:'command and args required'})+'\n'); continue; } const p=spawn(c.command,c.args,{cwd:'/workspace',shell:false,env:{PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/tmp'}}); let out='',err=''; p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x); await new Promise(resolve=>p.on('close',code=>{process.stdout.write(JSON.stringify({version:1,ok:code===0,code,output:out.slice(0,1048576),error:err.slice(0,1048576)})+'\n');resolve();})); }
