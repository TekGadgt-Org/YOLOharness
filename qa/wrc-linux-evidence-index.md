# Fresh Linux WRC evidence index

Candidate source commit: `19e738b` (`fix: unblock cleanup when attach pipe stays open`)
Runtime source digest: `sha256:fad13e8ac9129acf775b6f5b11624929872d32108be657312cadf204490ca122`
Production image: `yoloharness-local:0.1.0`
Production image ID: `sha256:7d40fa5f991fc167366b31f082c1a9ee5c2e3ca779f8d69e1a997fcf78f58f08`
Host: Linux `6.8.0-138-generic x86_64`, Node `v22.23.2`
Daemon: rootless Docker `29.8.0`, context `rootless`, cgroup v2, security options `seccomp/profile=builtin`, `rootless`, `cgroupns`

Fresh retained commands and results:

- `npm test`: exit 0; 88 passed, 0 failed, 6 skipped, 94 total.
- `node --check test/real-docker.test.mjs`: exit 0.
- `YOLO_EVIDENCE_DIR=qa/wrc-baseline-raw YOLO_REAL_DOCKER=1 node --test test/real-docker.test.mjs`: exit 0; 3 passed, 0 failed, 0 skipped. The parent test contains the named nested `WRC-08 shipped CLI rejects a hardlink alias before model execution` result and retained row-specific probe artifacts.
- `sh qa/capture-wrc-baseline.sh`: exit 0. Raw command/stdout/stderr/status files are under `qa/wrc-baseline-raw/`; the capture includes the full npm suite, real-Docker gate, shipped preflight, daemon/image inspection, and exact owned-resource before/after inventories.
- `git diff --check`: exit 0.

Current row index (the status is intentionally not a waiver):

| Row | Exact retained boundary/test | Current result |
|---|---|---|
| WRC-01 | `shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network` | PASS, synthetic internal provider and whole-runtime tool roundtrip |
| WRC-02 | Same shipped subprocess plus fixed Docker argv and hostile inherited environment/prompt data path | RESIDUAL: selector/secret values are excluded and model input remains data, but fixed host process/filesystem instrumentation for malicious model data is not retained |
| WRC-03 | `test/shipped-preflight.test.mjs`: four named OS-subprocess controls | PASS |
| WRC-04 | Same shipped subprocess, daemon `runtime-inspect.stdout` | PASS scoped: one `/workspace` bind and prohibited target absence |
| WRC-05 | Named shipped `boundary-probe` absolute/parent and `/workspace` write/read/delete control | PASS for retained Linux bind boundary: absolute host-path and `/workspace/../` read/write attempts fail, outside sentinel remains unchanged, and workspace artifact write/read/delete succeeds |
| WRC-06 | Named shipped `boundary-probe` known container target and outside-path control | PASS for retained Linux namespace boundary: the project symlink to Docker-managed `/etc/hosts` resolves read-only, while outside host paths remain absent |
| WRC-07 | Shipped newline-cwd negative and mountinfo escaped-newline regression | RESIDUAL: these are not a nested-bind fixture; exact safe nested-bind denial/non-recursive evidence remains unavailable in this environment |
| WRC-08 | Named nested shipped CLI hardlink negative/control in `test/real-docker.test.mjs` | PASS: exit 1 before provider/model execution, outside sentinel unchanged, no new provider request; same-runtime ordinary single-link control completes |
| WRC-09 | Shipped warning/readability provider control | PASS scoped, synthetic project secrets intentionally exposed |
| WRC-10 | Shipped create flags/runtime inspection plus `resource-probe` read-only-root/tmpfs/project control | RESIDUAL: approved rootless UID0 mapping and bounded configuration observed; full named shipped inspection remains incomplete |
| WRC-11 | Shipped runtime daemon inspection plus bounded `resource-probe` below-limit control | RESIDUAL: below-limit configuration control passes, but bounded PID/memory enforcement negatives are not retained |
| WRC-12 | Shipped deadline marker/no-late-write control | PASS scoped |
| WRC-13 | Shipped SIGINT after started marker and daemon-confirmed runtime presence | PASS scoped |
| WRC-14 | Shipped independent stdout/stderr overflow and below-limit controls | PASS scoped |
| WRC-15 | Hostile metadata plus proxy/cloud/SSH/npm/selector environment and runtime inspect controls | RESIDUAL: hostile inherited classes are excluded from observed argv/runtime env, but all required hostile classes and allowlisted config are not independently retained |
| WRC-16A | Shipped access-only bootstrap and one-401 `reauth_required` control | PASS scoped; same-container access-token exposure is documented residual risk |
| WRC-17 | Existing synthetic host refresh rotation/event-log tests | PASS offline synthetic |
| WRC-18 | Test-owned derivative build/history/export/config scan | PASS scoped allowlisted build context |
| WRC-19 | Named shipped `nested-docker-probe` Docker/Podman/socket negatives and shell declared-tool control | RESIDUAL: socket/tool absence and `sh` control pass, but generated Docker/Podman CLI and nested-operation attempts are not retained |
| WRC-20 | This index plus raw daemon/image/source/row evidence | PARTIAL: exact current identities and applicable shipped results are linked; WRC-02/07/10/11/15/19 still require contract-exact negative/control evidence |
| WRC-21 | Native macOS Docker Desktop gate | DEFERRED by approved Linux-only milestone; no Linux substitution claimed |

Historical snapshots remain in `qa/wrc-finding-test-inventory.md` and `qa/run-117-docker-policy-diagnostic.md`; they are not current evidence. No real credentials, live provider request, host trust change, privilege escalation, or unowned resource deletion was used. Post-run owned container and network inventories are empty in the retained raw capture; pre-existing daemon resources are preserved.
