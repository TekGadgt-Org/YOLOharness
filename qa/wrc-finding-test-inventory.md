# WRC finding-to-test inventory (repair candidate)

Source: amended task contract in whole-runtime-container-contract.md and review t_b8cfa081. Prior candidate c7672b3 was clean; npm test 80 pass/2 skip and real Docker 2 pass, but only WRC-01/02 were shipped-subprocess evidence. This inventory is retained before patching.

| Finding / required control | Production boundary | Exact test / path | Prior observed result | Missing assertion / repair |
|---|---|---|---|---|
| WRC-01 provider whole-runtime | shipped CLI -> configured image -> internal provider | `shipped yolo subprocess uses the immutable CA-only derivative...`, test/real-docker.test.mjs | PASS scoped derivative | retain container-origin/cgroup capture and positive control |
| WRC-02 model text not host-executed | shipped CLI argv/env -> Docker create | same shipped subprocess test | PASS scoped | retain fixed argv and hostile shell/path prompt |
| WRC-03 unavailable daemon/image | shipped CLI preflight/image policy | test/real-docker.test.mjs | FAIL/absent | run unusable docker, daemon unavailable, absent image + valid control |
| WRC-04 exact mount/prohibited targets | launcher create -> daemon inspect | test/real-docker.test.mjs | NOT RUN | inspect mounts, sockets, home, proc/devices, network modes |
| WRC-05 outside/parent paths | workspace validation -> bind | test/real-docker.test.mjs | NOT RUN | absolute/parent read/write probes + project artifact control |
| WRC-06 symlink namespace | workspace bind -> container filesystem | test/real-docker.test.mjs | NOT RUN | outside sentinel and container-target symlink controls |
| WRC-07 nested mount | validateWorkspace -> bind | test/real-docker.test.mjs | implemented only | create unprivileged nested fixture and reject; ordinary-dir control |
| WRC-08 hardlink | validateWorkspace -> bind | test/container-launcher.test.mjs | PASS | retain multi-link rejection and single-link control |
| WRC-09 project secrets warning | shipped CLI -> workspace | test/real-docker.test.mjs | NOT RUN | synthetic secret readability + warning, no confidentiality claim |
| WRC-10 rootless/resource filesystem | launcher flags -> daemon/container | test/real-docker.test.mjs | PARTIAL | daemon-observed UID0 approved rootless exception, read-only root/tmpfs/write-delete |
| WRC-11 limits/security | create config -> daemon inspect/runtime | test/real-docker.test.mjs | NOT RUN | memory/CPU/PIDs/caps/seccomp/Nnp/init/network + safe probes |
| WRC-12 deadline cleanup | shipped CLI -> exact container lifecycle | test/real-docker.test.mjs | PARTIAL offline | started/late marker, real deadline, exact absence/no late write |
| WRC-13 OS SIGINT cleanup | OS subprocess -> launcher | test/real-docker.test.mjs | NOT RUN | started marker, SIGINT, 130, descendants absent + control |
| WRC-14 output bounds | attached stdout/stderr -> host | test/real-docker.test.mjs | NOT RUN | independent overflow + bounded control |
| WRC-15 hostile environment | inherited env -> explicit container env | test/real-docker.test.mjs | PARTIAL | hostile HOME/XDG/DOCKER/proxy/cloud/SSH/test env not propagated |
| WRC-16A access-only token | credential helper -> bootstrap stdin | test/real-docker.test.mjs | PARTIAL | synthetic access/refresh inspection, honest same-container exposure, 401 fail-closed |
| WRC-17 refresh owner | host AuthStore -> atomic persistence | test/integration.test.mjs | PASS existing | retain concurrency/crash persistence control |
| WRC-18 build context/layers | setup -> Docker build context/image | test/real-docker.test.mjs | PARTIAL | fixture secrets absent from context/files/history/exported layers |
| WRC-19 no nested Docker | runtime container -> tools/socket | test/real-docker.test.mjs | NOT RUN | Docker/Podman/socket absence + declared tool positive control |
| WRC-20 Linux evidence | daemon + image -> retained QA | qa/real-docker-evidence.md | PARTIAL | exact SHA/image/source label/kernel/cgroup/rootless and all row outputs |

Unchanged limits: WRC-21/native macOS, rootful Docker, live OAuth/provider, real credentials, compromised daemon/kernel, and post-validation TOCTOU are not run by policy. Option A access-token same-container exposure is accepted and must be stated honestly.
