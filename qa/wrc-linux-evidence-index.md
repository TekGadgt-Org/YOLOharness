# Fresh Linux WRC evidence index

Candidate source checkout: source candidate `daa9f90a9a8969c504aee1f64833df7926ec4c6c`; this evidence-only update is captured after that frozen candidate.
Runtime source digest: `sha256:5a9eaf94b2012bdb48251774dcb3397828261b5768ac8879ce778614f26b7a8e`
Production image: `yoloharness-local:0.1.0`
Production image ID: `sha256:7c881f86ae5cb83d2700128381e7d75a028170bf862858792f3959a573221e2d`
Host: Linux `6.8.0-138-generic x86_64`, Node `v22.23.2`
Daemon: rootless Docker `29.8.0`, context `rootless`, cgroup v2, security options `seccomp/profile=builtin`, `rootless`, `cgroupns`

Fresh retained commands and results:

- `npm test`: exit 0; 88 passed, 0 failed, 9 skipped, 97 total.
- `node --check test/real-docker.test.mjs`: exit 0.
- `YOLO_REAL_DOCKER=1 YOLO_WRC08_ONLY=1 YOLO_EVIDENCE_DIR=qa/wrc-baseline-raw node --test --test-name-pattern='shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network' test/real-docker.test.mjs`: exit 0; the named `WRC-08 shipped CLI rejects a hardlink alias before model execution` subtest and its same-runtime single-link control passed. Exact command, stdout, stderr, exit status, and fixture/sentinel manifests are retained as `wrc-08-focused.*`, `wrc-08-negative.*`, and `wrc-08-control.*`.
- `sh qa/capture-wrc-baseline.sh`: exit 0. Raw command/stdout/stderr/status files are under `qa/wrc-baseline-raw/`; the capture includes the full npm suite, real-Docker gate, shipped preflight, daemon/image inspection, and exact owned-resource before/after inventories.
- `git diff --check`: exit 0.

Current row index (the status is intentionally not a waiver):

| Row | Exact retained boundary/test | Current result |
|---|---|---|
| WRC-01 | `shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network` | PASS, synthetic internal provider and whole-runtime tool roundtrip |
| WRC-02 | Same shipped subprocess plus fixed Docker argv and test-only host trace | PASS scoped: provider-only hostile SSE payload is retained separately from the request; child/filesystem trace records launcher operations, Docker argv excludes both input and emitted model-derived values, and host canary is unchanged |
| WRC-03 | `test/shipped-preflight.test.mjs`: four named OS-subprocess controls | PASS |
| WRC-04 | Same shipped subprocess, daemon `runtime-inspect.stdout` and `boundary-probe` | PASS scoped: one `/workspace` bind, mount exclusions, and generated in-container absence probes for host home/proc/device/socket targets pass |
| WRC-05 | Named shipped `boundary-probe` absolute/parent and `/workspace` write/read/delete control | PASS for retained Linux bind boundary: absolute host-path and `/workspace/../` read/write attempts fail, outside sentinel remains unchanged, and workspace artifact write/read/delete succeeds |
| WRC-06 | Named shipped `boundary-probe` known container target and outside-path control | PASS for retained Linux namespace boundary: the project symlink to Docker-managed `/etc/hosts` resolves read-only, while outside host paths remain absent |
| WRC-07 | Shipped newline-cwd negative and mountinfo escaped-newline regression | RESIDUAL: these are not a nested-bind fixture; exact safe nested-bind denial/non-recursive evidence remains unavailable in this environment |
| WRC-08 | Named nested shipped CLI hardlink negative/control in `test/real-docker.test.mjs` | PASS: exit 1 before provider/model execution, outside sentinel unchanged byte-for-byte (25 bytes, matching SHA-256 before/after), no new provider request; same-runtime ordinary single-link control completes. Fixture layout and sentinel/link-count before/after evidence are retained in `qa/wrc-baseline-raw/wrc-08-{negative,control}.fixture.json`. |
| WRC-09 | Shipped warning/readability provider control | PASS scoped, synthetic project secrets intentionally exposed |
| WRC-10 | Shipped create flags/runtime inspection plus `resource-probe` read-only-root/tmpfs/project control | PASS scoped: approved rootless UID0 mapping, read-only root, bounded tmpfs, one project bind, and daemon-observed shipped flags are retained |
| WRC-11 | Shipped generated PID/memory pressure negatives and below-limit controls plus runtime inspection | PASS scoped: shipped PID child-fork denial records the configured 128 limit, shipped 700 MiB pressure records child status 137 and `memory.events` `oom_kill 1`, below-limit shipped controls survive, and runtime inspection verifies Seccomp 2/NoNewPrivs 1 |
| WRC-12 | Shipped deadline marker/no-late-write control | PASS scoped |
| WRC-13 | Shipped SIGINT after started marker and daemon-confirmed runtime presence, plus same-command no-SIGINT control | PASS scoped: SIGINT returns 130 with no late write and exact cleanup; no-SIGINT control reaches delayed completion marker |
| WRC-14 | Shipped independent stdout/stderr overflow and below-limit controls | PASS scoped |
| WRC-15 | Hostile metadata plus proxy/cloud/SSH/npm/selector environment and runtime inspect controls | PASS scoped: prohibited inherited classes are absent and the explicit allowlist control reaches the runtime |
| WRC-16A | Shipped access-only bootstrap and one-401 `reauth_required` control | PASS scoped; same-container access-token exposure is documented residual risk |
| WRC-17 | Existing synthetic host refresh rotation/event-log tests | PASS offline synthetic |
| WRC-18 | `WRC-18 shipped setup uses only the package/src build context and emits secret-free layers` | PASS scoped: actual shipped setup subprocess context and run-owned image history/export scan pass; raw `wrc-18-setup.*` retained |
| WRC-19 | Named shipped `nested-docker-probe` Docker/Podman/socket negatives and shell declared-tool control | PASS scoped: generated Docker/Podman CLI and socket attempts fail closed; `sh` control succeeds; exhaustive executable inventory remains bounded |
| WRC-20 | This index plus raw daemon/image/source/row evidence | PARTIAL: exact current identities and applicable shipped results are linked; WRC-07 remains environment-bounded and WRC-21 deferred, so no whole-matrix release approval is claimed |
| WRC-21 | Native macOS Docker Desktop gate | DEFERRED by approved Linux-only milestone; no Linux substitution claimed |

Historical snapshots remain in `qa/wrc-finding-test-inventory.md`, `qa/cli-verification-report.md`, and `qa/run-117-docker-policy-diagnostic.md`; they are not current evidence. WRC-02 raw evidence is `wrc-02-provider-payload.txt`, `wrc-02-host-trace.jsonl`, `wrc-02-command`, and `wrc-02-status`; the payload is provider-emitted SSE data, not the request body. No real credentials, live provider request, host trust change, privilege escalation, or unowned resource deletion was used. Post-run owned container and network inventories are empty in the retained raw capture; pre-existing daemon resources are preserved.
