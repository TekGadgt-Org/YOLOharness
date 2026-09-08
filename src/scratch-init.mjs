#!/usr/bin/env node
import { chown, chmod, stat } from 'node:fs/promises';

const [uidText, gidText] = process.argv.slice(2);
const uid = Number(uidText); const gid = Number(gidText);
if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 0) throw new Error('invalid scratch identity');
await chmod('/tmp', 0o755);
await chown('/tmp', uid, gid);
const info = await stat('/tmp');
if (info.uid !== uid || info.gid !== gid || (info.mode & 0o777) !== 0o755) throw new Error('scratch ownership verification failed');
process.stdout.write(`${JSON.stringify({ version: 1, uid, gid, mode: info.mode & 0o777, ownership: true })}\n`);
