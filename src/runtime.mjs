import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventLog } from './events.mjs';

export class MissingProviderError extends Error { constructor() { super('No provider is configured; use --fixture for deterministic offline execution'); this.name = 'MissingProviderError'; } }
export const EXEC_TOOL = Object.freeze({ type: 'function', name: 'exec', description: 'Run one command in the isolated worker.', parameters: Object.freeze({ type: 'object', additionalProperties: false, required: ['command', 'args'], properties: { command: { type: 'string', minLength: 1, maxLength: 256 }, args: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 4096 } } } }) });

function normalizeCall(call) {
  if (!call || call.name !== 'exec') throw new TypeError('only the declared exec tool is permitted');
  let value = call.arguments;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw new TypeError('exec arguments must be valid JSON'); } }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['command', 'args'].includes(key)) || typeof value.command !== 'string' || !value.command || value.command.length > 256 || !Array.isArray(value.args) || value.args.length > 64 || value.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw new TypeError('invalid exec arguments');
  if (value.command.includes('\0')) throw new TypeError('invalid exec command');
  return { command: value.command, args: [...value.args], call_id: typeof call.call_id === 'string' ? call.call_id.slice(0, 128) : undefined };
}

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
  const parentAbort = () => abort(signal.reason ?? new Error('interrupted'));
  signal?.addEventListener('abort', parentAbort, { once: true });
  return { signal: controller.signal, cancel: () => { clearTimeout(timer); signal?.removeEventListener('abort', parentAbort); } };
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export async function runOnce({ prompt, minutes = 10, workspace = process.cwd(), provider, executor, tools = [], maxSteps = 100, signal = new AbortController().signal }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('prompt must be non-empty');
  if (!(Number.isFinite(minutes) && minutes > 0)) throw new TypeError('minutes must be positive and finite');
  if (!provider) throw new MissingProviderError();
  if (signal.aborted) return { version: 1, run_id: null, status: 'interrupted', result: null, evidence: [], artifacts: [], errors: ['interrupted before start'] };
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
      const response = await abortable(provider.next({ messages, tools, signal: timer.signal }), timer.signal);
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
        if (tools.length !== 1 || tools[0]?.name !== 'exec' || JSON.stringify(tools[0]?.parameters) !== JSON.stringify(EXEC_TOOL.parameters)) { errors.push('effect denied: executor registry mismatch'); status = 'failed'; break; }
        let call; try { call = normalizeCall(safe.tool_call); } catch (error) { errors.push(`effect denied: ${error.message}`); status = 'failed'; break; }
        const receipt = await abortable(executor.execute({ call, signal: timer.signal }), timer.signal);
        evidence.push(receipt);
        messages.push({ type: 'function_call', call_id: call.call_id, name: 'exec', arguments: JSON.stringify({ command: call.command, args: call.args }) });
        messages.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(receipt) });
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
  return { version: 1, run_id: runId, status, result: result ?? null, evidence, artifacts, errors };
}
