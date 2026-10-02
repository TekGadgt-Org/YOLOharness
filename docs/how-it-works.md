# How YOLOharness works

Status: current behavior at commit `5087fa32bbfe959716bf962905bab9d32698d2af`, with proposed changes explicitly marked. This guide is an implementation inventory, not a guarantee that every retained test has been executed on every platform.

## One invocation

The shipped CLI is a one-shot Node 22+ ESM program. `yolo [--json] [-t MINUTES] <prompt>` parses a positive finite time (default 10 minutes), joins prompt tokens, installs SIGINT handling, validates configuration/image/credentials, then launches one Docker runtime (`src/cli.mjs:34-90`). `setup`, `doctor`, `auth`, and `config` are separate commands. `doctor` is local readiness, not provider entitlement or a complete run preflight.

Current sequence:

```text
CLI -> config/image/Docker/auth preflight -> absolute bootstrap deadline
    -> workspace/daemon validation -> owned scratch volume/helpers
    -> host skill snapshot -> framed stdin bootstrap
    -> one runtime container -> provider/tool loop
    -> exact resource reconciliation -> receipt and exit code
```

Setup builds an installation-owned runtime from `assets/runtime/Dockerfile`, records an immutable image ID and source digest in XDG data, and ordinary runs use that image with `--pull=never` (`src/cli.mjs:149-248`). Credentials are stored outside the project. Device OAuth is explicit (`yolo auth login`); only access token and expiry enter the runtime bootstrap. Refresh tokens, client IDs, credential files, and Docker context secrets do not. The production provider endpoint is fixed canonical HTTPS; no live OAuth or entitlement claim is made by the offline test suite (`src/auth.mjs`, `src/provider.mjs`, `src/responses.mjs`).

Configuration is under `$XDG_CONFIG_HOME/yoloharness` (absolute XDG values only; otherwise the home fallback); image and shared skills are under `$XDG_DATA_HOME/yoloharness`. Config v2 stores `model` and `ephemeralPaths`; interactive auth model save currently writes the legacy v1 shape and can discard customized v2 ephemeral paths (`src/cli.mjs:376`, `src/config.mjs:39-55`). This is a release-candidate remediation item.

## Runtime boundary and resources

The launcher selects the executable found on PATH and preserves the caller's Docker context/TLS environment for Docker operations. It fails closed on malformed or unsupported daemon identity. Rootless Linux uses container `0:0` (mapped by the daemon); ordinary rootful Linux uses the invoking numeric UID/GID and supplementary groups; Darwin with a Linux Docker daemon uses `0:0`. Linux userns-remap and unverifiable/non-Linux daemon shapes are rejected (`src/container-launcher.mjs:349-378`). Native Darwin/Colima behavior remains externally unverified.

The current runtime has a read-only image root, dropped capabilities, `no-new-privileges`, bridge networking, 128 PIDs, 512 MiB memory, one CPU, a 64 MiB `noexec,nosuid` `/home/worker` tmpfs, and Docker-managed scratch (`src/resource-policy.mjs`, `src/container-launcher.mjs:83-94`). Bridge networking is general egress, not provider-only allowlisting. Generated code can read the project and access-token material in its runtime boundary; this is not a confidentiality sandbox.

Current storage is a writable host bind at `/workspace` plus exact configured volume subpaths. Defaults are `node_modules`, `.venv`, `vendor`, `.godot`, and `target`; matching is exact relative path, not recursive basename matching or a future-directory watcher. Existing dependency directories are hidden by `volume-nocopy`, not copied into scratch. Only absent empty scaffolds are removed; existing or changed content is retained and reported. The launcher advertises cache variables, but `ContainerProcessExecutor` replaces the child environment and drops those variables while also changing HOME (`src/container-launcher.mjs:26-27,92-93`, `src/container-executor.mjs:30-35`). Do not promise deterministic cache placement until separately fixed and tested.

## Bootstrap, provider, and tools

The host encodes a bounded versioned frame containing prompt, model, absolute deadline, access token/expiry, and full snapshotted skills. The encoded payload is capped at 128 KiB (`src/bootstrap.mjs:3-31`); the runtime's total input limit also includes the frame prefix, so the exact boundary needs a regression test.

