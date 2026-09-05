# Whole-runtime container acceptance matrix

This matrix records the whole-runtime migration on the current feature branch. Synthetic HOME/XDG/auth/provider fixtures only; no live provider requests or real credentials. Linux evidence below uses the observed rootless Docker daemon; the rootless-only UID0 image must be rebuilt with `yolo setup` after source changes.

ID       Retained evidence                                      Status
WRC-01   Whole-runtime shipped launcher/image synthetic provider roundtrip  PASS (`shipped CLI runs the whole runtime in the configured immutable image against an isolated synthetic provider`; 1 pass, 0 fail)
WRC-02   Launcher fixed argv / model text never host-executed   PARTIAL (offline source/runtime coverage)
WRC-03   Missing Docker/daemon/image fail-closed                PASS offline; real daemon gate NOT RUN
WRC-04   Exact one /workspace bind and prohibited targets       NOT RUN (daemon inspection)
WRC-05   Outside absolute/parent path controls                   NOT RUN (real image)
WRC-06   Symlink namespace controls                              NOT RUN (real image)
WRC-07   Nested mount rejection                                  IMPLEMENTED in validateWorkspace; no nested-mount fixture
WRC-08   Multi-link regular-file rejection                       PASS test/container-launcher.test.mjs
WRC-09   Project secret warning / intentional exposure            NOT RUN
WRC-10   Rootless-only UID0 mapping, read-only root, tmpfs, canary PASS (approved UID0 exception; shipped image canary pass)
WRC-11   Daemon resource/security inspection                      NOT RUN
WRC-12   Started-child deadline and exact absence                  PARTIAL (offline launcher cancellation/timeout cleanup; real shipped deadline gate NOT RUN)
WRC-13   Real OS SIGINT and exact absence                         NOT RUN on ContainerLauncher
WRC-14   Independent stdout/stderr overflow cleanup               NOT RUN on ContainerLauncher
WRC-15   Environment/metadata secret exclusion                    PARTIAL (explicit launcher env; daemon inspection NOT RUN)
WRC-16A  Access-only bootstrap; refresh absent; 401 fail-closed   PARTIAL (bootstrap/provider unit coverage; daemon probes NOT RUN)
WRC-17   Host refresh rotation and atomic persistence             PASS existing auth integration tests
WRC-18   Allowlisted build context / secret-free layers           PARTIAL (bundled Dockerfile and ignore rules; layer probe NOT RUN)
WRC-19   No Docker socket/nested Docker; declared tools            NOT RUN on final image
WRC-20   Observed Linux rootless evidence tied to image/commit     PARTIAL (Docker 29.8.0 rootless and immutable image observed; full WRC-01..19 evidence remains incomplete)
WRC-21   Native macOS Docker Desktop                              NOT RUN (separate platform gate)

Offline verification
- npm test: PASS (72 pass, 2 skipped; 74 total)
- node --test test/container-launcher.test.mjs: PASS (6 pass)
- `YOLO_REAL_DOCKER=1 YOLO_DOCKER_IMAGE=yoloharness-local:0.1.0 node --test test/real-docker.test.mjs`: PASS (2 pass, 0 fail)
- node --check src/cli.mjs src/container-launcher.mjs: PASS
- git diff --check: PASS

Cleanup regression
- `uncertain create waits for stable absence and removes a delayed daemon container`: PASS. Exact name+label reconciliation polls until two consecutive absent observations within a bounded 500 ms grace; discovered IDs are removed and inspected, otherwise `cleanup_unknown` is returned.

Known platform boundary
The launcher verifies `name=rootless` from `docker info` and selects the approved explicit container UID/GID 0:0 mapping. Rootful/unknown Docker fails closed; no chmod/chown, ACL preparation, or world-writable workaround is used. Normal mode-0755 host-owned project write/delete is a required shipped-path gate. Linux evidence does not imply native macOS support. The whole-runtime synthetic provider evidence was collected with a disposable workspace, synthetic token, and local mock server; it is not live-provider evidence.
