# Whole-runtime container acceptance matrix

This matrix is tied to the current local commit and must be rerun against the exact built image digest. Synthetic HOME/XDG/auth/provider fixtures only; no live provider requests or real credentials. Linux evidence below uses rootless Docker 29.8.0 and the local image digest recorded by the build.

ID       Retained evidence                                      Status
WRC-01   Whole-runtime shipped launcher/image synthetic provider roundtrip  PASS (final image synthetic SSE provider roundtrip; provider→parser→exec→provider; artifact written in /workspace)
WRC-02   Launcher fixed argv / model text never host-executed   PARTIAL (offline source/runtime coverage)
WRC-03   Missing Docker/daemon/image fail-closed                PASS offline; real daemon gate NOT RUN
WRC-04   Exact one /workspace bind and prohibited targets       NOT RUN (daemon inspection)
WRC-05   Outside absolute/parent path controls                   NOT RUN (real image)
WRC-06   Symlink namespace controls                              NOT RUN (real image)
WRC-07   Nested mount rejection                                  IMPLEMENTED in validateWorkspace; no nested-mount fixture
WRC-08   Multi-link regular-file rejection                       PASS test/container-launcher.test.mjs
WRC-09   Project secret warning / intentional exposure            NOT RUN
WRC-10   Non-root, read-only root, tmpfs, final-UID canary        PASS on verified rootless Docker using approved rootless-only uid0 mapping; normal mode-0755 canary and /workspace write/delete pass
WRC-11   Daemon resource/security inspection                      NOT RUN
WRC-12   Started-child deadline and exact absence                  NOT RUN on ContainerLauncher
WRC-13   Real OS SIGINT and exact absence                         NOT RUN on ContainerLauncher
WRC-14   Independent stdout/stderr overflow cleanup               NOT RUN on ContainerLauncher
WRC-15   Environment/metadata secret exclusion                    PARTIAL (explicit launcher env; daemon inspection NOT RUN)
WRC-16A  Access-only bootstrap; refresh absent; 401 fail-closed   PARTIAL (bootstrap/provider unit coverage; daemon probes NOT RUN)
WRC-17   Host refresh rotation and atomic persistence             PASS existing auth integration tests
WRC-18   Allowlisted build context / secret-free layers           PARTIAL (bundled Dockerfile and ignore rules; layer probe NOT RUN)
WRC-19   No Docker socket/nested Docker; declared tools            NOT RUN on final image
WRC-20   Observed Linux rootless evidence tied to image/commit     PASS for daemon observation and whole-runtime roundtrip; remaining adversarial probes are separately marked
WRC-21   Native macOS Docker Desktop                              NOT RUN (separate platform gate)

Offline verification
- npm test: PASS (65 pass, 5 skipped; 70 total)
- node --test test/container-launcher.test.mjs: PASS (3 pass)
- node --check src/cli.mjs src/container-launcher.mjs: PASS
- git diff --check: PASS

Known platform boundary
The launcher verifies `name=rootless` from `docker info` before selecting the approved container uid0 mapping. Rootful/unknown Docker fails closed; no chmod/chown or world-writable workaround is used. Linux evidence does not imply native macOS support. The whole-runtime synthetic provider evidence was collected with a disposable workspace, synthetic token, and local mock server; it is not live-provider evidence.
