# Whole-runtime container acceptance matrix

This matrix records the whole-runtime migration on the current feature branch. Synthetic HOME/XDG/auth/provider fixtures only; no live provider requests or real credentials. Linux evidence below uses the observed rootless Docker daemon; the non-root image must be rebuilt with `yolo setup` after source changes.

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
WRC-10   Explicit non-root UID/GID, read-only root, tmpfs, canary NOT RUN after non-root migration (the prior UID0 exception is retired)
WRC-11   Daemon resource/security inspection                      NOT RUN
WRC-12   Started-child deadline and exact absence                  NOT RUN on ContainerLauncher
WRC-13   Real OS SIGINT and exact absence                         NOT RUN on ContainerLauncher
WRC-14   Independent stdout/stderr overflow cleanup               NOT RUN on ContainerLauncher
WRC-15   Environment/metadata secret exclusion                    PARTIAL (explicit launcher env; daemon inspection NOT RUN)
WRC-16A  Access-only bootstrap; refresh absent; 401 fail-closed   PARTIAL (bootstrap/provider unit coverage; daemon probes NOT RUN)
WRC-17   Host refresh rotation and atomic persistence             PASS existing auth integration tests
WRC-18   Allowlisted build context / secret-free layers           PARTIAL (bundled Dockerfile and ignore rules; layer probe NOT RUN)
WRC-19   No Docker socket/nested Docker; declared tools            NOT RUN on final image
WRC-20   Observed Linux rootless evidence tied to image/commit     PARTIAL (daemon observation and roundtrip retained; required adversarial probes remain unrun)
WRC-21   Native macOS Docker Desktop                              NOT RUN (separate platform gate)

Offline verification
- npm test: PASS (70 pass, 2 skipped; 72 total)
- node --test test/container-launcher.test.mjs: PASS (4 pass)
- node --check src/cli.mjs src/container-launcher.mjs: PASS
- git diff --check: PASS

Known platform boundary
The launcher verifies `name=rootless` from `docker info` and selects explicit container UID/GID 10001:10001. Rootful/unknown Docker fails closed; no chmod/chown or world-writable workaround is used. Rootless bind mounts may require operator ACL/ownership preparation for that numeric identity; if the selected project cannot be written, the run fails closed. Linux evidence does not imply native macOS support. The whole-runtime synthetic provider evidence was collected with a disposable workspace, synthetic token, and local mock server; it is not live-provider evidence.
