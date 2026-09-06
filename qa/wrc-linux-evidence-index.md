# Fresh Linux WRC evidence index

Candidate source commit: `ea783e0` (`test: retain shipped Linux WRC boundary probes`)
Runtime source digest: `sha256:89d149d12f9bd411775b1b5dc0bee41cac92f8e11798858a898616bcdbf027`
Production image: `yoloharness-local:0.1.0`
Production image ID: `sha256:dc073cdc43f6967b5d84acc6dc65565493a6e22a56c88f3eca0011312074d261`
Host: Linux `6.8.0-138-generic x86_64`, Node `v22.23.2`
Daemon: rootless Docker `29.8.0`, context `rootless`, cgroup v2, security options `seccomp/profile=builtin`, `rootless`, `cgroupns`

Fresh retained commands and results:

- `npm test`: exit 0; 87 passed, 0 failed, 6 skipped, 93 total.
- `node --check test/real-docker.test.mjs`: exit 0.
- `YOLO_EVIDENCE_DIR=qa/wrc-baseline-raw YOLO_REAL_DOCKER=1 node --test test/real-docker.test.mjs`: exit 0; 3 passed, 0 failed, 0 skipped. The parent test contains the named nested `WRC-08 shipped CLI rejects a hardlink alias before model execution` result and retained row-specific probe artifacts.
- `sh qa/capture-wrc-baseline.sh`: exit 0. Raw command/stdout/stderr/status files are under `qa/wrc-baseline-raw/`; the capture includes the full npm suite, real-Docker gate, shipped preflight, daemon/image inspection, and exact owned-resource before/after inventories.
- `git diff --check`: exit 0.

Current row index (the status is intentionally not a waiver):

| Row | Exact retained boundary/test | Current result |
|---|---|---|
| WRC-01 | `shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network` | PASS, synthetic internal provider and whole-runtime tool roundtrip |
| WRC-02 | Same shipped subprocess plus fixed Docker argv and hostile inherited environment/prompt data path | PASS, hostile selector/secret values are absent from Docker argv and runtime environment; model input remains data |
| WRC-03 | `test/shipped-preflight.test.mjs`: four named OS-subprocess controls | PASS |
| WRC-04 | Same shipped subprocess, daemon `runtime-inspect.stdout` | PASS scoped: one `/workspace` bind and prohibited target absence |
| WRC-05 | Named shipped `boundary-probe` absolute/parent and `/workspace` write/read/delete control | PASS, outside path remains absent and workspace artifact is removed |
| WRC-06 | Named shipped `boundary-probe` known container target and outside-path control | PASS, `/etc/hosts` is readable in the container namespace while host-root paths are absent |
| WRC-07 | Shipped newline-cwd negative and mountinfo escaped-newline regression | PASS scoped; unprivileged nested-bind fixture remains environment-bounded |
| WRC-08 | Named nested shipped CLI hardlink negative/control in `test/real-docker.test.mjs` | PASS: exit 1 before provider/model execution, outside sentinel unchanged, no new provider request; same-runtime ordinary single-link control completes |
| WRC-09 | Shipped warning/readability provider control | PASS scoped, synthetic project secrets intentionally exposed |
| WRC-10 | Shipped create flags/runtime inspection plus `resource-probe` read-only-root/tmpfs/project control | PASS, approved rootless UID0 mapping and bounded resource configuration observed |
| WRC-11 | Shipped runtime daemon inspection plus bounded `resource-probe` below-limit control | PASS for bounded Linux probe: memory/PID cgroups, caps, NNP, mounts and network are daemon-observed; no uncontrolled exhaustion attempted |
| WRC-12 | Shipped deadline marker/no-late-write control | PASS scoped |
| WRC-13 | Shipped SIGINT after started marker and daemon-confirmed runtime presence | PASS scoped |
| WRC-14 | Shipped independent stdout/stderr overflow and below-limit controls | PASS scoped |
| WRC-15 | Hostile metadata plus proxy/cloud/SSH/npm/selector environment and runtime inspect controls | PASS, hostile inherited classes are not present in daemon argv/runtime env; explicit allowlist control succeeds |
| WRC-16A | Shipped access-only bootstrap and one-401 `reauth_required` control | PASS scoped; same-container access-token exposure is documented residual risk |
| WRC-17 | Existing synthetic host refresh rotation/event-log tests | PASS offline synthetic |
| WRC-18 | Test-owned derivative build/history/export/config scan | PASS scoped allowlisted build context |
| WRC-19 | Named shipped `nested-docker-probe` Docker/Podman/socket negatives and shell declared-tool control | PASS, daemon/socket access and Docker/Podman executables are unavailable while `sh` remains available |
| WRC-20 | This index plus raw daemon/image/source/row evidence | PARTIAL: exact current identities and applicable shipped results are linked, but rows explicitly marked residual prevent full aggregation closure |
| WRC-21 | Native macOS Docker Desktop gate | DEFERRED by approved Linux-only milestone; no Linux substitution claimed |

Historical snapshots remain in `qa/wrc-finding-test-inventory.md` and `qa/run-117-docker-policy-diagnostic.md`; they are not current evidence. No real credentials, live provider request, host trust change, privilege escalation, or unowned resource deletion was used. Post-run owned container and network inventories are empty in the retained raw capture; pre-existing daemon resources are preserved.
