# Whole-runtime container acceptance matrix

This matrix records the whole-runtime migration on the current feature branch. Synthetic HOME/XDG/auth/provider fixtures only; no live provider requests or real credentials. Fresh cross-row evidence is indexed in `qa/wrc-linux-evidence-index.md` at candidate source commit `19e738b`. Linux evidence below uses the observed rootless Docker daemon; the configured image must be rebuilt with `yolo setup` after runtime source changes. Setup embeds the deterministic runtime source digest in the image label `org.yoloharness.source-digest`; the real-Docker gate verifies that label before using the image.

ID       Retained evidence                                      Status
WRC-01   Whole-runtime shipped launcher/image synthetic provider roundtrip  PASS (`shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network`; test-owned Docker config/endpoint, production metadata remains the tagged base image)
WRC-02   Launcher fixed argv / model text never host-executed   RESIDUAL (selector/secret values are excluded; fixed host process/filesystem instrumentation is not retained)
WRC-03   Missing Docker/daemon/image fail-closed                PASS scoped shipped preflight probes (`test/shipped-preflight.test.mjs`; unavailable client, unavailable daemon, absent image, and valid preflight control; synthetic fixtures only)
WRC-04   Exactly one /workspace bind and prohibited targets       PASS scoped shipped runtime inspect (`qa/wrc-baseline-raw/runtime-inspect.stdout`)
WRC-05   Outside absolute/parent path controls                   RESIDUAL shipped workspace control; real outside-sentinel read/write attempts remain unretained
WRC-06   Symlink namespace controls                              RESIDUAL known target control passes; project symlink namespace behavior remains unretained
WRC-07   Nested mount rejection                                  RESIDUAL shipped newline-cwd rejection and escaped-newline parser regression; nested-bind denial/non-recursive evidence remains unavailable
WRC-08   Multi-link regular-file rejection                       PASS shipped CLI subtest `WRC-08 shipped CLI rejects a hardlink alias before model execution` (negative hardlink alias leaves outside sentinel unchanged and emits no provider request; same-runtime ordinary single-link control completes; unit regression retained)
WRC-09   Project secret warning / intentional exposure            PASS scoped shipped control (warning emitted; synthetic `.env`, key, and token fixtures readable only through `/workspace`; no confidentiality claim)
WRC-10   Rootless-only UID0 mapping, read-only root, tmpfs, canary RESIDUAL shipped bounded control; full named inspection remains incomplete
WRC-11   Daemon resource/security inspection                      RESIDUAL bounded below-limit control; enforcement negatives remain unretained
WRC-12   Started-child deadline and exact absence                  PASS scoped shipped deadline/no-late-write control (started marker, exit 124, delayed descendant write absent, exact owned runtime inventory empty); broader matrix remains partial
WRC-13   Real OS SIGINT and exact absence                         PASS scoped shipped subprocess control (SIGINT after started marker exits 130, delayed write absent, exact owned runtime inventory empty)
WRC-14   Independent stdout/stderr overflow cleanup               PASS scoped shipped subprocess controls (stdout-only and stderr-only 1 MiB overflow exit 124 and exact owned runtime inventory empty; short-delay controls succeed)
WRC-15   Environment/metadata secret exclusion                    RESIDUAL observed exclusion; independent hostile-class and allowlist controls remain incomplete
WRC-16A  Access-only bootstrap; refresh absent; 401 fail-closed   PASS scoped shipped control (synthetic access token bootstrapped via stdin; captured `Authorization: Bearer` header; exactly one 401 request; refresh token absent from argv/env/logs; provider 401 returns `reauth_required` without retry/refresh)
WRC-17   Host refresh rotation and atomic persistence             PASS existing auth integration tests
WRC-18   Allowlisted build context / secret-free layers           PASS scoped derivative probe (credential, `.git`, `.yolo`, nested, and ignored synthetic secrets absent from history/export/config; allowlisted CA artifact remains usable)
WRC-19   No Docker socket/nested Docker; declared tools            RESIDUAL socket/tool absence and `sh` control pass; nested-operation attempts remain unretained
WRC-20   Observed Linux rootless evidence tied to image/commit     PARTIAL (Docker 29.8.0 rootless, current configured-image ID/source label, exact cleanup, and applicable shipped probes retained; broader daemon/matrix boundaries remain)
WRC-21   Native macOS Docker Desktop                              DEFERRED (approved Linux-only milestone; Ryan runs after Linux ships)

Offline verification
- npm test: PASS (88 pass, 6 skipped; 94 total)
- `YOLO_REAL_DOCKER=1 node --test test/shipped-preflight.test.mjs`: PASS (4 pass; raw command/output/status in `qa/wrc-baseline-raw/shipped-preflight.*`; disposable wrapper fixtures, no runtime container or credential handoff)
- node --test test/container-launcher.test.mjs: PASS (19 pass)
- `YOLO_EVIDENCE_DIR=qa/wrc-baseline-raw YOLO_REAL_DOCKER=1 node --test test/real-docker.test.mjs`: PASS (3 pass, 0 fail, 0 skipped; includes nested WRC-08 shipped hardlink negative/control, WRC-09 warning/readability, WRC-16A synthetic 401/reauth-required and token non-disclosure, WRC-18 derivative history/export scan, plus retained lifecycle, inspection, provenance, and cleanup controls)
- node --check src/cli.mjs src/container-launcher.mjs: PASS
- git diff --check: PASS

Security finding disposition
- Newline-escaped mount target (security review medium): fixed by decoding Linux mountinfo `\\012` in `src/container-launcher.mjs`; regression is `mountinfo decoding preserves escaped newline targets for nested-mount checks` in `test/container-launcher.test.mjs`.
- Synthetic Docker configuration provenance finding: fixed in `test/real-docker.test.mjs` by resolving the selected local endpoint before isolation and supplying a test-owned empty Docker config; the shipped child no longer consumes the invoker's Docker config, auth helpers, or contexts. Test-only network/image routing remains outside the shipped image-selection API.

Cleanup regression
- `uncertain create waits for stable absence and removes a delayed daemon container`: PASS. Exact name+label reconciliation polls for the complete bounded 500 ms grace; discovered IDs reset the absence clock, are removed and inspected, and `cleanup_unknown` is returned unless the full grace proves stable absence.
- Shipped deadline control: PASS. After `/workspace/deadline-started`, `yolo --json -t 0.05 deadline-probe` exited 124; the descendant's delayed `/workspace/deadline-late` write was absent and exact owned runtime inventory was empty.
- Shipped SIGINT control: PASS. After `/workspace/sigint-started`, the OS child received SIGINT and exited 130; `/workspace/sigint-late` was absent and the exact generated runtime name was absent after cleanup. The launcher now stops the owned container immediately on abort rather than waiting for an attach pipe that a descendant can keep open.
- Shipped stream controls: PASS. Independent stdout-only and stderr-only 1 MiB+ commands each returned the bounded failure receipt (CLI exit 124) and exact generated runtime name absence; matching short-delay stdout/stderr controls wrote their markers and completed successfully.

Known platform boundary
The launcher verifies `name=rootless` from `docker info` and selects the approved explicit container UID/GID 0:0 mapping. Rootful/unknown Docker fails closed; no chmod/chown, ACL preparation, or world-writable workaround is used. Normal mode-0755 host-owned project write/delete is a required shipped-path gate. Linux evidence does not imply native macOS support. The whole-runtime synthetic provider evidence was collected with a disposable workspace, synthetic token, and local mock server; it is not live-provider evidence.
