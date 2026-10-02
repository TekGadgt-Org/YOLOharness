#!/usr/bin/env node
import { writeFile, readFile, unlink, stat } from 'node:fs/promises';
import { scratchSubpaths } from './scratch-path.mjs';
const [uidText, gidText, ...paths] = process.argv.slice(2);
const uid = Number(uidText); const gid = Number(gidText);
if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 0 || gid < 0) throw new Error('invalid scratch identity');
const names = ['tmp', ...scratchSubpaths(paths)];
for (const name of names) { const marker = `/tmp/${name}/.yoloharness-selected-uid-probe`; await writeFile(marker, 'ok', { flag: 'wx', mode: 0o600 }); const info = await stat(marker); const content = await readFile(marker, 'utf8'); if (info.uid !== uid || info.gid !== gid || content !== 'ok') throw new Error(`scratch selected-UID verification failed: ${name}`); await unlink(marker); }
process.stdout.write(`${JSON.stringify({ version: 1, uid, gid, paths: names, writable: true })}\n`);