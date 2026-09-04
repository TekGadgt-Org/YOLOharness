YOLOharness performance and evaluation plan

Scope and guardrails

This is an evaluation plan, not a claim that the fixture is representative of a live model. The current prototype uses a deterministic FixtureAdapter and performs local JSONL I/O only; it has no model, network, OAuth, shell, tool-schema service, or provider-usage telemetry. Do not infer model latency, token savings, price savings, or user-visible benefit from fixture timings.

User-visible hypotheses

1. Context retrieval/compiler: a bounded, relevant context packet should reduce time to a verified result and unnecessary model/tool work versus an ever-growing or indiscriminate packet, without lowering acceptance or recovery correctness.
2. Stable prompt prefix: keeping the session contract, immutable schemas, and project boundary stable should improve provider cacheability where the provider exposes caching, while preserving correctness when task context changes.
3. Lazy tool schemas: loading only schemas needed for the current task should reduce prompt/input size and context compilation work, without increasing tool-discovery failures, retries, or interventions.
4. Delegation: independent work in isolated workspaces should improve time to verified result only when parallelism resolves real uncertainty; otherwise serial execution should be cheaper and simpler.

Baseline and current measured fixture

Environment: Node v22.23.2, npm 12.0.2, Linux; prototype package requires Node >=20. Commands were run from /opt/hermes/workspace/YOLOharness/prototype with the existing dependency-free package and no services or network calls.

- `npm test`, five consecutive runs: real wall time 0.18, 0.19, 0.19, 0.19, 0.19 s (range 0.18–0.19 s; median 0.19 s). Node's test reporter printed 60.6 ms internal test duration on one run. All 7 tests passed.
- `npm run demo -- /tmp/yoloharness-perf-events-repeat.jsonl`, five consecutive runs: real wall time 0.13, 0.12, 0.12, 0.12, 0.12 s (range 0.12–0.13 s; median 0.12 s). Exit code 0; output reported `fixture_only: true`, three fixture steps, `budget_exhausted`, and replay sequence 5.

These are process-startup plus local filesystem measurements, not a baseline for model response time, token usage, prompt caching, retrieval quality, or parallel execution. The existing QA report records functional defects; performance comparisons must not hide those correctness failures.

Minimal comparable experiments

Use the same repository snapshots, task prompts, acceptance tests, model/account/settings, sandbox and approval policy, context budget, temperature/reasoning settings where exposed, and external-effect restrictions. Randomize or alternate order, warm up separately, run at least 10 repetitions per cell when provider quotas permit, and report median plus p90 and range. Preserve raw traces, event receipts, compiler manifests, and test output with sensitive-data retention limits. Record uncontrolled differences instead of calling the result causal.

A. Context retrieval/compiler

Cells: stock client or current baseline packet; bounded packet with explicit manifest; deliberately overbroad packet control. Task set: bug repair, cross-file feature, interruption/recovery, stale-memory contradiction, malicious README, and conflicting-evidence research. Log packet byte/token estimate, compilation wall time, selected/excluded sources, model input/output usage when exposed, tool calls, retries, interventions, time to first useful output, time to verified result, acceptance pass rate, unsupported completion claims, and forbidden effects. Primary decision: retain bounded retrieval only if verified outcomes do not regress and it improves verified-result time or exposed usage with repeatable variance.

B. Stable prefix/cacheability

Run identical tasks with (i) fixed contract/schemas/project prefix and appended task packet, (ii) semantically equivalent but rewritten full prompt each turn, and (iii) changed schema/prefix control. Record exact prompt hashes/byte lengths, provider cache-hit/read/write fields if available, input tokens, latency, and correctness. Do not call a cache hit or savings unless the official response/trace exposes it. If cache telemetry is unavailable, this experiment can measure prompt construction stability only, not provider cache performance.

C. Lazy schemas

Define a fixed catalog and task-to-tool gold set. Compare all schemas always loaded against task-local schema loading. Measure serialized schema bytes and token estimate, compiler time, first-call latency, tool-selection accuracy, invalid-call rate, retries, and acceptance. Include an adversarial task requiring a tool outside the initial shortlist and a discovery fallback. A smaller prompt is not an improvement if discovery failures erase the gain.

D. Delegation versus serial

Use matched task bundles with known dependency structure: independent files/research questions, a dependency chain, and a shared-hotspot bundle. Compare one serial worker, parallel isolated workers plus one integrator, and parallel workers without integration only as a diagnostic. Keep total model-turn/tool-call and wall-time budgets explicit; charge integrator/review work to the parallel treatment. Measure time to first partial result, time to verified final result, total turns/calls/bytes/usage where exposed, merge conflicts, duplicate work, interventions, recovery correctness, and acceptance. Analyze by task class; do not average away cases where parallelism is inappropriate. Stop parallelism if it does not improve verified outcomes enough to justify coordination and maintenance.

Stock Codex/Hermes comparison

For the provider spike, compare the same replay set in stock Codex, Hermes, and the companion using the same task/workspace/acceptance contract. First prove the official Codex app-server path with an authorized throwaway workspace: hello, one streamed turn, cancellation, approval, resume, and a scoped tool. Run no live experiment until Ryan installs/authorizes the official CLI. Keep authentication and credentials owned by the official client.

The documented Codex app-server boundary may expose streamed events, history, approvals, and authentication integration, but the companion should assume it may not expose hidden context construction, exact system prompt, tokenizer accounting, cache hit/miss telemetry, internal tool-schema loading, model scheduling, or provider monetary cost. Mark each unavailable field as unavailable; do not estimate dollars from an OAuth subscription. If a field cannot be controlled or observed, report the limitation and use outcome metrics rather than claiming a causal mechanism.

Evaluation scorecard and gates

Primary: acceptance-test pass rate; time from task start to verified result; recovery correctness after interruption/compaction. Secondary: model/provider usage and tokens when exposed; context bytes/token estimates; tool calls and retries; interventions; cache telemetry; first useful output; CPU/memory only for the local compiler/runtime; forbidden effects and unsupported completion claims.

Every run should retain a manifest linking sources, revisions, reason selected, trust class, estimate, and exclusions, plus raw event trace and test receipts. Report failures and variance, not a favorite run. Correctness, accessibility, security, and boundary enforcement are release gates, not performance trade-offs. Kill or redirect the design if required controls or context telemetry are unavailable, or if measured verified outcomes/recovery do not improve enough to repay the added maintenance; keep only independently useful memory/evidence components if so.

Limitations of this contribution

No live model, stock Codex session, Hermes session, provider cache, usage API, or real delegation was exercised here. The measured numbers above are reproducible local fixture/process baselines only. Existing prototype QA also identifies correctness defects, so this plan should be applied after those defects are addressed or explicitly excluded from the comparison.
