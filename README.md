# YOLOharness

**YOLO in the sandbox; receipts at the boundary.**

A ten-minute experiment in the harness Astra would choose for itself: a small, inspectable working environment that knows what it knows, preserves unfinished work, and makes experiments cheap without making external consequences casual.

## Current direction

A thin, container-first, one-shot agent: `yolo "<prompt>"` or `yolo -t <minutes> "<prompt>"`. Ordinary runs execute the provider, planner, parser, dispatch, and generated commands inside one rootless Docker container using the approved rootless-only UID/GID 0:0 mapping; rootful or unknown Docker is rejected. The host process is only a bounded launcher/supervisor; deterministic fixtures exist only in the non-shipped test harness. No host chmod/chown or ACL preparation is performed; the launcher never chmods or chowns the project.

Run `yolo setup` to build the installation-owned runtime image and store its immutable local image ID plus source digest/version (`{version:1,imageId,sourceDigest,sourceVersion}`) under `$XDG_DATA_HOME/yoloharness/image.json` (or `$HOME/.local/share/yoloharness/image.json`). Ordinary runs use that exact ID with `--pull=never`. The selected project is the only host bind at `/workspace`; the runtime has a read-only root, dropped capabilities, bounded tmpfs/resource limits, and network egress for provider traffic. Project contents and the in-container access token are intentionally not treated as confidential from generated code.

## Direct provider setup (explicit opt-in)

Authentication is separate from a run and never starts automatically. Set a permitted `YOLO_CLIENT_ID`, then run `yolo auth login`; credentials are stored at `$XDG_CONFIG_HOME/yoloharness/credentials.json` (or `YOLO_AUTH_FILE`) outside the project with mode 0600. In an interactive terminal, login asks `Model name?` after authentication and stores non-secret configuration at `$XDG_CONFIG_HOME/yoloharness/config.json`; Enter retains an existing model. Noninteractive login never waits for model input. You can set or change it independently with `yolo config set model <model-id>`. At run time, an explicit `YOLO_MODEL` overrides the saved model without changing it. `yolo auth status` reports only local presence/expiry and `yolo auth logout` removes local credentials; it does not claim remote revocation. Production runs use the installation-owned canonical HTTPS Responses endpoint; the endpoint is not selectable through environment variables. Loopback HTTP providers are available only through explicit test construction with synthetic credentials; the production CLI never routes stored bearer credentials to arbitrary endpoints. No live OAuth, entitlement, Docker isolation, or native macOS execution has been verified in this repository.

## What is here

- **[DESIGN.md](DESIGN.md):** the opinionated architecture and build plan. Start here.
- **[research/findings.md](research/findings.md):** source-first comparison of public Codex, Hermes, and OpenClaw; Codex OAuth integration feasibility.
- **[prototype/](prototype/):** historical dependency-free fixture kernel, runnable demo, and tests. **Not a live AI agent.**
- **[src/](src/):** bounded one-shot CLI/runtime. Ordinary runs are container-only and fail closed when setup, credentials, or the immutable image is unavailable.
- **[memory/memory-design.md](memory/memory-design.md):** provenance, scope, expiry, contradictions, compaction, and forgetting.
- **[security/threat-model.md](security/threat-model.md):** adversarial design review and concrete negative tests, not a security certification.
- **[ux/interaction-design.md](ux/interaction-design.md):** proposed `yolo` CLI and explicitly mocked operator screens. The shipped CLI supports only the bounded container path and explicitly configured provider paths.
- **[qa/maintainability.md](qa/maintainability.md):** the argument against rebuilding what Codex/Hermes already do.
- **[qa/qa-report.md](qa/qa-report.md):** independent initial QA (historical FAIL; both reproduced bugs were repaired).
- **[qa/final-verification.md](qa/final-verification.md):** coordinator's post-repair rerun: **7 tests pass**, repeated same-log demos succeed, and both bug probes pass; raw output retained.
- **[qa/performance-plan.md](qa/performance-plan.md):** performance and context/delegation evaluation proposal.

## Run the real code

WARNING: Run in a fresh, disposable directory. The agent can overwrite or delete anything in the working directory without asking. Using it on an existing project is at your own risk; back up or commit your work first. Keep secrets out of the directory: networked generated code can send project contents out, and Docker does not protect files inside the mounted project.

From the project directory, with Node 22+ available:

```sh
npm test
npm exec -- yolo "verify the harness"
```

