# Independent shipped-CLI verification report (historical snapshot)

Date: 2026-09-05 UTC; not the current baseline. Current row evidence is in `qa/real-docker-evidence.md` and `qa/wrc-linux-evidence-index.md`.
Workspace: `/opt/hermes/workspace/YOLOharness/.worktrees/phase1`
Host: Linux 6.8.0-138-generic x86_64, kernel 6.8.0-138-generic
Node: v22.23.2
Docker: rootless context, Engine 29.8.0; security options `name=seccomp,profile=builtin`, `name=rootless`, `name=cgroupns`
Image: `yoloharness-local:0.1.0`
Image ID: `sha256:e243d2c9cb9c123478f68a05a29ee0262d4b9593f35237362185c9a5d862dbee`
Source label: `sha256:c5e880a2223fc885df754789235e404da89bf2a383ee5f22fcc30ad8670f3402`

Scope and controls

- All executable checks used the shipped `src/cli.mjs` as an OS subprocess where the matrix requires shipped coverage; no imported-module result was substituted for those rows.
- Fixtures were synthetic and disposable. No live provider, real credentials, host trust changes, privilege changes, or unowned Docker cleanup were used.
- Initial Docker inventory was empty for `label=yoloharness.run` containers and `yoloharness-internal*` networks.
- Final Docker inventory was empty for both selectors after the passing gates.

Commands and results

1. `npm test`
   - Exit 0.
   - 92 tests total: 86 pass, 0 fail, 6 skipped.
2. `node --test test/container-launcher.test.mjs`
   - Exit 0.
   - 17 tests total: 17 pass, 0 fail, 0 skipped.
   - Covers cancellation, delayed create reconciliation, overflow, exact ownership, nested mount/multi-link rejection, escaped-newline decoding, source identity, stale image, and deadline preflight.
3. `YOLO_REAL_DOCKER=1 node --test test/shipped-preflight.test.mjs`
   - Exit 0.
   - 4 tests total: 4 pass, 0 fail, 0 skipped.
   - WRC-03 unavailable executable, unavailable daemon, absent image, and valid preflight control all ran through a spawned shipped CLI with disposable wrapper/credential fixtures.
4. `YOLO_EVIDENCE_DIR=qa/wrc-baseline-raw YOLO_REAL_DOCKER=1 node --test test/real-docker.test.mjs`
   - First independent run: exit 1, test 1 failed at `test/real-docker.test.mjs:177`; `docker ps -aq --filter label=yoloharness.run` observed runtime `yoloharness-771c5a45-60cd-4729-86dc-ba4efb46a379` still present during the deadline cleanup assertion. Test 2 passed.
   - Exact retained run output/status: `qa/wrc-baseline-raw/real-docker.stdout`, `real-docker.stderr`, `real-docker.status` (these raw files were subsequently refreshed by passing runs; the failure is recorded here with command and observed resource ID).
   - The orphan was a test-owned labeled runtime on test-owned network `yoloharness-internal-654100`; it was removed by exact ID/name cleanup, and the network was then absent. No foreign resources matched.
   - Immediate rerun: exit 0, 2 pass, 0 fail, 0 skipped.
5. `npm run test:docker`
   - Exit 0.
   - 2 tests total: 2 pass, 0 fail, 0 skipped.
   - Fresh derivative build, provider network, shipped whole-runtime roundtrip, warning/readability, symlink escape, deadline/no-late-write, SIGINT, stream overflow/control, hostile provenance, newline-cwd rejection, runtime inspection, secret-layer scan, and rootless read-only canary executed by the gate.
   - Final owned-container and `yoloharness-internal*` network inventories were empty.

WRC row-by-row disposition

