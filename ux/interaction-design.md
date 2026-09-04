# YOLOharness operator experience

Status: proposal only. This document describes an intended Astra-local, CLI-first experience; it does not claim these commands or views exist today.

## Product stance

YOLOharness should feel like a small, inspectable local control plane rather than a chat window. The operator can always answer four questions without opening source code:

1. What is running, waiting, blocked, or resumable?
2. What did the kernel actually do, in order?
3. Which evidence supports a memory or result?
4. What will the next action cost and what authority does it require?

`yolo` is the proposed local CLI entry point; Astra is the model, not the executable. All IDs, timestamps, counts, prices, and transcripts shown below are invented UI mock data, not execution evidence. OAuth monetary cost must display `unknown` unless a real metering source supplies it. A Node kernel owns task execution and appends an immutable event log. The terminal is the primary surface; every important state is readable as plain text and addressable by a stable ID.

## CLI shape

The command name below is a proposal. Use IDs in every mutating command so an accidental action cannot target an ambiguous natural-language label.

```text
yolo run "summarize the benchmark results"              # create and start a task
yolo task list                                           # compact queue and state view
yolo task show task_01                                   # transcript, events, evidence, cost
yolo task logs task_01 [--follow] [--json]               # ordered kernel event stream
yolo task pause task_01                                  # cooperative pause at next safe boundary
yolo task cancel task_01 --reason "operator request"     # explicit cancellation
yolo task resume task_01                                 # resume only a resumable task
yolo task retry task_01                                  # create a new attempt, preserving history
yolo evidence list --task task_01                        # inspect cited artifacts and checks
yolo evidence show ev_14                                 # content, source, hash, timestamp
yolo memory list [--status proposed|accepted|rejected]  # evidence-backed memory records
yolo memory show mem_07                                  # claim, provenance, confidence, state
yolo cost show task_01                                  # usage, estimate, limits, attribution
yolo approve list                                        # pending capability requests
yolo approve grant cap_03                                # grant this concrete request once
yolo approve deny cap_03 --reason "not needed"           # deny and record why
yolo auth login codex                                    # hand off to official Codex client OAuth
yolo auth status codex                                   # report authenticated/not authenticated only
yolo doctor                                              # local kernel, store, and client diagnostics
```

Commands that change state print the resolved target and resulting event ID. Destructive or externally visible actions require an explicit confirmation flag in non-interactive use, for example `yolo task cancel task_01 --yes`.

## The default screen: queue plus attention

`yolo task list` is deliberately dense but scannable. It sorts by operator attention, not creation time:

```text
YOLOharness / local Astra                         3 running  1 blocked  2 resumable

ATTENTION
  cap_03  WAITING APPROVAL  task_01  read ./reports/  [approve grant cap_03]
  task_04 PAUSED            "index docs"             [resume]

ACTIVE
  task_01 RUNNING  step 3/6  00:41  ~$0.08  Codex OAuth
  task_02 RUNNING  step 1/4  00:07  ~$0.01  local tools

RECENT
  task_03 SUCCEEDED  2m ago  4 evidence items  $0.11

Last kernel event: evt_8841  2026-09-04T12:20:31Z
```

Rules:

- State is text plus a stable ID; color is supplemental, never the only signal.
- `WAITING APPROVAL`, `PAUSED`, `FAILED`, and `SUCCEEDED` are visible words.
- Estimates use `~` until settled; unknown cost says `unknown`, never `$0`.
- A task's attempt count is shown when retries exist.
- `--json` provides the same fields for scripts; it never hides approval or failure state.

## Task detail and transcript

`yolo task show task_01` opens a read-only, time-ordered detail view with these sections:

1. **Header:** task ID, human label, lifecycle state, attempt, created/updated times, current step, owner (`local`, `Codex`, or a named capability).
2. **Transcript:** user request and model/tool turns. Each turn has an event ID and a collapsed raw payload available via `--json`; rendered output is bounded and indicates truncation.
3. **Kernel timeline:** append-only events such as `task.created`, `step.started`, `tool.called`, `approval.requested`, `evidence.recorded`, `step.failed`, `task.paused`, and `task.resumed`. Each includes timestamp, actor, duration, and outcome.
4. **Evidence:** linked evidence IDs inline in claims, with a separate list of source, locator, content hash, collection time, and verification status.
5. **Cost:** actual-to-date, estimate-to-complete, token/tool breakdown, and configured budget status.
6. **Intervention:** only actions valid for the current state are offered (pause, cancel, resume, retry, approve). The CLI prints why an action is unavailable.

The transcript is not the source of truth for state. The Node kernel event log is. If a process exits mid-step, reopening the task reconstructs the last durable state and marks the in-flight step `interrupted` rather than implying success.

