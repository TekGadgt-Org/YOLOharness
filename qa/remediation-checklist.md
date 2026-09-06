# Phase 1 finding reconciliation and remediation checklist

Status: remediation in progress on 2026-09-06 UTC; the current feature head includes retained lifecycle evidence, exact-owned test cleanup, and the workspace symlink correction below. Current evidence chain is frozen source candidate `86af2dbb4364a3f7` followed by evidence-only commits `dec3425`, `a3b5b08`, `e9b9d75`, and `de3dde7`.
Scope: current shipped CLI, Linux rootless Docker evidence, synthetic credentials/provider only. This checklist is a ledger, not release approval. It preserves the historical reports and records every original finding, its WRC mapping, current classification, evidence, and the exact shipped-path checks required for any remaining actionable work.

## Evidence and execution context

Working directory for all commands unless noted: `/opt/hermes/workspace/YOLOharness/.worktrees/phase1`.

Environment control:

    $ node --version && uname -srm
    v22.23.2
    Linux 6.8.0-138-generic x86_64
    exit_code=0

Current regression command:

    $ npm test
    1..91
    # tests 97
    # pass 88
    # fail 0
    # cancelled 0
    # skipped 9
    exit_code=0

Current shipped rootless gate:

    $ YOLO_EVIDENCE_DIR=qa/wrc-baseline-raw YOLO_REAL_DOCKER=1 node --test test/real-docker.test.mjs
    1..2
    # tests 3
    # pass 3
    # fail 0
    # cancelled 0
    # skipped 0
    exit_code=0

The complete real-Docker build output, command, stderr, status, timestamps, image inventories, daemon inspection, and row-specific WRC-05/06, WRC-08, WRC-10/11, WRC-18, and WRC-19 stdout/stderr/status artifacts are retained under `qa/wrc-baseline-raw/`; summarized evidence is `qa/real-docker-evidence.md`. `git diff --check` exits 0. The pre-existing untracked `qa/run-117-docker-policy-diagnostic.md` is preserved and is not treated as a product finding.

## Finding-by-finding reconciliation

