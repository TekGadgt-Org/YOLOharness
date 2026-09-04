# YOLOharness: minimal event and policy kernel

A dependency-free Node ESM spike for a bounded agent run. It is intentionally local and small: events are append-only JSONL, execution is bounded by a step budget, and capabilities default to deny.

## Run it

Requires Node 20+ (tested with Node 22).

```sh
npm test
npm run demo -- /tmp/yoloharness-events.jsonl
```

The demo uses `FixtureAdapter`, a deterministic fixture only. It does not execute a live model, shell command, network request, OAuth flow, or external side effect.

## Kernel guarantees

- Every event includes `run_id`, monotonic per-run `seq`, `type`, and `payload`.
- With the cooperative fixture adapter and valid initial state, `run()` stops after `maxSteps`. This is not an enforcement boundary against arbitrary adapter code (see limitations).
- `recoverState()` replays the JSONL event stream for a run and reconstructs its latest state.
- `authorizeEffect()` denies unknown, shell, and network effects. Workspace-scoped file writes are the only represented capability, and path traversal is rejected.
- No approval logic relies on shell-string heuristics: there is no shell executor in this prototype.

## Provider boundary

The adapter contract is `next(state) -> { action, done }`. A production adapter should sit behind this boundary and handle provider-specific authentication and error semantics. The planned integration is the official Codex CLI/app-server interface; this spike does not guess its protocol, read tokens, or make provider calls.

## Deliberate limitations

This is not a production security boundary or durable database. JSONL appends are local and lack locking, compaction, encryption, multi-process recovery, quotas, retries, or tamper evidence. File authorization is lexical policy only: it does not resolve symlinks or protect against filesystem races, and this prototype does not perform file writes. The adapter is untrusted application code and may mutate shared state or hang; no provider controls are implemented here. There is no shell execution, OAuth, network access, memory evidence store, scheduler, or deployment configuration.
