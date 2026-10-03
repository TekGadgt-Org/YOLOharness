# YOLOharness — the harness I would choose

Status: design proposal from a timeboxed multi-profile jam, not a claim of model-optimality or a finished agent. Public sources inform this document; unreleased OpenAI internals are unknown.

## The bet

Give Astra an instrument panel, not an ever-growing instruction wall. Spend context on the current problem; keep the rest addressable, attributable, and recoverable. Make experimentation cheap and outward effects deliberate. **YOLO in the sandbox; receipts at the boundary.**

My preferred harness makes five things unusually good:

1. **Attention:** a small, stable session contract plus a bounded, inspectable context packet for the current task.
2. **Continuity:** structured unfinished obligations and evidence references survive interruption and compaction.
3. **Epistemics:** observed, reported, inferred, and proposed are distinct states, not prose conventions the agent must remember.
4. **Experimentation:** cheap isolated branches with a stopping budget and a concrete question; fan out for uncertainty, not for theater.
5. **Agency with control:** freely explore within preapproved local boundaries; bind approval to the exact outward action and show its evidence.

## What we own, what we borrow

Start as a thin local companion to the official Codex app-server over stdio. It already exposes authentication, history, approvals, and streamed events through a documented product integration boundary. Do not rebuild OAuth, scrape Hermes credentials, invent a private Responses transport, or pretend a Codex subprocess gives us full control over its hidden context construction.

Codex owns its model/tool execution loop and its credentials. YOLOharness owns project/task state, explicit context inputs, memory candidates, evidence indexing, operator views, and budgets between turns. Enforce supported sandbox and approval controls inside Codex as well as any local custom-tool executor: an outer policy wrapper cannot magically police tools executing inside a child runtime. Unsupported controls must be labeled unavailable and fail closed where required.

Hermes supplies the strongest inspiration for persistent skills, memory, broad tools, and durable cross-profile work. OpenClaw supplies useful reference points for gateways, session lanes, cancellation, and writer fencing. Do not rebuild their channel coverage. A Hermes plugin/extension is the principal baseline to beat, not an enemy to replace.

## Core shape (proposed production layout)

```text
CLI / later local read-only inspector
  -> task coordinator + budget + operator decisions
  -> context compiler <-> memory/evidence store
  -> Codex app-server adapter (stdio; official client owns OAuth)
  -> supported Codex approvals/sandbox + scoped custom tools
  -> ordered events -> reducer -> task views / recovery / evidence
```

Six modules, one local process initially: `runtime`, `codex`, `context`, `memory`, `policy`, `cli`. SQLite is the proposed transactional source of truth; JSONL is an export format. Do not turn a flat log into a promise of concurrent/crash-safe durability. No Redis, vector service, always-on browser, message bus, or multi-node scheduler at launch.

### Task and event contracts

Task: `id`, `parent_id`, `goal`, `acceptance`, `workspace`, `status`, `budget`, `next_action`, `evidence_refs`, `pending_effects`, `owner_epoch`.

Task states: `ready`, `running`, `waiting_approval`, `waiting_input`, `completed`, `failed`, `cancelled`. Completion requires acceptance evidence, not a worker's success sentence.

Production event envelope: `version`, `run_id`, `seq`, `event_id`, `at`, `type`, `payload`, `causation_id`. Unique `(run_id, seq)`, a single authorized writer per run, and transactional state transitions. Payloads are bounded and redacted before persistence; full permitted artifacts are referenced rather than repeatedly embedded.

Minimal production events: `run.started`, `turn.requested`, `turn.finished`, `evidence.recorded`, `effect.proposed`, `approval.recorded`, `effect.started`, `effect.finished`, `checkpoint.saved`, `run.stopped`. This vocabulary is a design contract for the production runtime.

Recovery reconstructs recorded state; **replay never executes tools**. A started effect without a terminal receipt is `unknown`, not safe to retry. Reconcile via external readback or ask the operator. Exactly-once external execution cannot be guaranteed by a local log.

### Context as a compiled artifact

Fixed prefix per session: short behavioral contract, immutable core tool schemas, project boundary. Append task context and retrieval results as new content, never silently rewrite historical instructions to update memory.

Every context packet has a manifest: source IDs/revisions, reason selected, trust class, token estimate, and what was excluded. Allocate to goal/acceptance, active code or source evidence, current errors, and pending obligations before historical summaries. Keep room for tool results and the answer. Measure budgets using a supported tokenizer where possible; clearly mark estimates otherwise.

Two operating rhythms:
- **Focus:** one worker, one acceptance target, minimal context; default for straightforward work.
- **Explore:** independent hypotheses in isolated workspaces with explicit question, stop condition, shared budget, and evidence handoff. Enter only when parallelism is expected to resolve uncertainty.

A context checkpoint preserves: exact user constraints, unresolved questions, failed hypotheses, current artifact revisions, outstanding effects/approvals, acceptance criteria, and next discriminating test. Original events remain fetchable. A summary is a lossy index, not replacement authority.

### Memory that can admit it is wrong

Three lanes: short-lived working state, project evidence/decisions, and user-approved durable preferences/procedures. Facts have provenance, verification age, scope, expiry, and supersession links. Conflicting facts coexist visibly until resolved; retrieval is not permission to change policy. No retrieved text becomes a system instruction merely because it was stored yesterday.

