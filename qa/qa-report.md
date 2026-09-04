YOLOharness spike QA report
Date: 2026-09-04 UTC
Scope: ../prototype only; independent verification, no implementation edits

Verdict
FAIL for the spike acceptance scope. The bounded fixture run, replay of a single run, default-deny behavior for shell/network/unknown effects, and fixture-only labeling work in the exercised paths. Two reproducible defects remain: reopening a multi-line JSONL event log fails, and path traversal (`..`) is authorized as a workspace file write. This is not production-ready.

Environment and commands
- Working directory: /opt/hermes/workspace/YOLOharness/prototype
- `node --version && npm test`
  - Node v22.23.2
  - 5 tests passed, 0 failed, 0 skipped, 0 cancelled.
- `node --test test/*.test.mjs`
  - 5 tests passed, 0 failed, 0 skipped, 0 cancelled.
- `npm run demo -- /tmp/yoloharness-qa-events-20260904-2219.jsonl`
  - Exit 0.
  - Output labeled `fixture_only: true`.
  - Result: `status: budget_exhausted`, `steps: 3`, `lastAction: fixture:step-3`.
  - Recovered: `status: budget_exhausted`, `steps: 3`, `seq: 5`, `lastAction: fixture:step-3`.
  - The demo therefore confirms the configured three-step bound and replay on a fresh log.
- Additional QA probe: `node qa-probe.mjs` from `/opt/hermes/workspace/YOLOharness/qa`.
  - Created two events with separate EventLog instances, then attempted a third append after reopening.
  - Result: `reopen_error= Unexpected non-whitespace character after JSON at position 49 (line 2 column 1)`.
  - `authorizeEffect({type:'file.write', path:'..'}, {workspaceRoot:'/workspace/project'})` returned `{"allowed":true,"capability":"workspace.file.write"}`.
  - Nested `sub/ok.txt` returned allowed true; absolute `/etc/passwd` returned allowed false.

Traceable test matrix

1. Bounded loop — PASS (covered by repository test and demo).
   Input maxSteps=2 in test and maxSteps=3 in demo. Expected no adapter-driven extension; actual 2/3 steps followed by budget_exhausted and run_stopped. Boundary maxSteps=0 was not covered by the supplied suite.

2. Replay — PASS on fresh single-run log only.
   Three fixture steps recovered as budget_exhausted, steps=3, seq=5, lastAction=fixture:step-3.
   Residual defect: append/reopen behavior is not safe once the log has multiple JSONL records (see BUG-1); the supplied reopen test only reaches a single prior event before the second EventLog reads the file.

3. Event sequence persistence — PARTIAL/FAIL.
   Supplied single prior-event reopen test passes with seq=2. A real multi-line log reopen fails before a new event can be appended. BUG-1.

4. Default deny — PASS for tested shell and network effects.
   `shell.exec` and `network.request` return allowed=false. README/code also define unknown effects as denied; no live executor is present. The exact unknown-effect case was not separately exercised in the supplied tests.

5. Workspace file policy — FAIL.
   In-bound `notes.txt` and out-of-bound `/etc/passwd` match expected results in the repository tests. However, traversal path `..` with workspaceRoot `/workspace/project` returned allowed=true, authorizing the workspace parent. This contradicts README's stated “path traversal is rejected” guarantee. BUG-2.

6. Fixture-only labeling/provider boundary — PASS for scope.
   Demo emits `fixture_only: true`; README and FixtureAdapter explicitly state deterministic fixture only, not live model execution. No shell, network, OAuth, or external side effect was observed or invoked.

7. OAuth and real Astra — NOT IMPLEMENTED / NOT TESTED.
   Repository search found no Astra integration. README explicitly says there is no OAuth flow, token reading, network access, or deployment configuration. No credentials or network access were used, per task constraints. These claims must not be interpreted as production integration evidence.

Bugs

BUG-1 — EventLog cannot reopen a multi-line JSONL log
Severity: High for persistence/recovery; reproducible functional defect.
Steps:
1. Create an EventLog for a new path and append event `one` for run `r`.
2. Create a separate EventLog for the same path and append event `two` for run `r`.
3. Create a third EventLog for the same path and append event `three` for run `r`.
Expected: append succeeds with seq=3.
Actual: JSON.parse fails with `Unexpected non-whitespace character after JSON at position 49 (line 2 column 1)`.
Likely source location: `prototype/kernel.mjs`, EventLog.append line 18 uses `text.split('\\n')` (literal backslash-n delimiter), while JSONL records are separated by newline.

BUG-2 — `..` traversal is authorized
Severity: High for the stated capability policy.
Steps:
1. Call `authorizeEffect({type:'file.write', path:'..'}, {workspaceRoot:'/workspace/project'})`.
Expected: `{allowed:false}` because the target resolves outside the workspace root.
Actual: `{allowed:true, capability:'workspace.file.write'}`.
Likely source location: `prototype/kernel.mjs`, line 40 path containment expression.

Residual checks / release confidence
- No browser, device, or Playwright check applies: this is a dependency-free Node CLI/kernel spike with no web UI.
- No install, credentials, external network, OAuth, real Astra provider, shell execution, or external write was used.
- Test suite green is insufficient for release confidence because it misses both defects above.
- Scope is limited to the spike; do not claim production readiness.
