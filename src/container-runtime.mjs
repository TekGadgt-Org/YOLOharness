#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { decodeBootstrap } from './bootstrap.mjs';
import { ConfiguredProvider } from './provider.mjs';
import { runOnce, EXEC_TOOL } from './runtime.mjs';
import { ContainerProcessExecutor } from './container-executor.mjs';

const MAX_INPUT = 128 * 1024;
const RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  if (input.length > MAX_INPUT) throw new Error('bootstrap too large');
}
let record;
try {
  const boot = decodeBootstrap(input);
  if (boot.expiresAt <= boot.deadline) throw new Error('access token does not cover run deadline');
  const provider = new ConfiguredProvider({ credentials: { accessToken: boot.accessToken, expiresAt: boot.expiresAt }, url: RESPONSES_ENDPOINT, model: boot.model });
  const remaining = Math.max(1, (boot.deadline - Date.now()) / 60000);
  const executor = new ContainerProcessExecutor({ timeoutMs: Math.max(1_000, boot.deadline - Date.now()) });
  record = await runOnce({ prompt: boot.prompt, minutes: remaining, workspace: '/workspace', provider, executor, tools: [EXEC_TOOL], maxSteps: 100 });
} catch (error) {
  const message = error?.code === 'reauth_required' ? 'reauth_required' : (error?.message ?? String(error));
  record = { version: 1, run_id: null, status: 'failed', result: null, evidence: [], artifacts: [], errors: [message] };
}
process.stdout.write(`${JSON.stringify(record)}\n`);