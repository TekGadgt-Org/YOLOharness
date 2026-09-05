# Phase 1 consolidated QA/security disposition

This ledger records the implementation delta on the sole backend writer lane. It does not claim release acceptance where the shipped WRC matrix remains unrun.

| Finding | WRC rows | Disposition and evidence |
|---|---|---|
| S3-01 complete shipped-CLI matrix absent | WRC-03..20 except 16B | Open. The current candidate still has the two existing rootless Docker tests; `npm test` passes 84 with 2 skipped. Full shipped negative/control matrix remains required and is not waived. |
| S3-02 hostile XDG/substituted image authority | WRC-03,10,15,18,20 | Product checks remain fail-closed before `runtimeCredentials()`: four-field metadata, installed source digest/version, exact immutable ID, installation tag, source label, and entrypoint. A shipped hostile-XDG negative/control is still required for closure. |
| S3-03 escaped-newline nested mount | WRC-07 | Parser correction is retained (`decodeMountInfoTargets` decodes `\\012`) with regression coverage. Actual newline-cwd shipped daemon negative/control remains an evidence gap. |
| S3-04 inherited Docker selection variables | WRC-01,15,20 | Synthetic shipped child now explicitly removes `DOCKER_CONTEXT`, `DOCKER_HOSTNAME`, `DOCKER_TLS_VERIFY`, and `DOCKER_CERT_PATH`, retaining only the test-owned empty config and verified local endpoint. Production keeps trusted invoker PATH/context semantics. |
| OLD-03 prefix/unknown-create ownership | WRC-02,12,13,14,20 | Corrected: create output and inspected IDs require exactly 64 hexadecimal characters; inspected ID must equal the requested full ID; reconciliation cleanup now re-inspects exact name and `yoloharness.run` label before kill/rm. Negative foreign-resource and positive owned-resource controls remain in launcher tests. |
| OLD-04 shipped fixture/command injection | WRC-02,03,15,20 | Resolved in prior candidate: shipped parser rejects `--fixture` and no `YOLO_DOCKER_COMMAND` path exists. Current-SHA shipped raw negative evidence remains required. |
| OLD-05 stable absence/deadline/overflow | WRC-12,13,14,20 | Product budgets and offline cancellation/timeout/stdout/stderr/nonzero controls remain passing. Real shipped deadline, SIGINT, independent overflow, and no-late-write evidence remain open. |
| Non-actionable boundaries | WRC-16B, WRC-21 | WRC-16B is inapplicable under approved Option A. WRC-21/native macOS is explicitly NOT RUN. Rootful/Desktop, live OAuth/real credentials, and compromised trusted host/daemon remain outside scope. |

## Verification

- `npm test`: 84 passed, 0 failed, 2 skipped (86 tests).
- `node --test test/container-launcher.test.mjs`: 17 passed, 0 failed, 0 skipped.
- `git diff --check`: passed.
- `npm run test:docker`: blocked for the current source because the configured image contains the prior source digest; rebuilding via the default Docker socket was unavailable (`unix:///var/run/docker.sock`). The previously recorded rootless gate evidence is historical and is not reused as current acceptance evidence.

## Residual acceptance blockers

The implementation must not be represented as WRC-20 complete. Before release, rebuild the runtime image from this exact candidate using the verified rootless daemon, rerun the shipped subprocess matrix from disposable working directories, retain raw stdout/stderr/status/timestamps and exact-owned before/after inventories, and obtain independent QA/security review. No real credentials, provider calls, host trust changes, packaging, publication, or privilege changes were used.
