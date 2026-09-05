Phase1 acceptance matrix

Offline implementation evidence for the current phase1 remediation. This is not release approval for a real Docker daemon, live OAuth/provider traffic, or native macOS.

Requirement                                      Evidence / result
Local HTTP provider -> runtime -> executor        test/integration.test.mjs: local HTTP provider to runtime to executor preserves the exec bridge contract; PASS (executor contract double; DockerExecutor envelope is covered by lifecycle doubles).
Runtime cancellation waits for cleanup             test/runtime.test.mjs: deadline awaits executor cleanup before returning; PASS.
Cleanup grace expiry is truthful                   test/runtime.test.mjs: deadline reports unknown cleanup when executor exceeds cleanup grace; PASS.
Docker create/start lifecycle                     test/integration.test.mjs: pre-abort, create cancel, create timeout, create output overflow, and start cancellation; PASS with delayed-close process doubles and exact cleanup ordering.
Cleanup reconciliation identity binding             test/integration.test.mjs: matching, mismatched, and ambiguous inspect evidence; PASS (unproven absence is cleanup_unknown).
Worker receipt closed schema                       test/integration.test.mjs: typed success/failure variants and extra key rejection; PASS.
Production endpoint exact spelling                 test/integration.test.mjs: query/fragment/noncanonical endpoint rejection before credential read; PASS. Raw endpoint comparison is literal canonical spelling.
Cross-process refresh rotation                     test/integration.test.mjs: two independent node processes consume one rotating refresh token; PASS (one token request). Dead-owner stale lock reclaim also PASS.
Expired credential preflight                        test/integration.test.mjs: expired credentials refresh before first provider request; PASS; CLI test proves stored client identity is used without transient env.
Persistence fault visibility                       test/integration.test.mjs: real temporary-file and containing-directory fsync paths with injected faults; PASS.
Short prompt/result/tool-output retention           test/integration.test.mjs: short receipt text is digested; PASS (markers absent from JSONL).
Malicious arguments / no host fallback             Existing runtime validation and Docker fail-closed tests; PASS.
Package artifact / extracted-bin smoke              npm pack plus extracted package `src/cli.mjs --fixture --json`; PASS, no install or registry access.

Verification commands
- npm test: PASS, 45 tests, 0 failures.
- node --check src/auth.mjs src/docker-executor.mjs src/runtime.mjs src/cli.mjs worker.mjs test/integration.test.mjs: PASS.
- git diff --check: PASS.
- npm pack --dry-run --json: PASS, 37 package entries; packed/extracted bin smoke is a reusable npm test and PASS.

Explicitly not run
- Real Docker build/run/isolation/daemon lifecycle
- Live OAuth/provider traffic
- Native macOS
- Registry package installation (task constraint; extracted packed artifact smoke was run)