| Finding | WRC mapping | Classification | Disposition and evidence | Targeted shipped-CLI test required after any correction |
|---|---|---|---|---|
| BUG-1: reopening a multi-line JSONL event log failed with `Unexpected non-whitespace character after JSON` | WRC-17 (durable event/auth state boundary); historical spike, not a whole-runtime container control | Already corrected | `test/runtime.test.mjs`: `reopened event log continues each run after a multi-line log` passes. Historical failure remains in `qa/qa-report.md`; `qa/final-verification.md` records the post-repair append sequence 3 result. | `npm test`; additionally run `node --test test/runtime.test.mjs` from a disposable cwd and verify the multi-line reopen test and fresh-log positive control. |
| BUG-2: `authorizeEffect({type:'file.write', path:'..'})` was allowed | WRC-05 (workspace escape controls) | Already corrected | `test/runtime.test.mjs`: `policy rejects parent and root-relative paths outside the workspace` passes; nested in-workspace and absolute `/etc/passwd` controls remain in `policy permits workspace-scoped file writes only`. Post-repair output is in `qa/final-verification.md`. | `npm test`; `node --test test/runtime.test.mjs`; shipped CLI probe from a disposable cwd must reject `..`, root-relative, and absolute paths while allowing a nested file. |
| S3-01: complete shipped-CLI matrix absent | WRC-03..20, excluding inapplicable WRC-16B; WRC-21 is separate platform gate | Closed for finite applicable Linux scope | Current evidence closes the applicable shipped rows; WRC-07 is explicitly environment-bounded and WRC-21 is explicitly deferred. The full rootless gate and focused WRC-11/WRC-18 evidence are retained; this is not whole-matrix release approval. | `YOLO_EVIDENCE_DIR=qa/wrc-baseline-raw YOLO_REAL_DOCKER=1 node --test test/real-docker.test.mjs` plus the exact focused test name. Do not substitute imported-module or raw-Docker-only checks. |
| S3-02: hostile XDG/substituted image could influence image authority/credential path | WRC-03, WRC-10, WRC-15, WRC-18, WRC-20 | Already corrected within Linux synthetic scope | `test/real-docker.test.mjs` shipped subprocess rejects an untagged hostile-XDG derivative before missing credentials are read; tagged installation-owned image is the positive control. Source-label and immutable-ID checks are in `src/container-launcher.mjs`/`src/cli.mjs`. Evidence: `qa/real-docker-evidence.md` lines 29-32; raw `real-docker.*`, `image-inspect.*`. Residual trusted-daemon/host compromise boundary is outside this task, not an unrecorded pass. | `shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network`; `configured image rejects an image whose embedded source digest is stale`; run the real-Docker gate with hostile metadata and tagged positive control. |
| S3-03: escaped-newline nested mount target bypassed comparison | WRC-07 | Already corrected; shipped control passes | `test/container-launcher.test.mjs`: `mountinfo decoding preserves escaped newline targets for nested-mount checks`; shipped newline-cwd negative rejects before Docker parsing and ordinary cwd positive completes. Evidence: `qa/real-docker-evidence.md` line 32 and raw shipped evidence. | Run the named mountinfo test and the shipped real-Docker newline-cwd negative/control in `test/real-docker.test.mjs`. |
| S3-04: inherited Docker selection variables could alter test/runtime authority | WRC-01, WRC-15, WRC-20 | Already corrected within synthetic gate scope | The shipped child receives a test-owned empty Docker config and verified endpoint while clearing competing selectors; production preserves the invoker's normal context semantics. `test/real-docker.test.mjs` asserts argv/env and `runtime-inspect.stdout` asserts no Docker/token selector variables. Evidence: `qa/run-117-docker-policy-diagnostic.md` (normal-context distinction), `qa/real-docker-evidence.md` lines 25-36. | `shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network`; `ordinary runtime ignores inherited image and test-control environment`; rerun with the hostile selector fixture and valid-context positive control. |
| OLD-03: prefix/unknown-create ownership could kill or remove a foreign resource | WRC-02, WRC-12, WRC-13, WRC-14, WRC-20 | Already corrected at product/unit and synthetic shipped-control scope | IDs require exactly 64 hex characters; reconciliation re-inspects exact generated name and `yoloharness.run` label before kill/rm. `test/container-launcher.test.mjs`: `launcher rejects a Docker create ID that is not the exact owned name and label`, delayed appearance, stable absence, cancellation, timeout, stdout/stderr overflow, and nonzero-create controls pass. The foreign fixture is a valid 64-hex ID. Full real daemon lifecycle rows remain S3-01 residual, not silently passed. | Run `node --test test/container-launcher.test.mjs`; then the shipped real-Docker gate and exact-owned before/after inventory checks. |
| OLD-04: shipped fixture/command injection or host model execution | WRC-02, WRC-03, WRC-15, WRC-20 | Already corrected | Shipped parser rejects `--fixture` (`unknown option`, exit 1); no `YOLO_DOCKER_COMMAND` path exists. Current source uses portable `fs.constants.X_OK`; raw shipped negative/control evidence was refreshed under Node 22 in `qa/wrc-baseline-raw/shipped-fixture.*` and `shipped-empty.*`. | `node --test test/integration.test.mjs`; execute `node src/cli.mjs --fixture` from an isolated disposable cwd and assert nonzero/unknown option; run the ordinary shipped positive control. |
| OLD-05: stable absence/deadline/overflow and late-write behavior not proven through shipped daemon | WRC-12, WRC-13, WRC-14, WRC-20 | Corrected within Linux synthetic shipped scope; historical cause remains unproven | The original t_1c7164d2 failure is retained with its observed candidate/image/runtime phase; exact source commit is irrecoverable. Later `04daa58` and the deterministic delayed-create regression verify the current cleanup guarantee only and do not establish historical causality. Current started-marker deadline/SIGINT/no-SIGINT/overflow controls pass with stable exact absence. Evidence: `qa/wrc-baseline-raw/real-docker.*`, `qa/phase1-acceptance-matrix.md`. | `sh qa/capture-wrc-baseline.sh` (which runs `npm run test:docker`) from the repository checkout; retain raw stdout/stderr/status and exact-owned before/after inventories. |
| R121-01: Node 24 shipped import failure caused raw negatives to fail for the wrong reason | shipped CLI availability; affects WRC-03, WRC-15, WRC-20 evidence validity | Already corrected on available runtime; Node 24 environmental gap | `src/cli.mjs` now uses portable `fs.constants.X_OK`. Node 22 shipped CLI negatives and `npm test` pass. Node 24 is not installed in this environment, so no Node 24 claim is made. | Run `node --check src/cli.mjs`; `npm test`; execute shipped negative/control under Node 24 when that runtime is available and record its exact version/output. |

