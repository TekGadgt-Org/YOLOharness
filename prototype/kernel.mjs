import { appendFile, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';

/** Append-only JSONL event sink. A run's sequence starts at 1. */
export class EventLog {
  constructor(path) {
    this.path = path;
    this.nextSeq = new Map();
  }

  async append(runId, type, payload = {}) {
    let seq = this.nextSeq.get(runId);
    if (seq === undefined) {
      const text = await readFile(this.path, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      seq = text.split('\n').filter(Boolean).reduce((highest, line) => {
        const event = JSON.parse(line);
        return event.run_id === runId ? Math.max(highest, event.seq) : highest;
      }, 0);
    }
    seq += 1;
    this.nextSeq.set(runId, seq);
    const event = { run_id: runId, seq, type, payload };
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }
}

/** Default-deny capability policy. No commands are parsed or executed here. */
export function authorizeEffect(effect, options = {}) {
  const type = effect?.type;
  if (type === 'file.write') {
    if (!options.workspaceRoot || typeof effect.path !== 'string') {
      return { allowed: false, reason: 'workspace root and file path are required' };
    }
    const root = resolve(options.workspaceRoot);
    const target = resolve(root, effect.path);
    const pathFromRoot = relative(root, target);
    const inside = pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
    return inside
      ? { allowed: true, capability: 'workspace.file.write' }
      : { allowed: false, reason: 'file path is outside workspace' };
  }
  return { allowed: false, reason: 'external side effects are denied by default' };
}

/** Deterministic fixture only; this is not live model execution. */
export class FixtureAdapter {
  async next(state) {
    return { action: `fixture:step-${state.steps + 1}`, done: false };
  }
}

export async function run({ runId, log, adapter, maxSteps = 10, initialState = {} }) {
  if (!runId || !log || !adapter || !Number.isInteger(maxSteps) || maxSteps < 0) {
    throw new TypeError('runId, log, adapter, and a non-negative integer maxSteps are required');
  }
  let state = { status: 'running', steps: 0, ...initialState };
  await log.append(runId, 'run_started', { max_steps: maxSteps });
  while (state.steps < maxSteps) {
    const decision = await adapter.next(state);
    state = { ...state, steps: state.steps + 1, lastAction: decision.action };
    await log.append(runId, 'step', { step: state.steps, action: decision.action });
    if (decision.done) {
      state = { ...state, status: 'completed' };
      await log.append(runId, 'run_completed', { steps: state.steps });
      return state;
    }
  }
  state = { ...state, status: 'budget_exhausted' };
  await log.append(runId, 'run_stopped', { reason: 'step_budget', steps: state.steps });
  return state;
}

export async function recoverState(path, runId) {
  const text = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  let state = { status: 'unknown', steps: 0, seq: 0 };
  for (const line of text.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.run_id !== runId) continue;
    state.seq = event.seq;
    if (event.type === 'run_started') state.status = 'running';
    if (event.type === 'step') {
      state.steps = event.payload.step;
      state.lastAction = event.payload.action;
    }
    if (event.type === 'run_completed') state.status = 'completed';
    if (event.type === 'run_stopped') state.status = 'budget_exhausted';
  }
  return state;
}