The runtime constructs `ConfiguredProvider` and `ResponsesClient`, using the fixed HTTPS endpoint, streamed SSE, bounded response/text/argument sizes, and at most 100 provider turns (`src/container-runtime.mjs`, `src/responses.mjs`, `src/runtime.mjs:74-155`). Tools are only `exec` and `skill_load`. Schemas are closed and bounded: exec argv is shell-free by default but the model can explicitly invoke a shell; command failures are returned for recovery. Output overflow and command timeout currently share code 124. There is no independent acceptance verifier: a provider completion is not proof that the requested work is correct.

The runtime writes events and a final receipt. Events are bounded JSONL with selected redaction/hashing. The final stdout/`last-receipt.json` record can contain raw result, evidence, loaded skill text, and tool output; it is not covered by event redaction. `effect_state: none` means no independently classified uncertain effect, not “no side effects.” Treat receipt data as evidence with provenance, not as a proof of success (`src/events.mjs`, `src/runtime.mjs:99-102,154-155`).

## Skills: discovery, snapshot, and trust

Current discovery scans only:

- `<cwd>/.agents/skills/<name>/SKILL.md` (project-local); and
- `$XDG_DATA_HOME/yoloharness/skills/<name>/SKILL.md`, falling back to `$HOME/.local/share/yoloharness/skills` (shared).

It does not scan the config root, ancestors, `~/.agents`, Hermes profiles, AGENTS/CLAUDE/README files, remote sources, or the whole home directory. Valid immediate skill names are sorted. A local skill wins over a shared skill; local resources are not merged with shared resources. A missing local `SKILL.md` can fall back to shared; an invalid or oversized local file fails rather than silently falling back (`src/skills.mjs:12-63`).

Frontmatter is a deliberately small parser, not general YAML: optional exact `name`/`description` lines, matching directory name, description at most 512 characters. The complete regular-file resource tree is UTF-8 snapshotted with a 64 KiB per-skill/aggregate bound. No script is executed. Snapshot content enters the bootstrap, but the initial model message contains only name/source/description/resource names. `skill_load` returns bounded text as untrusted tool output; it cannot register tools, change mounts, execute resources, or grant authority (`src/skills.mjs:65-115`, `src/runtime.mjs:57-59,104-120`). Prompt injection remains possible because text influences model choices; “not authority” is an executor-boundary statement, not a claim of prompt-injection immunity.

## Deadlines, receipts, and cleanup

`-t` excludes preflight and is not currently a strict end-to-end wall-clock promise. The bootstrap deadline starts just before launch; the launcher has a separate launch-plus-budget timer and a shared approximately 3-second cleanup deadline. Runtime remaining minutes floors to one minute, which can extend a nearly exhausted loop. The launcher timer directly aborts creation, but source inspection does not establish that it terminates an already attached, non-cooperative Docker client (`src/container-runtime.mjs:24-26`, `src/container-launcher.mjs:68-75,101-109,425-450`). These are acceptance-blocking remediation items, not behavior this document silently upgrades.

Intended cleanup is exact and fail-closed: verify run labels/name/ID, stop, kill if needed, remove, poll for absence, reconcile the run-owned volume/helpers, and remove only safe empty scaffolds. Unknown create responses and late resources are reconciled without broad prune. Busy, ownership, parse, transport, and permission uncertainty is retained as `cleanup_unknown`; interrupted runs may preserve evidence. A completion receipt is not an independent verifier. Current implementation writes `.yolo/runs/<run>/events.jsonl` and `.yolo/last-receipt.json`; there is no resume/replay CLI.

## Installation and validation limits

`node install.mjs` installs app assets below the XDG data root, preserves config/credentials/shared skills, and creates `$HOME/.local/bin/yolo`. Uninstall is documented shell, not a command; it removes the exact recorded image and app only after stopping active runs. Do not use broad Docker prune.

`npm test` is the offline suite. `npm run test:docker` is opt-in and selects `real-docker*.test.mjs`; `shipped-preflight.test.mjs` is not included by that glob. Some real-Docker tests simulate identity/platform and do not prove native rootful Linux or macOS. No live provider/OAuth entitlement, native Darwin staging, or secure copy-back has been validated in this documentation task. See test references in `test/integration.test.mjs`, `test/container-launcher.test.mjs`, `test/real-docker*.test.mjs`, `test/volume-reconciliation.test.mjs`, and `test/install-skills.test.mjs`.

