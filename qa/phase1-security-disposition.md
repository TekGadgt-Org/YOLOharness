# Phase1 security finding disposition

This file records offline/local evidence for the phase1 security findings. It is not release approval for a real Docker daemon, live OAuth/provider traffic, or native macOS.

1. Container cleanup: implemented in `src/docker-executor.mjs`. Generated identity is treated as potentially created once create starts; cancellation/failure performs exact-name kill, rm, and inspect reconciliation. A successful not-found absence probe must name the exact generated container; mismatched, suffix, and ambiguous diagnostics remain cleanup_unknown. Process-double coverage is in `test/integration.test.mjs`; real daemon behavior remains unrun.
2. Worker receipt contract: fixed in `src/docker-executor.mjs`, `worker.mjs`, and `src/runtime.mjs`. The host requires exactly one receipt with version 1, typed closed fields, matching non-empty call_id, and success/failure invariants. Malformed, extra-key, and spawned-worker failure cases are regression-tested; the provider→runtime→DockerExecutor envelope path is exercised by a process double.
3. Refresh race and durability: fixed in `src/auth.mjs`. Generation reread prevents duplicate rotating-token use; atomic temp-directory acquisition plus an in-lock reclaim marker prevents an acquirer from becoming owner after reclamation starts; save uses temporary-file and containing-directory fsync with errors observable. Actual two-child-process rotation, crashed-child reclaim, dead-owner reclaim, and real temporary-file/directory fsync fault regressions pass. Expired credentials are refreshed before first provider traffic, while retry refresh is limited to one actual 401.
4. Bearer endpoint boundary: implemented in `src/cli.mjs`. Production configuration and `yolo auth login` use only the literal canonical HTTPS Responses/auth endpoints before credential loading or network traffic; query, fragment, authority-port, userinfo, path, case, loopback, and poisoned auth URL variants cannot reach the credential store. Refresh configuration uses the stored credential clientId rather than transient environment state. Test providers use explicit construction with synthetic credentials.
5. Receipt retention: fixed for default receipt fields. Prompt, result, tool arguments, output, message, and text are SHA-256 digests; short synthetic markers are absent from JSONL while final result remains returned to the caller.
6. Documentation: README documents the cleanup-grace distinction and canonical endpoint/test-only injection boundary.

Verification
- `npm test`: PASS, 46 tests, 0 failures.
- Changed-module `node --check`: PASS.
- `git diff --check`: PASS when final handoff was prepared.
- `npm pack --dry-run --json`: PASS when final handoff was prepared.
- Local fixture CLI smoke: PASS, including packed/extracted package-bin invocation, offline-only.

Not run by design: real Docker build/run/isolation and daemon lifecycle, live OAuth/provider traffic, native macOS, and package installation. Package installation is excluded by the task constraint; package artifact inspection is covered by npm pack dry-run.