## WRC row closure checklist

The following is the non-duplicated current row disposition. “Partial/unrun” is intentionally preserved only for explicitly bounded or deferred rows; it is not a waiver.

- WRC-01: PASS scoped shipped derivative/provider network; retain synthetic-only boundary.
- WRC-02: PASS scoped. The synthetic provider emits a provider-only unique shell-metacharacter/host-looking SSE payload; `wrc-02-provider-payload.txt` retains that emitted data separately from the request, while `wrc-02-host-trace.jsonl` records fixed launcher child/filesystem calls and Docker argv excludes both input and emitted model-derived values. The unique host canary is unchanged. The trace is explicitly test-only instrumentation, not kernel-wide tracing.
- WRC-03: PASS scoped shipped preflight. `test/shipped-preflight.test.mjs` invokes the actual CLI subprocess from disposable cwd fixtures and passes unavailable-client, unavailable-daemon, absent-image, and valid preflight controls; raw command/output/status are retained under `qa/wrc-baseline-raw/shipped-preflight.*`. The daemon case uses only a test-owned synthetic credential file to reach `docker info`, and no container/runtime handoff occurs.
- WRC-04: PASS scoped shipped daemon inspection and generated in-container absence probes: exactly one `/workspace` bind, no host home/proc/device/socket targets, and the workspace positive control pass; exhaustive host namespace claims are excluded.
- WRC-05: PASS for the shipped launcher boundary: parent/root-relative policy negatives and outside-resolving symlink negatives now fail closed; nested in-workspace positive controls pass. A broader final-image sentinel probe remains bounded by the Linux bind namespace.
- WRC-06: PASS for the shipped launcher boundary: outside-resolving symlink negatives now fail closed, the shipped `/etc/hosts` Docker-managed container-target positive control reaches launch, and an in-workspace symlink positive control passes. A broader final-image namespace probe remains bounded by the Linux bind namespace.
- WRC-07: ENVIRONMENT-BOUNDED safe fixture disposition. The retained unshare setup records `uid_map` `Operation not permitted` with exact safe argv/environment/phase/output; ordinary nested-directory control succeeds. This is not launcher nested-bind PASS.
- WRC-08: PASS shipped CLI negative/control. The named nested subtest `WRC-08 shipped CLI rejects a hardlink alias before model execution` creates a test-owned outside sentinel and hardlink alias, invokes `src/cli.mjs` as an OS subprocess from the disposable workspace, observes exit 1 with `workspace contains a multiply-linked file`, verifies the outside sentinel is unchanged and provider request count is unchanged, then removes the alias and runs a same-runtime ordinary single-link positive control to completion. The unit rejection/control remains retained separately.
- WRC-09: PASS scoped shipped synthetic `.env`/key/token warning/readability control; the provider tool reads only test-owned project fixtures through `/workspace`, and the CLI emits the intentional-exposure warning.
- WRC-10: PASS scoped shipped rootless read-only-root/write-delete canary and daemon-observed runtime row; approved 0:0 mapping is explicit and no nonzero-UID claim is made.
- WRC-11: PASS scoped. The shipped concurrent PID negative records the configured 128 limit and `Cannot fork`; bounded 700 MiB heap pressure records child status 137 and `memory.events` `oom_kill 1`; below-limit shipped controls survive; the shipped resource probe verifies Seccomp 2 and NoNewPrivs 1 alongside daemon limits. The negative/control raw artifacts remain separate.
- WRC-12: PASS scoped shipped Linux synthetic provider: deadline/exact absence/no-late-write gate synchronizes on a started marker and retains raw evidence; finite applicable WRC-20 aggregation is complete.
- WRC-13: PASS scoped shipped Linux synthetic provider: OS SIGINT after started marker returns 130, delayed write is absent, exact owned runtime name is absent, and the same command without SIGINT reaches its delayed completion marker.
- WRC-14: PASS scoped shipped Linux synthetic provider: stdout-only and stderr-only overflow return bounded exit 124 with exact cleanup; short-delay controls succeed.
- WRC-15: PASS scoped hostile environment/provenance controls; full daemon env inspection is retained but broader matrix completion remains.
- WRC-16A: PASS scoped shipped same-container access-token handoff/401 fail-closed control; the provider capture asserts `Authorization: Bearer` and exactly one 401 request, while refresh token is absent from runtime argv/env/logs and 401 returns `reauth_required` without in-container refresh. No real credentials.
- WRC-16B: INAPPLICABLE, because the amended contract selects Option A; no relay implementation or test is required.
- WRC-17: PASS offline synthetic auth rotation/persistence and event-log controls; no real credentials.
- WRC-18: PASS scoped shipped setup. The focused OS-subprocess test invokes the actual setup command, captures its package/src-only context, builds a run-owned image, and verifies synthetic secret markers are absent from history/export; broader supply-chain attestations remain bounded.
- WRC-19: PASS scoped runtime env/mount inspection and declared-tool control; exhaustive executable inventory remains bounded.
- WRC-20: COMPLETE for finite applicable Linux aggregation. Current source/image identity, exact-owned cleanup, and applicable shipped probes are reconciled; WRC-07 remains environment-bounded and WRC-21 deferred. This is not whole-matrix release approval.
- WRC-21: DEFERRED by approved Linux-only milestone. This worker reports `Linux 6.8.0-138-generic x86_64`; Ryan will run native macOS Docker Desktop evidence after Linux ships. No macOS command was run, so there is no exit status/output to misrepresent; this deferred platform gate does not block Linux completion.