Start with SQLite full-text search and exact identifiers. Add embeddings only after measured retrieval misses justify them. Memory promotion is candidate -> checked -> accepted; experiential skills should have an example, an applicability trigger, a failure mode, and a passing evaluation before becoming a default.

Forgetting must cover indexes, derived summaries, cached packets, and retained backups under an explicit retention policy. Append-only audit design must not accidentally make personal content undeletable: store erasable content separately from minimal tombstone/audit metadata.

### Tools and skills

A stable small surface: file read/search/patch, bounded process execution, evidence retrieval, task controls, and a typed tool catalog/call bridge. Internet/browser/network integrations appear only when a task needs them. Tool discovery saves context, but opaque `call(anything)` sacrifices schema clarity; validate exact versioned argument schemas at the bridge and return actionable errors.

Default skill shortlist: repository orientation; test-driven change; systematic debugging/constraint-first problem solving; source-grounded research; independent verification; safe recovery/handoff. No blanket instruction to read dozens of vaguely related skills. Skills are versioned task-local attachments, not silently self-modifying global policy. Installing untrusted skills or MCP servers requires review; tool output cannot authorize installation.

General shell execution is broad authority, not made safe by a denylist. A workspace cwd is not a filesystem sandbox. Until an actual OS boundary exists, report the limitation and restrict executable features accordingly.

### Budgets and operator experience

Budget wall time, model turns, tool calls, output bytes, and provider usage when exposed. OAuth subscription cost is not automatically observable: report unknown monetary cost, not invented dollars. Hard cancellation must propagate to active subprocesses/tools where supported; do not count a stopped UI stream as cancelled execution.

Operator should be able to ask: Why did you remember this? What will run? What did you actually verify? What survived compaction? What is still running? Show concise answers backed by event/artifact IDs.

Proposed UX commands are a design, not shipped commands. The shipped CLI supports only the bounded container path and explicitly configured provider paths.

## Integration constraint check (collaborative-problem-solving)

**Observation:** this environment has Node available; `codex` was not found on PATH during initial inspection. Public app-server docs describe the integration boundary. No OAuth integration was exercised.

**Current understanding:** a thin app-server companion can provide useful continuity without reimplementing provider auth, but may not expose all desired context/token controls.

**Likely constraint:** interface capability and absent official CLI, rather than insufficient agent-loop code.

**Engineering concerns:** preserve credential ownership; avoid implying outer policy controls inner tools; keep evaluation comparable with stock clients.

**Options:** thin Codex companion; Hermes extension; independent provider loop. The first gives a documented OAuth route, the second reuses the most existing workflow, the third creates the largest unsupported integration burden.

**Recommended next step:** after Ryan installs/authorizes the official CLI, exercise its pinned protocol and prove auth, one streamed turn, cancel, approval, resume, and a scoped tool in a throwaway workspace before committing to the companion architecture.

**Verification:** no live integration success is claimed by this jam. Continue only when that experiment returns real evidence.

## Build sequence and gates

1. **Today:** architecture, cited comparisons, threat model, memory contract, UX proposal; exercise a dependency-free fixture kernel. Explicitly not a live agent.
2. **Provider spike:** official Codex installation/auth performed with Ryan's approval; schema/version pin; app-server hello, actual available model selection, streamed response, tool approval, cancellation, and resume. Do not assume a model alias or shared Hermes login will work.
3. **Useful vertical slice:** one local repository task from goal to tested patch, checkpoint/restart included. SQLite transactions, evidence references, and no outward effects. Compare with the same task in stock Codex and Hermes.
4. **Memory/context experiment:** retrieval, expiry, contradiction, compaction, deletion; evaluate poisoned documents and cross-project leakage before automatic promotion.
5. **Scoped parallelism:** isolated worktrees, one integrator, one independent reviewer, shared budgets; only retain if it improves real outcomes.
6. **Human decision:** extend Hermes, keep a thin companion, or stop. No automatic installation, publishing, push, deployment, or full implementation triggered by this plan.

## What would make it actually better?

Use identical model access/settings where exposed, repositories, task acceptance, time budget, and external-effect restrictions. Record differences that cannot be controlled rather than calling the comparison causal.

A small replayable evaluation set: bug repair, cross-file feature, long interruption/recovery, stale-memory contradiction, malicious README, ambiguous external-effect retry, and research with conflicting evidence. Measure acceptance pass rate, time to verified result, tokens/usage when exposed, interventions, recovery correctness, unsupported completion claims, and forbidden effects. Retain raw traces and test receipts with sensitive-data retention limits. Repeat runs; show variance, not only a favorite success.

**Kill criteria:** if the companion cannot enforce required boundaries or access needed context controls, use a Hermes extension; if it does not improve verified task outcomes or recovery enough to justify its maintenance, keep the useful memory/evidence pieces and drop the new harness.

## Public anchors (retrieved during the jam)

- Codex app-server: https://developers.openai.com/codex/app-server — documented auth/history/approval/streaming integration; stdio transport.
- Hermes persistent memory: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/ — bounded curated memory and frozen session snapshot for cache stability.
- OpenClaw agent loop: https://docs.openclaw.ai/concepts/agent-loop — serialized session runs, runtime events, cancellation, writer claims.