| Row | Verification result | Evidence / limitation |
|---|---|---|
| WRC-01 | PASS scoped | Passing real-Docker shipped provider roundtrip through immutable image and internal test network. |
| WRC-02 | PASS scoped | Same shipped subprocess plus fixture-option rejection in offline integration; no host shell path observed. |
| WRC-03 | PASS scoped | Four shipped preflight negatives/control; 4/4 pass, no create/start or credential handoff on negatives. |
| WRC-04 | PASS scoped | `qa/wrc-baseline-raw/runtime-inspect.stdout`; exactly one `/workspace` bind and prohibited mounts absent. |
| WRC-05 | PASS scoped | Shipped outside-resolving symlink and path-boundary negatives; in-workspace positive control passes. |
| WRC-06 | PASS scoped | Shipped outside symlink rejection; broader namespace claim remains Linux bind-scoped. |
| WRC-07 | PASS scoped | Shipped newline-cwd rejection and escaped-newline parser regression; unprivileged nested-mount fixture not available. |
| WRC-08 | PASS unit/scoped | 17 launcher tests include multiply-linked-file rejection; no separate real-Docker hardlink shipped row. |
| WRC-09 | PASS scoped | Warning and synthetic `.env`/key/token readability through sole `/workspace` bind; intentional exposure is explicit. |
| WRC-10 | PASS scoped | Rootless UID 0, read-only root, tmpfs and workspace canary pass; full daemon row remains bounded. |
| WRC-11 | PASS scoped | Runtime inspection verifies read-only root, dropped caps, NNP, resource limits and mount/network constraints. |
| WRC-12 | PASS scoped | Deadline returns 124 after started marker; late marker absent and owned runtime cleaned on passing runs. |
| WRC-13 | PASS scoped | SIGINT returns 130 after started marker; late marker absent and exact owned runtime cleaned. |
| WRC-14 | PASS scoped | Independent stdout/stderr overflow each return 124; short controls complete; owned resources cleaned. |
| WRC-15 | PASS scoped | Hostile selector/provenance shipped controls reject derivative and omit selector/token variables from runtime. Full exhaustive daemon env inventory remains bounded. |
| WRC-16A | PASS scoped | Synthetic access-token bootstrap and one 401 map to `reauth_required`; no refresh token in argv/env/logs and no retry/refresh. |
| WRC-16B | N/A | Amended contract selects Option A; no relay resource or invocation is applicable. |
| WRC-17 | PASS offline | Existing auth rotation, atomic persistence, and multi-line event-log reopen tests pass under `npm test`. |
| WRC-18 | HISTORICAL PASS scoped only | Historical derivative build/history/export scan excludes synthetic ignored secrets; it did not exercise shipped `yolo setup`. Current shipped-setup evidence is retained separately under `qa/wrc-baseline-raw/wrc-18-setup.*`. |
| WRC-19 | PASS scoped | Runtime inspection finds no Docker socket/nested daemon exposure; declared provider tool control passes. |
| WRC-20 | HISTORICAL PARTIAL | This historical report predates the reconciled finite applicable Linux aggregation. It remains traceability only; current disposition is recorded in `qa/wrc-linux-evidence-index.md` and is not whole-matrix or release approval. |
| WRC-21 | DEFERRED | Native macOS Docker Desktop evidence cannot be generated on this Linux host. |

Cleanup and failure notes

- Positive passing gates left no containers matching `label=yoloharness.run` and no networks matching `yoloharness-internal*`.
- The first real-Docker attempt exposed an intermittent cleanup timing failure: at the deadline assertion, a test-owned runtime was still listed. A subsequent exact-ID cleanup removed only that owned container; the immediate rerun and `npm run test:docker` both passed with empty final inventories.
- This is not a reproducible acceptance failure across the two subsequent complete gates, but it is a release-confidence residual: the deadline assertion can race the daemon's cleanup. The failing run must not be erased from the QA history merely because the retained raw files were refreshed by later successful runs.
- Historical WRC-20 disposition was PARTIAL; the current finite applicable Linux aggregation is recorded separately as COMPLETE. WRC-21 remains DEFERRED by contract. No release approval is inferred.

Coverage gaps / environmental blockers

- No native macOS Docker Desktop run (WRC-21).
- No unprivileged nested-mount fixture; WRC-07 is scoped to newline rejection/parser coverage.
- No live provider, real OAuth, compromised-daemon/host/kernel, rootful Docker, host SIGKILL, SBOM/vulnerability, or repeated offline reproducibility evidence.
- Node 24 was not installed; this report makes no Node 24 claim.
