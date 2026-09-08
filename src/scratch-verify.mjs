#!/usr/bin/env node
import { writeFile, readFile, unlink, stat } from 'node:fs/promises';

const [uidText, gidText] = process.argv.slice(2);
const uid = Number(uidText); const gid = Number(gidText);
if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 0) throw new Error('invalid scratch identity');
const marker = '/tmp/.yoloharness-selected-uid-probe';
await writeFile(marker, 'ok', { flag: 'wx', mode: 0o600 });
const info = await stat(marker);
const content = await readFile(marker, 'utf8');
if (info.uid !== uid || info.gid !== gid || content !== 'ok') throw new Error('scratch selected-UID verification failed');
await unlink(marker);
process.stdout.write(`${JSON.stringify({ version: 1, uid, gid, marker: 'write-read-remove', writable: true, mode: info.mode & 0o777 })}\n`);
