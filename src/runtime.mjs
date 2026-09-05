import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventLog } from './events.mjs';

export class MissingProviderError extends Error { constructor() { super('No provider is configured; use --fixture for deterministic offline execution'); this.name = 'MissingProviderError'; } }

/** @typedef {{next(input: {messages: Array, tools: Array, signal: AbortSignal}): Promise<object>}} Provider */
/** @typedef {{execute(input: {call: object, signal: AbortSignal}): Promise<object>}} Executor */

export class FixtureProvider {
  async next({ messages, signal }) {
    if (signal.aborted) throw signal.reason;
    const prompt = messages.at(-1)?.content ?? '';
    return { done: true, result: `fixture response for: ${prompt}` };
  }
}

function deadlineSignal(signal, ms) {
  const controller = new AbortController();
  const abort = reason => { if (!controller.signal.aborted) controller.abort(reason); };
  const timer = setTimeout(() => abort(new Error('deadline exceeded')), ms);
  signal?.addEventListener('abort', () => abort(signal.reason ?? new Error('interrupted')), { once: true });
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export async function runOnce({ prompt, minutes = 10, workspace = process.cwd(), provider, executor, maxSteps = 100, signal = new AbortController().signal }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('prompt must be non-empty');
  if (!(Number.isFinite(minutes) && minutes > 0)) throw new TypeError('minutes must be positive and finite');
  if (!provider) throw new MissingProviderError();
  const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runDir = join(workspace, '.yolo', 'runs', runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const log = new EventLog(join(runDir, 'events.jsonl'));
  const timer = deadlineSignal(signal, minutes * 60_000);
  const messages = [{ role: 'user', content: prompt }];
  const evidence = []; const artifacts = []; const errors = []; let result;
  let status = 'running'; let steps = 0;
  try {
    await log.append(runId, 'run_started', { prompt, max_steps: maxSteps });
    while (steps < maxSteps) {
      if (timer.signal.aborted) { status = signal.aborted ? 'interrupted' : 'deadline'; break; }
      const response = await provider.next({ messages, tools: [], signal: timer.signal });
      steps += 1;
      const safe = response && typeof response === 'object' ? response : { result: String(response) };
      await log.append(runId, 'step', { step: steps, response: safe });
      if (safe.evidence) evidence.push(String(safe.evidence));
      if (safe.artifacts) artifacts.push(...(Array.isArray(safe.artifacts) ? safe.artifacts : [safe.artifacts]));
      if (safe.done || safe.result !== undefined) {
        result = safe.result ?? '';
        evidence.push(`provider response received at step ${steps}`);
        status = 'completed'; break;
      }
      if (safe.tool_call) {
        if (!executor) { errors.push('effect dispatch unavailable: no supported executor selected'); status = 'failed'; break; }
        const receipt = await executor.execute({ call: safe.tool_call, signal: timer.signal });
        evidence.push(receipt);
      }
      messages.push({ role: 'assistant', content: safe.message ?? '' });
    }
    if (status === 'running') status = 'step_limit';
  } catch (error) {
    if (timer.signal.aborted) {
      status = signal.aborted ? 'interrupted' : 'deadline';
      errors.push(status === 'deadline' ? 'deadline exceeded; partial result may be incomplete' : 'interrupted by SIGINT');
    }
    else { status = 'failed'; errors.push(error instanceof Error ? error.message : String(error)); }
  } finally {
    timer.cancel();
    try { await log.append(runId, status === 'completed' ? 'run_completed' : 'run_stopped', { status, steps }); } catch (error) { errors.push(`receipt write failed: ${error.message}`); if (status === 'completed') status = 'failed'; }
  }
  return { run_id: runId, status, result: result ?? null, evidence, artifacts, errors };
}
