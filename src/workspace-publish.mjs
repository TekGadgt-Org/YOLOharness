#!/usr/bin/env node
import { publishWorkspace } from './workspace-sync.mjs';
const excluded = process.argv.slice(2);
await publishWorkspace('/tmp/workspace', '/source', excluded, '/tmp/workspace-baseline.json');
process.stdout.write(`${JSON.stringify({ version: 1, published: true })}\n`);
