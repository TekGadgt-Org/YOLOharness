#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { publishWorkspace } from './workspace-sync.mjs';
const excluded = process.argv.slice(2);
try {
  const result = await publishWorkspace('/tmp/workspace', '/source', excluded, '/tmp/workspace-baseline.json');
  process.stdout.write(`${JSON.stringify({ version: 1, ...result })}\n`);
} catch (error) {
  if (error?.code !== 'publication_incomplete') throw error;
  let runtime;
  try { runtime = JSON.parse(await readFile('/tmp/runtime-receipt.json', 'utf8')); } catch {}
  const receipt = {
    version: 1,
    status: 'publication_incomplete',
    effect_state: 'uncertain',
    run_id: runtime?.run_id ?? null,
    result: runtime?.result ?? null,
    evidence: Array.isArray(runtime?.evidence) ? runtime.evidence : [],
    artifacts: Array.isArray(runtime?.artifacts) ? runtime.artifacts : [],
    created_entries: Number.isInteger(error.created_entries) ? error.created_entries : 0,
    errors: [...(Array.isArray(runtime?.errors) ? runtime.errors : []), error.message],
  };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
