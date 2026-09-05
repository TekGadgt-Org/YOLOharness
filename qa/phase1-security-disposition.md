# Phase1 security finding disposition

This file records the offline evidence for the final review findings. It is not a release approval for Docker, live auth/provider traffic, or native macOS.

1. Container cleanup: fixed in `src/docker-executor.mjs`. A generated identity is treated as potentially created immediately before `docker create`; cancellation/output/start failures run exact-name kill and rm under bounded deadlines. Cleanup failure is reported as `cleanup_unknown`. Process-double coverage is in `test/integration.test.mjs`; real daemon behavior was not run.
2. Worker receipt contract: fixed in `src/docker-executor.mjs`, `worker.mjs`, and `src/runtime.mjs`. The host requires exactly one non-empty JSON receipt with version 1, boolean `ok`, matching non-empty `call_id`, and a closed key set. The stdin envelope carries version 1 and call_id.
3. Refresh race and durability: fixed in `src/auth.mjs`. Stored credentials carry a generation; refresh rereads under an owner-token lock and returns a newer generation instead of consuming a rotating token twice. Temporary-file and directory fsync failures are observable; lock release is ownership checked and stale deletion requires a dead owner PID.
4. Bearer endpoint boundary: fixed in `src/cli.mjs` and README. Production CLI accepts only the canonical HTTPS origin/path and rejects loopback, userinfo, query/path lookalikes, and arbitrary endpoint overrides before loading credentials. Test clients can still inject fetch and synthetic credentials directly.
5. Receipt retention: existing event redaction/digest behavior remains bounded; arbitrary output is not logged as free text by the runtime receipt path. Final user result remains returned to the caller.
6. Documentation: README provider setup now states the canonical production endpoint and explicit test-only loopback injection boundary.

Verification performed:

- `npm test`: 24 passed, 0 failed on the prior remediation; current regression additions are verified separately in the task handoff.
- `node --check src/auth.mjs src/docker-executor.mjs src/runtime.mjs src/cli.mjs worker.mjs`: passed.
- `node src/cli.mjs --fixture --json 'offline smoke'`: completed with valid JSON record.
- `npm pack --dry-run --json`: passed (npm emitted only the missing .npmignore advisory).
- `git diff --check`: passed.

Explicitly not run: Docker daemon/image build or isolation, live OAuth/provider traffic, native macOS, package installation, and external registry access.
