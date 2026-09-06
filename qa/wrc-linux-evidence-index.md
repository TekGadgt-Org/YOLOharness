# Fresh Linux WRC evidence index

Candidate source commit: `cf55c9e` (`test: retain shipped WRC-08 hardlink probe`)
Runtime source digest: `sha256:89d149d12f9bd411775b1b5dc0bee41cac92f8e11798858a898616bcdbf027`
Production image: `yoloharness-local:0.1.0`
Production image ID: `sha256:dc073cdc43f6967b5d84acc6dc65565493a6e22a56c88f3eca0011312074d261`
Host: Linux `6.8.0-138-generic x86_64`, Node `v22.23.2`
Daemon: rootless Docker `29.8.0`, context `rootless`, cgroup v2, security options `seccomp/profile=builtin`, `rootless`, `cgroupns`

Fresh retained commands and results:

- `npm test`: exit 0; 87 passed, 0 failed, 6 skipped, 93 total.
- `node --check test/real-docker.test.mjs`: exit 0.
- `YOLO_REAL_DOCKER=1 node --test test/real-docker.test.mjs`: exit 0; 3 passed, 0 failed, 0 skipped. The parent test contains the named nested `WRC-08 shipped CLI rejects a hardlink alias before model execution` result.
- `sh qa/capture-wrc-baseline.sh`: exit 0. Raw command/stdout/stderr/status files are under `qa/wrc-baseline-raw/`; the capture includes the full npm suite, real-Docker gate, shipped preflight, daemon/image inspection, and exact owned-resource before/after inventories.
- `git diff --check`: exit 0.

Current row index (the status is intentionally not a waiver):

| Row | Exact retained boundary/test | Current result |
|---|---|---|
| WRC-01 | `shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network` | PASS, synthetic internal provider and whole-runtime tool roundtrip |
| WRC-02 | Same shipped subprocess plus fixed Docker argv and hostile prompt data path | PASS for fixed argv/data path; malicious model-data host instrumentation remains a residual scope item |
| WRC-03 | `test/shipped-preflight.test.mjs`: four named OS-subprocess controls | PASS |
| WRC-04 | Same shipped subprocess, daemon `runtime-inspect.stdout` | PASS scoped: one `/workspace` bind and prohibited target absence |
| WRC-05 | Shipped symlink negative and workspace controls | PASS scoped; complete absolute/parent final-image sentinel row remains residual |
| WRC-06 | Shipped outside-symlink negative plus `/etc/hosts` container-target control | PASS scoped; broader namespace canaries remain residual |
| WRC-07 | Shipped newline-cwd negative and mountinfo escaped-newline regression | PASS scoped; unprivileged nested-bind fixture remains environment-bounded |
| WRC-08 | Named nested shipped CLI hardlink negative/control in `test/real-docker.test.mjs` | PASS: exit 1 before provider/model execution, outside sentinel unchanged, no new provider request; same-runtime ordinary single-link control completes |
| WRC-09 | Shipped warning/readability provider control | PASS scoped, synthetic project secrets intentionally exposed |
| WRC-10 | Shipped create flags/runtime inspection plus named final-image canary | PASS scoped; complete daemon-observed row remains residual |
| WRC-11 | Shipped runtime daemon inspection | PASS scoped for asserted limits/caps/NNP/mounts/network; bounded fork-bomb/memory probes remain residual |
| WRC-12 | Shipped deadline marker/no-late-write control | PASS scoped |
| WRC-13 | Shipped SIGINT after started marker and daemon-confirmed runtime presence | PASS scoped |
| WRC-14 | Shipped independent stdout/stderr overflow and below-limit controls | PASS scoped |
| WRC-15 | Hostile metadata/env and runtime inspect controls | PASS scoped; full hostile env class inspection remains residual |
| WRC-16A | Shipped access-only bootstrap and one-401 `reauth_required` control | PASS scoped; same-container access-token exposure is documented residual risk |
| WRC-17 | Existing synthetic host refresh rotation/event-log tests | PASS offline synthetic |
| WRC-18 | Test-owned derivative build/history/export/config scan | PASS scoped allowlisted build context |
| WRC-19 | Shipped runtime env/mount inspection and declared-tool provider control | PASS scoped; generated-command Docker/Podman attempts remain residual |
| WRC-20 | This index plus raw daemon/image/source/row evidence | PARTIAL: exact current identities and applicable shipped results are linked, but rows explicitly marked residual prevent full aggregation closure |
| WRC-21 | Native macOS Docker Desktop gate | DEFERRED by approved Linux-only milestone; no Linux substitution claimed |

Historical snapshots remain in `qa/wrc-finding-test-inventory.md` and `qa/run-117-docker-policy-diagnostic.md`; they are not current evidence. No real credentials, live provider request, host trust change, privilege escalation, or unowned resource deletion was used. Post-run owned container and network inventories are empty in the retained raw capture; pre-existing daemon resources are preserved.
