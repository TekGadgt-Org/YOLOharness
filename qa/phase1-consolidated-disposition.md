# Phase 1 consolidated QA/security disposition

This ledger records the implementation delta on the sole backend writer lane. It does not claim release acceptance for WRC rows that still require daemon inspection or platform-specific execution.

| Finding | WRC rows | Disposition and evidence |
|---|---|---|
| S3-01 complete shipped-CLI matrix absent | WRC-03..20 except 16B | Partially corrected. The shipped gate passes 2/2 from a rebuilt current-source image; daemon inspection now records runtime flags, one `/workspace` bind, env-secret exclusions, and network/mount state in `qa/wrc-baseline-raw/runtime-inspect.stdout`. Lifecycle/platform rows that require deadline, SIGINT, overflow, layer-history, or separate platform execution remain explicitly partial/unrun. |
| S3-02 hostile XDG/substituted image authority | WRC-03,10,15,18,20 | Corrected and shipped-tested: a metadata-selected CA derivative is rejected for missing installation-owned tag before an intentionally missing credential path is read; the tagged base image remains the positive control. Four-field metadata, installed source digest/version, exact immutable ID, source label, and entrypoint checks remain fail-closed before `runtimeCredentials()`. |
| S3-03 escaped-newline nested mount | WRC-07 | Corrected and shipped-tested: mountinfo decodes `\\012`, and a real newline-cwd subprocess is rejected before Docker mount parsing; a normal disposable cwd completes the positive control. |
| S3-04 inherited Docker selection variables | WRC-01,15,20 | Corrected and shipped-tested: synthetic child explicitly removes `DOCKER_CONTEXT`, `DOCKER_HOSTNAME`, `DOCKER_TLS_VERIFY`, and `DOCKER_CERT_PATH`, retaining only the test-owned empty config and verified local endpoint. Production keeps trusted invoker PATH/context semantics. |
| OLD-03 prefix/unknown-create ownership | WRC-02,12,13,14,20 | Corrected and regression-tested: create output and inspected IDs require exactly 64 hexadecimal characters; inspected ID must equal the requested full ID; reconciliation cleanup now re-inspects exact name and `yoloharness.run` label before kill/rm. The foreign-resource negative uses a valid 64-hex ID and asserts no start/kill/rm; positive owned-resource and delayed reconciliation controls remain in launcher tests. |
| OLD-04 shipped fixture/command injection | WRC-02,03,15,20 | Resolved: shipped parser rejects `--fixture` and no `YOLO_DOCKER_COMMAND` path exists. Current-SHA shipped raw negative evidence is refreshed under Node 22; Node 24 portability is separately corrected by using `fs.constants.X_OK`. |
| OLD-05 stable absence/deadline/overflow | WRC-12,13,14,20 | Product budgets and offline cancellation/timeout/stdout/stderr/nonzero controls remain passing. Real shipped deadline, SIGINT, independent overflow, and no-late-write evidence remain open; no offline result is represented as a real-daemon pass. |
| R121-01 Node 24 shipped import failure | shipped CLI availability | Corrected in `src/cli.mjs`: use the portable `fs.constants.X_OK` API rather than the nonexistent named `node:fs` export. Syntax and full Node test suites pass on the available Node 22 runtime; Node 24 execution remains unavailable in this environment. |
| Non-actionable boundaries | WRC-16B, WRC-21 | WRC-16B is inapplicable under approved Option A. WRC-21/native macOS is explicitly NOT RUN. Rootful/Desktop, live OAuth/real credentials, and compromised trusted host/daemon remain outside scope. |

## Verification

- `npm test`: 84 passed, 0 failed, 2 skipped (86 tests), captured in `qa/wrc-baseline-raw/`.
- `node --test test/container-launcher.test.mjs`: 17 passed, 0 failed, 0 skipped.
- `npm run test:docker`: 2 passed, 0 failed, 0 skipped from a rebuilt rootless image (`sha256:e57f1cfaee62295f8b006fe71a6441c3f15ca0f13f52c9bc4d6c4d24056127d1`); current raw stdout/status is retained in `qa/wrc-baseline-raw/`.
- `git diff --check`: passed.
- Rebuild used the inherited `rootless` context (Docker 29.8.0, security option `name=rootless`) without endpoint redirection or real credentials. Exact-owned post-run container inventory is empty; pre-existing images/networks are not claimed as test-owned.

## Residual acceptance blockers

The implementation must not be represented as WRC-20 complete. Before release, add/execute the remaining daemon-inspection and lifecycle rows from disposable working directories, retain raw stdout/stderr/status/timestamps and exact-owned before/after inventories, and obtain independent QA/security review. No real credentials, provider calls, host trust changes, packaging, publication, or privilege changes were used.
