import { EventLog, FixtureAdapter, run, recoverState } from './kernel.mjs';

const path = process.argv[2] ?? './demo-events.jsonl';
const runId = `demo-${Date.now()}`;
const log = new EventLog(path);
const result = await run({ runId, log, adapter: new FixtureAdapter(), maxSteps: 3 });
const recovered = await recoverState(path, runId);
console.log(JSON.stringify({ fixture_only: true, run_id: runId, result, recovered }, null, 2));
