#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { publishWorkspace } from './workspace-sync.mjs';
const excluded = process.argv.slice(2);
async function runtimeReceipt() {
  for (const path of ['/tmp/runtime-receipt.json', '/tmp/tmp/runtime-receipt.json']) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value?.version === 1) return value;
    } catch {}
  }
  return null;
}
try {
  const result = await publishWorkspace('/tmp/workspace', '/source', excluded);
  const runtime = await runtimeReceipt();
  process.stdout.write(`${JSON.stringify(runtime?.version === 1 ? { ...runtime, ...result } : { version: 1, ...result })}\n`);
} catch (error) {
  if (error?.code !== 'publication_incomplete') throw error;
  const runtime = await runtimeReceipt();
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