## Environmental and non-actionable evidence

1. WRC-16B is inapplicable, not blocked: the amended contract explicitly selected Option A/WRC-16A. The evidence and rationale are recorded in `qa/phase1-acceptance-matrix.md:21-27` and `qa/wrc-finding-test-inventory.md:26-27`.
2. WRC-21 is deferred under the approved Linux-only milestone. Reproducible host probe: `node --version && uname -srm` returned `v22.23.2` and `Linux 6.8.0-138-generic x86_64`, exit 0. Running a macOS Docker Desktop command here would be fabricated evidence; Ryan will provide the native macOS gate after Linux ships.
3. The Docker policy diagnostic is environmental evidence only. Its exact independent reproducer was rejected before execution with exit code `-1`, status `blocked`, and message `BLOCKED: Command flagged as dangerous (docker/podman daemon redirect via environment (DOCKER_HOST/CONTAINER_HOST)) but single-query mode (-q) runs without a user present to approve it.` The normal-context control `docker context show && docker info --format '{{.ServerVersion}} {{json .SecurityOptions}}'` returned `rootless`, `29.8.0 ["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]`, exit 0. Empty `DOCKER_CONFIG` returned context `default`, then missing `/var/run/docker.sock`, with info exit 1. Full command/output/context is in `qa/run-117-docker-policy-diagnostic.md:17-57`; it is not a product failure and does not waive missing WRC rows.
4. Rootful/Desktop, live OAuth/real credentials, compromised trusted daemon/host/kernel, post-validation TOCTOU, host SIGKILL, SBOM/vulnerability disposition, and repeated offline image reproducibility are contract boundaries documented in the parent evidence. They are not silently classified as corrected and do not duplicate the actionable WRC checklist.

## Release handoff

The residual remediation has changed production code only where a shipped boundary was demonstrably unsafe: workspace symlinks resolving outside the selected project are now rejected before Docker launch, and the CLI emits the required intentional-exposure warning while preserving `reauth_required` error semantics. WRC-03, WRC-09, WRC-16A, and WRC-18 are PASS within their retained Linux synthetic shipped scopes; finite applicable Linux WRC-20 aggregation is complete, while WRC-07 remains environment-bounded and WRC-21 deferred. Raw command/output/status/timestamp capture and exact-owned cleanup evidence are retained; no acceptance waiver or release approval is inferred by this document.
