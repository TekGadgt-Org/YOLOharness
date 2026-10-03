#!/usr/bin/env node
import { seedWorkspace } from './workspace-sync.mjs';
const [, , uidText, gidText, ...excluded] = process.argv;
const uid = Number(uidText); const gid = Number(gidText);
if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 0 || gid < 0) throw new Error('invalid workspace identity');
await seedWorkspace('/source', '/tmp/workspace', excluded, '/tmp/workspace-baseline.json');
process.stdout.write(`${JSON.stringify({ version: 1, uid, gid, seeded: true })}\n`);
