YOLOharness maintainability review: smallest useful core

Scope and judgment

This review assumes the proposed constraints are fixed: Node, local-first execution, append-only events, a bounded resumable task loop, an explicit policy boundary, official Codex CLI/app-server for OAuth (no credential extraction), tiered evidence-backed memory, and lazy tools/skills. “Optimal” should mean the smallest layer that measurably improves reliability, resumability, policy enforcement, or evidence quality over using Codex/Hermes directly—not the most featureful framework.

The main maintainability risk is rebuilding an agent runtime beside Codex and Hermes. Every duplicated abstraction becomes a second source of truth for prompts, tool discovery, authentication, retries, cancellation, transcripts, and policy. Keep orchestration-owned state narrow, versioned, and boring. Delegate model interaction, OAuth, tool/skill implementation, and user-facing conventions to the official/runtime owners wherever their contracts suffice.

Ownership boundary

Our thin layer should own:
- task identity, parent/child or attempt identity, deadlines, cancellation, and resume checkpoints;
- the append-only event envelope and durable local event store;
- policy decisions at the boundary before side effects, with an auditable allow/deny result;
- evidence references and memory promotion/demotion rules;
- a small adapter contract for invoking Codex CLI/app-server and translating only the events needed by the loop;
- bounded scheduling: one clear state machine, explicit retry budget, and terminal outcomes.

Codex/Hermes should own:
- model requests, conversation semantics, OAuth/login, token refresh, and credential storage;
- tool and skill implementation, schemas, execution details, and their normal discovery UX;
- protocol evolution, model-specific behavior, and transcript rendering unless a stable machine-readable contract is unavailable.

Do not introduce a generic “provider”, “workflow”, “memory”, or “plugin” framework until two real implementations require the same stable behavior. A single Codex adapter, one event store, and one policy interface are enough initially. Avoid a second prompt/template registry, a shadow tool registry, or an internal credential/session abstraction.

Minimal module map

src/task-runner.ts
  Bounded state machine: load checkpoint, invoke adapter, append events, classify outcome, checkpoint, stop/resume. No policy or storage-specific logic beyond interfaces.

src/codex-adapter.ts
  One official CLI/app-server integration. Converts protocol output into a minimal internal event vocabulary and preserves raw references. No OAuth handling or credential reads.

src/events.ts and src/event-store.ts
  Versioned envelope plus append-only local persistence. Define ordering, idempotency key, fsync/atomic-write behavior, and corruption handling. A file-backed store is preferable to a database until query/concurrency requirements prove otherwise.

src/policy.ts
  Pure decision boundary for proposed side effects (tool, path, network, approval context). It must fail closed on unknown operations and emit the decision as an event; it should not implement tools.

src/evidence.ts and src/memory.ts
  Evidence references, provenance, confidence, freshness, and promotion thresholds. Store summaries/indexes as derived state that can be rebuilt from events; never make an untraceable summary authoritative.

src/tools.ts (only if needed)
  Lazy resolver/registry containing metadata and loading boundaries, not tool implementations. Prefer Codex/Hermes discovery when possible.

src/cli.ts
  Thin commands for run/resume/inspect/replay. No business rules hidden in CLI handlers.

Tests should mirror these boundaries, especially replay and policy decisions. Keep internal types private where possible; expose only the adapter, runner, store, and policy contracts that an actual caller needs.

Build order

1. Write the event envelope, append-only store, replay tool, and crash/corruption semantics. Test restart and duplicate delivery before any model integration.
2. Implement a fake adapter and the bounded runner state machine. Prove deadline, cancellation, retry, checkpoint, and terminal-state behavior deterministically.
3. Add the policy boundary as a pure function plus recorded decisions. Exercise deny-by-default and approval-required cases with no live credentials.
4. Add the single official Codex adapter behind the fake adapter contract. Preserve raw protocol data by reference; test malformed, partial, and unexpected protocol output.
5. Add evidence-backed memory as a derived projection and explicit promotion path. Start with append-only evidence links and a simple local index; defer embeddings, graph structures, and automatic consolidation.
6. Add lazy tool/skill resolution only for a demonstrated startup or footprint problem. Measure before and after; otherwise rely on Codex/Hermes.
7. Add operational inspection (status, replay, explain-policy, resume) and migration tests. Only then consider concurrent workers, alternate providers, or a richer storage engine.

Kill criteria and simplification triggers

Stop or delete a component when any of these holds:
- it duplicates a Codex/Hermes capability without a measured reliability, latency, safety, or evidence benefit;
- it requires reading, transforming, or persisting credentials outside the official OAuth flow;
- its state cannot be reconstructed or explained from the event log;
- it adds an abstraction layer without a second concrete implementation or caller;
- memory suggestions cannot show source evidence, timestamp, and confidence;
- retry/resume behavior is not deterministic under a fake adapter;
- the adapter contract leaks provider-specific types throughout the runner;
- lazy loading costs more complexity than the measured cold-start/footprint win;
- a feature needs an unbounded loop, hidden background worker, or implicit retry to appear useful.

A particularly important kill test: if a thin wrapper around the official Codex interface plus event logging and policy checks achieves the target task success and recovery metrics, do not build an internal agent protocol.

Tests and empirical evaluation

Correctness tests:
- property/invariant tests: event sequence is append-only, IDs are unique/idempotent, replay reaches the same state, and derived memory can be rebuilt;
- crash injection at every write/invocation boundary, followed by resume;
- bounded-loop tests for timeout, cancellation, retry exhaustion, malformed adapter output, and duplicate events;
- policy matrix tests covering unknown tools, path traversal attempts, network/side-effect classes, approval expiry, and fail-closed errors;
- adapter contract tests using recorded fixtures, including partial streams and process exit failures;
- evidence tests rejecting unsupported memory promotion and retaining provenance through updates.

Evaluation harness:
- establish a baseline using Codex/Hermes directly, then compare the thinnest wrapper and each added feature on a fixed task corpus;
- measure task success, policy violations, resume-after-crash success, duplicate side effects, time-to-first-action, cold-start time, memory/tool overhead, operator intervention, and evidence citation coverage;
- run repeated trials with deterministic fake-adapter scenarios plus a smaller live integration sample; report confidence intervals rather than one winning run;
- maintain adversarial cases for prompt/tool confusion, stale memory, partial writes, revoked authorization, and interrupted approval;
- require each feature to have a predeclared metric and removal threshold. If it does not improve a target metric without unacceptable complexity or latency, remove it.

Decision rule

Ship only the smallest measured delta over the existing Codex/Hermes path: event durability, bounded resumability, and policy enforcement are the likely core. Treat memory projections and lazy loading as optional increments, not foundational subsystems. Revisit the module map when a real failure or metric demands it, not when a framework-shaped design feels incomplete.