## Resumability and intervention

A pause is cooperative: the kernel finishes the current non-interruptible operation, persists a checkpoint, emits `task.paused`, then releases resources. The command reports `PAUSED at checkpoint cp_12`; it does not claim an instant stop.

Cancel is terminal for that attempt. It records the operator reason, emits `task.cancel_requested` followed by `task.cancelled` (or `task.cancel_failed` if the process cannot be stopped), and preserves the transcript and evidence collected so far. A canceled task is not silently resumable; `retry` creates a new attempt linked to the original.

Resume is available only when a durable checkpoint exists and the task is `PAUSED` or `INTERRUPTED`. The operator sees the checkpoint, the last completed event, and any side effects that may have occurred before choosing resume. Resuming is idempotent by task ID plus checkpoint ID.

## Capability approval prompt

Approval must be bound to a concrete, inspectable action—not a broad capability name or an implicit future grant. Interactive output:

```text
CAPABILITY REQUEST cap_03   task_01   WAITING APPROVAL

Requested action: read files under ./reports/ (non-recursive)
Purpose: extract benchmark result tables for the current task
Actor: Codex attempt 2, step 3
Scope: /work/YOLOharness/reports/*.md and *.json
Network: none       Writes: none       Secrets: not requested
Estimated cost: <$0.01    Expires: after this action or 10 minutes

[a] approve once   [d] deny   [v] view matching paths   [c] cancel task
Choice:
```

The prompt repeats the resolved path and side effects after expansion. Approval is single-use by default, stored as an event with approver, request ID, scope, and expiry. A grant cannot broaden the request after approval; a changed action creates a new request. Non-interactive callers must use `yolo approve grant cap_03`, and the kernel rejects stale, already-consumed, or mismatched requests.

## Codex OAuth boundary

`yolo auth login codex` invokes the official Codex client flow. YOLOharness does not collect, print, persist, refresh, or proxy Codex tokens. The client owns credentials and OAuth lifecycle; the kernel receives only an authenticated-client result and capability/error metadata. `yolo auth status codex` must report status and remediation (for example, “not authenticated; run ...”), never token material or a token-derived identifier.

## Evidence-backed memory

Memory is a reviewable claim, not an invisible assistant preference. A memory record has:

```text
mem_07  PROPOSED  confidence 0.86
Claim: benchmark JSON files use UTF-8 and a stable `results` array.
Evidence: ev_14 (reports/run-12.json, sha256:..., lines 1-48)
Origin: task_01 / attempt 2 / evt_8840
Created: 2026-09-04T12:19:55Z  Expires/review: 30 days
Actions: [accept] [reject] [inspect evidence]
```

Only an explicit acceptance promotes `PROPOSED` to `ACCEPTED`; rejection records a reason. Every accepted claim remains traceable to evidence, can be invalidated, and shows freshness. If evidence is missing, stale, unverifiable, or contradicted, the UI says so and prevents silent promotion. `yolo memory list` supports filtering by status, confidence, freshness, and source task.

## Cost and budget view

`yolo cost show task_01` separates local compute, Codex/model usage, and tools:

```text
Task task_01 / attempt 2
  Actual so far       $0.083
  Estimate remaining  ~$0.021 (range $0.010–$0.047)
  Budget              $0.20  / 41% used
  Breakdown           model $0.071  tools $0.012  local compute not metered
  Largest driver      18,400 input tokens at step 3
```

Estimates carry a timestamp and assumptions. A budget breach pauses before the next billable step and creates an approval request describing the additional amount. Unknown provider pricing is labeled unknown and cannot be presented as a precise total.

## Failure, recovery, and accessibility

All errors name the stable ID, failed operation, durable state, and next safe command. Example: `task_01 FAILED at step 3; evidence preserved; retry with ...`. Crash recovery begins with `yolo doctor` and `yolo task logs --follow`; replay is read-only until the kernel confirms the event store is consistent.

Terminal output uses plain text, predictable headings, and no meaning conveyed by color alone. Prompts are keyboard-first, have one-letter shortcuts plus full command equivalents, preserve focus on the choice, and support screen readers by avoiding animated status-only output. `--no-color`, `--quiet`, and `--json` are first-class options. Long transcript lines wrap without hiding IDs; every interactive action has a deterministic command for automation.

## Open decisions for implementation

- Event-store format and retention/compaction policy.
- Checkpoint contract for each tool class and the definition of a safe boundary.
- Provider pricing source and behavior when pricing is unavailable.
- Whether accepted memories require one operator or a configurable review policy.
- Exact Astra binary/package name and how the official Codex client is discovered on PATH.

These are implementation decisions, intentionally not represented as existing behavior in this proposal.