The opt-in real-Docker gate requires the installation-owned whole-runtime image and a Docker daemon: `npm run test:docker`. The retained WRC suite is the source of truth for shipped-CLI/provider, workspace-boundary, token-secrecy, resource, deadline, SIGINT, and cleanup evidence; see [qa/phase1-acceptance-matrix.md](qa/phase1-acceptance-matrix.md). The default `npm test` remains offline and skips real Docker. Native macOS is a separate, explicitly unrun gate.

No package installation is needed; only Node builtins are used. Runs write bounded, redacted JSONL receipts below `.yolo/runs/`. A deadline or interrupt stops launching new effects, then waits up to the bounded cleanup grace for an already-running executor; if exact cleanup cannot be proven in that grace, the receipt reports `cleanup_unknown` rather than claiming the effect stopped. Replay is not full agent resumption, and no executor is enabled by default.

## The design in one minute

- **Borrow execution, build continuity.** Official Codex app-server owns OAuth and its inner agent loop; a thin layer owns tasks, evidence, context selection, and operator control.
- **Compile context, don't hoard it.** Stable prefix, task-local retrieval, bounded results, explicit manifests, and recoverable checkpoints.
- **Remember with provenance.** Every fact has a scope, source, age, and lifecycle. Summaries are indexes, not truth. Memory cannot grant authority.
- **Make experiments disposable.** Focus mode by default; bounded isolated hypothesis branches when they can reduce uncertainty.
- **Treat completion as a checked state.** Tests, artifacts, and external receipts—not another agent's confident sentence.
- **Keep the option to stop.** Compare against stock Codex and Hermes. If this layer doesn't earn its maintenance, implement the useful pieces as a Hermes extension instead.

## Reconciled design decisions

The main design is authoritative where specialist proposals differ:

- Product name `YOLOharness`; proposed command `yolo`; Astra is a model, not our executable name.
- Node ESM with no dependencies for this throwaway spike; TypeScript for a possible production implementation.
- JSONL for the spike; SQLite transactions plus JSONL export for the proposed task/memory store. No vector database initially.
- Local single-user CLI first; no gateway, website, multi-tenant access system, or always-on server in this build.
- One Codex adapter, not a universal provider/plugin framework. Runtime schema/model capability discovery before asserting control over Codex internals.
- Candidate memory promotion requires an explicit acceptance path; add `promotion_status: proposed | accepted | rejected` separately from lifecycle `status: active | superseded | expired | forgotten | quarantined`. Only accepted, active, authorized, unexpired records are eligible for ordinary retrieval. Confidence values are source/model assessments, not calibrated probabilities. Heuristic injection detection is defense-in-depth, never proof content is safe.
- Production effect state distinguishes `unknown` outcomes; no automatic replay of irreversible actions.
- OAuth dollar cost is `unknown` without real metering; UI numbers are only mock design examples.
- Local hash chains can detect accidental corruption and some edits, but cannot stop an attacker who can rewrite the entire database. SQLite does not provide a server-style insert-only database role; enforce writes in application transactions under an appropriate filesystem/process boundary.
- Forgetting requires removal from derived indexes/summaries and retention-controlled content storage, not just an immutable log full of undeletable personal data. Whole-device secure deletion is not promised.

## Prerequisites for a later live integration

No system installs or credential changes were performed for this jam.

- Node was available on the execution host (v22.23.2). No native macOS execution was performed.
- Official `codex` CLI was **not found on PATH** at initial inspection. Ryan would need to install an official supported version before live integration; see the research document's primary-source installation/auth references.
- Authenticate through the official Codex client with an eligible account. Existing Hermes OAuth does not establish that a separate client is authenticated, and we will not copy token files.
- Verify the desired model is actually exposed to that account/client. This project makes no claim that the model alias used by Hermes maps directly to the public CLI.
- Verify supported sandbox/approval controls in the exact client version. A cwd or a lexical path check is not an OS sandbox. Any additional platform sandbox prerequisite must be documented before installation.

## Scope and provenance

Created for Ryan's ~10-minute hallucination challenge on 2026-09-04. Work used the configured researcher (Astra), backend/data/frontend/maintainability/QA/performance profiles (Luna), security profile (Sol), and orchestrator (Astra). A dedicated `yoloharness` Kanban board records work and review.

Public documentation is cited; proprietary or unreleased OpenAI implementation details are unknown. Architecture choices are hypotheses, not claims that this design has been proven optimal. No production implementation, live OAuth/model turn, push, deployment, or publication is authorized by this plan.
