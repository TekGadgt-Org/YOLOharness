#!/usr/bin/env node
import { readFile, open, mkdir, lstat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { decodeBootstrap } from './bootstrap.mjs';
import { ConfiguredProvider } from './provider.mjs';
import { runOnce, EXEC_TOOL, SKILL_LOAD_TOOL } from './runtime.mjs';
import { ContainerProcessExecutor } from './container-executor.mjs';

const MAX_INPUT = 128 * 1024;
const RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  if (input.length > MAX_INPUT) throw new Error('bootstrap too large');
}
let record;
const controller = new AbortController();
const interrupt = signal => controller.abort(Object.assign(new Error(signal === 'SIGTERM' ? 'container stopped' : 'SIGINT'), { code: signal === 'SIGTERM' ? 'interrupted' : 'interrupted' }));
process.once('SIGTERM', () => interrupt('SIGTERM'));
process.once('SIGINT', () => interrupt('SIGINT'));
try {
  const boot = decodeBootstrap(input);
  if (boot.expiresAt <= boot.deadline) throw new Error('access token does not cover run deadline');
  const provider = new ConfiguredProvider({ credentials: { accessToken: boot.accessToken, expiresAt: boot.expiresAt }, url: RESPONSES_ENDPOINT, model: boot.model });
  const remaining = Math.max(1, (boot.deadline - Date.now()) / 60000);
  const hardDeadlineAt = boot.deadline;
  const reserveMs = Math.min(30_000, Math.max(5_000, Math.floor((hardDeadlineAt - Date.now()) * 0.1)));
  const deadlineAt = hardDeadlineAt - reserveMs;
  const executor = new ContainerProcessExecutor({ timeoutMs: Math.max(1_000, boot.deadline - Date.now()) });
  record = await runOnce({ prompt: boot.prompt, minutes: remaining, deadlineAt, hardDeadlineAt, reserveMs, workspace: '/workspace', provider, executor, tools: [EXEC_TOOL, SKILL_LOAD_TOOL], skills: boot.skills, maxSteps: 100, signal: controller.signal });
} catch (error) {
  const message = error?.code === 'reauth_required' ? 'reauth_required' : (error?.message ?? String(error));
  record = { version: 1, run_id: null, status: controller.signal.aborted ? 'interrupted' : 'failed', effect_state: controller.signal.aborted ? 'uncertain' : 'none', result: error?.partialResult ?? null, evidence: [], artifacts: [], errors: [message] };
}
try {
  const directory = '/workspace/.yolo';
  try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('receipt directory is not a local directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(directory, { mode: 0o700 }); }
  const receipt = join(directory, 'last-receipt.json');
  const fh = await open(receipt, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await fh.writeFile(`${JSON.stringify(record)}\n`); await fh.sync(); } finally { await fh.close(); }
} catch (error) {
  record = { ...record, status: 'publication_incomplete', effect_state: 'uncertain', errors: [...(record.errors ?? []), `receipt persistence failed: ${error.message}`] };
}
process.stdout.write(`${JSON.stringify(record)}\n`);