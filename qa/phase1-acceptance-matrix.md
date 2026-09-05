# Whole-runtime container acceptance matrix

This matrix records the whole-runtime migration on the current feature branch. Synthetic HOME/XDG/auth/provider fixtures only; no live provider requests or real credentials. Linux evidence below uses the observed rootless Docker daemon; the configured image must be rebuilt with `yolo setup` after source changes. Setup embeds the deterministic runtime source digest in the image label `org.yoloharness.source-digest`; the real-Docker gate verifies that label before using the image.

ID       Retained evidence                                      Status
WRC-01   Whole-runtime shipped launcher/image synthetic provider roundtrip  PASS (`shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network`; test-owned Docker config/endpoint, production metadata remains the tagged base image)
WRC-02   Launcher fixed argv / model text never host-executed   PASS (same shipped subprocess test; provider captured prompt and tool roundtrip)
WRC-03   Missing Docker/daemon/image fail-closed                FAIL (offline fail-closed coverage exists; real shipped probes NOT RUN)
WRC-04   Exact one /workspace bind and prohibited targets       NOT RUN (daemon inspection)
WRC-05   Outside absolute/parent path controls                   NOT RUN (real image)
WRC-06   Symlink namespace controls                              NOT RUN (real image)
WRC-07   Nested mount rejection                                  PASS shipped negative/control: newline-cwd is rejected before Docker mount parsing; escaped-newline parser regression PASS
WRC-08   Multi-link regular-file rejection                       PASS test/container-launcher.test.mjs
WRC-09   Project secret warning / intentional exposure            NOT RUN
WRC-10   Rootless-only UID0 mapping, read-only root, tmpfs, canary PASS scoped controls (rebuilt image canary and shipped create flags pass; full daemon-observed row remains partial)
WRC-11   Daemon resource/security inspection                      NOT RUN
WRC-12   Started-child deadline and exact absence                  PARTIAL (offline launcher cancellation/timeout cleanup; real shipped deadline gate NOT RUN; bounded reconciliation now separates total budget from stable absence)
WRC-13   Real OS SIGINT and exact absence                         NOT RUN on ContainerLauncher
WRC-14   Independent stdout/stderr overflow cleanup               NOT RUN on ContainerLauncher
WRC-15   Environment/metadata secret exclusion                    PASS scoped shipped controls (hostile derivative rejected before credentials; runtime argv excludes Docker config/token vars; full daemon env inspection NOT RUN)
WRC-16A  Access-only bootstrap; refresh absent; 401 fail-closed   PARTIAL (bootstrap/provider unit coverage; daemon probes NOT RUN)
WRC-17   Host refresh rotation and atomic persistence             PASS existing auth integration tests
WRC-18   Allowlisted build context / secret-free layers           PARTIAL (bundled Dockerfile and ignore rules; layer probe NOT RUN)
WRC-19   No Docker socket/nested Docker; declared tools            NOT RUN on final image
WRC-20   Observed Linux rootless evidence tied to image/commit     PARTIAL (Docker 29.8.0 rootless, current configured-image ID/source label, and fixed installation-owned context verified; WRC-03..19 rows not all complete)
WRC-21   Native macOS Docker Desktop                              NOT RUN (separate platform gate)

Offline verification
- npm test: PASS (84 pass, 2 skipped; 86 total)
- node --test test/container-launcher.test.mjs: PASS (17 pass)
- `npm run test:docker`: PASS (2 pass, 0 fail; rebuilt rootless image, shipped provider row, read-only-root canary, hostile-XDG provenance negative, newline-cwd negative, create-flag positive controls, test-owned empty Docker config plus verified local endpoint)
- node --check src/cli.mjs src/container-launcher.mjs: PASS
- git diff --check: PASS

Security finding disposition
- Newline-escaped mount target (security review medium): fixed by decoding Linux mountinfo `\\012` in `src/container-launcher.mjs`; regression is `mountinfo decoding preserves escaped newline targets for nested-mount checks` in `test/container-launcher.test.mjs`.
- Synthetic Docker configuration provenance finding: fixed in `test/real-docker.test.mjs` by resolving the selected local endpoint before isolation and supplying a test-owned empty Docker config; the shipped child no longer consumes the invoker's Docker config, auth helpers, or contexts. Test-only network/image routing remains outside the shipped image-selection API.

Cleanup regression
- `uncertain create waits for stable absence and removes a delayed daemon container`: PASS. Exact name+label reconciliation polls for the complete bounded 500 ms grace; discovered IDs reset the absence clock, are removed and inspected, and `cleanup_unknown` is returned unless the full grace proves stable absence.

Known platform boundary
The launcher verifies `name=rootless` from `docker info` and selects the approved explicit container UID/GID 0:0 mapping. Rootful/unknown Docker fails closed; no chmod/chown, ACL preparation, or world-writable workaround is used. Normal mode-0755 host-owned project write/delete is a required shipped-path gate. Linux evidence does not imply native macOS support. The whole-runtime synthetic provider evidence was collected with a disposable workspace, synthetic token, and local mock server; it is not live-provider evidence.
