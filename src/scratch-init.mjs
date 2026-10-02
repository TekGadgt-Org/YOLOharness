#!/usr/bin/env node
import { chown, chmod, stat } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { scratchSubpaths } from './scratch-path.mjs';
const [uidText, gidText, ...paths] = process.argv.slice(2);
const uid = Number(uidText); const gid = Number(gidText);
if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 0 || gid < 0) throw new Error('invalid scratch identity');
const names = ['tmp', ...scratchSubpaths(paths)];
for (const name of names) await mkdir(`/tmp/${name}`, { recursive: true });
for (const name of names) { await chmod(`/tmp/${name}`, 0o755); await chown(`/tmp/${name}`, uid, gid); const info = await stat(`/tmp/${name}`); if (info.uid !== uid || info.gid !== gid || (info.mode & 0o777) !== 0o755) throw new Error(`scratch ownership verification failed: ${name}`); }
process.stdout.write(`${JSON.stringify({ version: 1, uid, gid, paths: names, mode: 0o755, ownership: true })}\n`);