## Proposed containment architecture (not implemented)

The current writable bind has an acceptance-blocking bypass: creating `/workspace/neobrui-vite/node_modules` writes to the host because only `/workspace/node_modules` is mounted. Offline rootless fixtures reproduced the same leak for all five defaults (`node_modules`, `.venv`, `vendor`, `.godot`, `target`). Exact mounts cannot cover arbitrary descendants created after container startup; prompt instructions and package-manager wrappers are not security boundaries.

Preferred design: seed one run-owned Docker workspace volume before execution; give the untrusted runtime only that volume at `/workspace` (no writable host bind); after all writers are stopped and verified absent, use a fresh trusted network-disabled read-only exporter and an independently validating host publisher. Match dependency names at any path depth, preserve source/manifests/lockfiles/intended outputs outside exclusions, and preserve pre-existing host dependency trees rather than deleting them. The publisher must use no-follow, descriptor-anchored operations, reject symlink/hardlink/special-file/race ambiguity, compare a bounded baseline, and apply conflict-aware creates/replacements/deletions. Never use `rsync --delete` or trust an agent archive. Unsupported ownership/ACL/filesystem cases fail closed.

Proposed lifecycle:

```text
preflight -> journaled -> volume_created -> seeded -> running -> quiescing
 -> frozen -> export_validated -> publish_prepared -> publishing -> published
 -> resources_removed -> complete
```

Unknown publication or cleanup enters retained recovery with `effect_state: uncertain`; no false success and no promise of immediate volume erasure after crash. A journal records exact daemon, image, policy, volume/helper identities and phase. Recovery/discard must be explicit and provider-free. The design preserves source but intentionally makes host changes visible only after final publication; outputs under excluded names require a separate trusted artifact policy. Rootless Linux primitives were exercised narrowly; rootful Linux and Darwin/Colima, secure publisher races, crash recovery, ownership/ACLs, and full end-to-end CLI acceptance remain gates.

Proposed migration adds versioned recursive `ephemeralNames` while retaining anchored legacy `ephemeralPaths`; it must not silently reinterpret old paths or removed defaults. Add explicit recovery commands and expose effective policy/limits. No writable-bind fallback is acceptable.

## Proposed feedback and memory (not approved)

The recommended future flag is `--feedback`, not `--eval`. It is host-only, record-only, and collected after verified container cleanup and baseline receipt persistence; it never starts a second provider turn or extends execution. Non-TTY use is rejected before Docker. A 60-second input/confirmation timeout, one UTF-8 line capped at 4 KiB, and explicit project-save confirmation are recommended defaults. Empty/EOF skips; Ctrl-C preserves the execution result and reports cancellation.

Local artifact: `<cwd>/.yolo-feedback-<host-invocation-uuid>.md`, mode 0600, with versioned metadata and a literal untrusted feedback block. Central store: `${dataRoot()}/memory/store.json`, mode 0600, bounded versioned JSON, project-scoped by canonical cwd plus directory identity, 90-day expiry, at most 200 entries/1 MiB per scope and 1,000/4 MiB total. Writes are lock/read/validate/add/prune/atomic replace with fsync; malformed or unsafe stores are not repaired automatically. `--memory=off|project|global|all` would default to off; global promotion/use requires separate approval. Inject only a bounded separate user-role JSON context item, never developer instructions or a skill, and record omitted entries/provenance. Feedback and memory are untrusted data and cannot grant authority or erase policy.

Decisions Ryan must make before implementation: accept post-teardown collection; record-only versus revision turn; opt-in future reads versus automatic project injection; and cwd-visible plaintext versus private-only feedback. These are recommendations, not authorization. The existing `memory/memory-design.md` is a broader proposal and does not describe shipped behavior.

## References

Primary source files: `src/cli.mjs`, `src/config.mjs`, `src/auth.mjs`, `src/bootstrap.mjs`, `src/container-launcher.mjs`, `src/container-runtime.mjs`, `src/container-executor.mjs`, `src/runtime.mjs`, `src/skills.mjs`, `src/events.mjs`. External primitive references used by the design: Docker bind/volume documentation, `openat2(2)`, `inotify(7)`, XDG Base Directory Specification, and Node.js v22 filesystem documentation. External references support primitive cautions; they do not validate the proposed implementation.
