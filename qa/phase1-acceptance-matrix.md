Phase1 acceptance matrix

Offline implementation evidence for the current phase1 remediation. This is not release approval for a real Docker daemon, live OAuth/provider traffic, or native macOS.

Requirement                                      Evidence / result
Local HTTP provider -> runtime -> executor        test/integration.test.mjs: local HTTP provider to runtime to executor preserves the exec bridge contract; PASS.
Runtime cancellation waits for cleanup             test/runtime.test.mjs: deadline awaits executor cleanup before returning; PASS.
Cleanup grace expiry is truthful                   test/runtime.test.mjs: deadline reports unknown cleanup when executor exceeds cleanup grace; PASS.
Docker create cancel exact cleanup                 test/integration.test.mjs: docker create cancellation reaps and reconciles the exact generated identity; PASS with process double.
Worker receipt closed schema                       test/integration.test.mjs: typed success/failure variants and extra key rejection; PASS.
Production endpoint exact spelling                 test/integration.test.mjs: query/fragment/noncanonical endpoint rejection before credential read; PASS. Raw endpoint comparison is literal canonical spelling.
Cross-process refresh rotation                     test/integration.test.mjs: two independent node processes consume one rotating refresh token; PASS (one token request).
Persistence fault visibility                       test/integration.test.mjs: refresh persistence faults are observable; PASS.
Short prompt/result/tool-output retention           test/integration.test.mjs: short receipt text is digested; PASS (markers absent from JSONL).
Malicious arguments / no host fallback             Existing runtime validation and Docker fail-closed tests; PASS.
Package artifact inspection                         npm pack --dry-run --json; PASS. Package installation smoke was not run because this task forbids installs.

Verification commands
- npm test: PASS, 32 tests, 0 failures.
- node --check src/auth.mjs src/docker-executor.mjs src/runtime.mjs src/cli.mjs worker.mjs test/integration.test.mjs: PASS.
- git diff --check: PASS.
- npm pack --dry-run --json: PASS, 37 package entries.

Explicitly not run
- Real Docker build/run/isolation/daemon lifecycle
- Live OAuth/provider traffic
- Native macOS
- Package installation (task constraint)
