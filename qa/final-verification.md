# Final coordinator verification

2026-09-04 UTC. This report supplements—not erases—the independent initial failure report in `qa-report.md`.

## Result

**PASS for the repaired deterministic spike's exercised acceptance paths. Not a live harness or a security certification.**

Executed from `prototype/`:

```sh
npm test
npm run demo -- ../qa/final-demo.jsonl
npm run demo -- ../qa/final-demo.jsonl
node ../qa/qa-probe.mjs
```

The chained command exited **0**. Full real output is in [final-execution.txt](final-execution.txt).

- **7 tests passed; 0 failed, skipped, or cancelled.**
- Both demos completed against the same JSONL file with `fixture_only: true`, `budget_exhausted`, 3 steps, and recovered sequence 5 for each separate run.
- The independent QA probe now reopens a multi-line log and appends sequence 3 successfully.
- Exact parent path `..` now returns `allowed: false`; a nested path returns true; absolute `/etc/passwd` returns false.

## What changed after initial QA

The initial 5-test suite was green, but coordinator and independent QA probes reproduced two defects: splitting a reopened JSONL log on literal backslash-n, and authorizing an exact parent-directory path. Backend corrected both and added regression coverage. This is why initial worker self-reports and green narrow tests were not treated as completion proof.

Initial report `qa-report.md` intentionally remains a historical FAIL snapshot. This report records the coordinator's post-repair rerun, not a claim that the original reviewer independently re-reviewed the patch.

## Boundaries still unverified or absent

- The adapter is a trusted deterministic fixture, not Astra. No live model, OAuth, official Codex process, tool executor, or real external effect was invoked.
- The step budget is exercised for the cooperative fixture; it is not a timeout, sandbox, or defense against an adapter mutating state/hanging.
- File policy is lexical-only and disconnected from execution. Symlinks, races, and hostile code require an actual OS boundary before any confinement claim.
- JSONL replay reconstructs recorded state, not crash-safe task resumption or exactly-once effects. Concurrency, torn writes, hostile/corrupt logs, and production durability are not established.
- SQLite memory/context compilation and the proposed `yolo` command remain designs.
- Tested on this Linux host with Node v22.23.2. No native macOS or Windows verification.
- No package or system install, credential change, Git push, deployment, or publication was performed.

The architecture, source comparison, threat model, memory contract, and operator UX were read by the coordinator; cross-document decisions are reconciled in the root README. Public Codex app-server documentation and the checked source snapshot support the planned managed OAuth route, but do not establish account/model entitlement or live compatibility.
