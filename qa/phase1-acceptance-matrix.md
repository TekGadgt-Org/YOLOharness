# Whole-runtime container acceptance matrix

This matrix is tied to the current local commit and must be rerun against the exact built image digest. Synthetic HOME/XDG/auth/provider fixtures only; no live provider requests or real credentials.

ID       Retained evidence                                      Status
WRC-01   Whole-runtime shipped CLI synthetic provider roundtrip  NOT RUN (mock endpoint must be reachable from container)
WRC-02   Launcher fixed argv / model text never host-executed   PARTIAL (offline source/runtime coverage)
WRC-03   Missing Docker/daemon/image fail-closed                PASS offline; real daemon gate NOT RUN
WRC-04   Exact one /workspace bind and prohibited targets       NOT RUN (daemon inspection)
WRC-05   Outside absolute/parent path controls                   NOT RUN (real image)
WRC-06   Symlink namespace controls                              NOT RUN (real image)
WRC-07   Nested mount rejection                                  IMPLEMENTED in validateWorkspace; no nested-mount fixture
WRC-08   Multi-link regular-file rejection                       PASS test/container-launcher.test.mjs
WRC-09   Project secret warning / intentional exposure            NOT RUN
WRC-10   Non-root, read-only root, tmpfs, final-UID canary        NOT RUN; rootless writeability is an environment gate
WRC-11   Daemon resource/security inspection                      NOT RUN
WRC-12   Started-child deadline and exact absence                  NOT RUN on ContainerLauncher
WRC-13   Real OS SIGINT and exact absence                         NOT RUN on ContainerLauncher
WRC-14   Independent stdout/stderr overflow cleanup               NOT RUN on ContainerLauncher
WRC-15   Environment/metadata secret exclusion                    PARTIAL (explicit launcher env; daemon inspection NOT RUN)
WRC-16A  Access-only bootstrap; refresh absent; 401 fail-closed   PARTIAL (bootstrap/provider unit coverage; daemon probes NOT RUN)
WRC-17   Host refresh rotation and atomic persistence             PASS existing auth integration tests
WRC-18   Allowlisted build context / secret-free layers           PARTIAL (bundled Dockerfile and ignore rules; layer probe NOT RUN)
WRC-19   No Docker socket/nested Docker; declared tools            NOT RUN on final image
WRC-20   Observed Linux rootless evidence tied to image/commit     Docker daemon is rootless; full probe set NOT RUN
WRC-21   Native macOS Docker Desktop                              NOT RUN (separate platform gate)

Offline verification
- npm test: PASS (65 pass, 5 skipped; 70 total)
- node --test test/container-launcher.test.mjs: PASS (3 pass)
- node --check src/cli.mjs src/container-launcher.mjs: PASS
- git diff --check: PASS

Known platform boundary
The checked-out project is owned by uid 999 and group 1001 with mode 2775, while the host process group is 988. A final-UID bind-write canary has not been claimed here. The launcher refuses uid 0 and does not chmod/chown the project; a real rootless canary is required before release approval. Linux evidence does not imply native macOS support.
