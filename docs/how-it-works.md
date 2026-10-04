# How YOLOharness works

Status: current behavior at the checked-out implementation. This guide is an implementation inventory, not a guarantee that every retained test has been executed on every platform.

## One invocation

The shipped CLI is a one-shot Node 22+ ESM program. `yolo [--json] [-t MINUTES] <prompt>` parses a positive finite time (default 10 minutes), joins prompt tokens, installs SIGINT handling, validates configuration/image/credentials, then launches one Docker runtime (`src/cli.mjs:34-90`). `setup`, `doctor`, `skills`, `uninstall`, `auth`, and `config` are separate commands. `doctor` is local readiness, not provider entitlement or a complete run preflight.

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

The launcher selects the executable found on PATH and preserves the caller's Docker context/TLS environment for Docker operations. It fails closed on malformed or unsupported daemon identity. Rootless Linux uses container `0:0` (mapped by the daemon); ordinary rootful Linux uses the invoking numeric UID/GID and supplementary groups; Darwin with a Linux Docker daemon uses `0:0`. Linux userns-remap and unverifiable/non-Linux daemon shapes are rejected (`src/container-launcher.mjs:349-378`). A user-executed ARM64 macOS/Colima run succeeded; repository automation does not prove every native macOS runtime or filesystem behavior, and Docker Desktop has not been validated.

The current runtime has a read-only image root, dropped capabilities, `no-new-privileges`, bridge networking, 128 PIDs, 512 MiB memory, one CPU, a 64 MiB `noexec,nosuid` `/home/worker` tmpfs, and Docker-managed scratch (`src/resource-policy.mjs`, `src/container-launcher.mjs:83-94`). Bridge networking is general egress, not provider-only allowlisting. Generated code can read the project and access-token material in its runtime boundary; this is not a confidentiality sandbox.

Runtime workspace storage is now a run-owned Docker volume mounted at `/workspace`; the untrusted runtime receives no writable host workspace bind. A network-disabled seed helper copies the host workspace into the volume before execution, filtering configured dependency directory names recursively at any depth. A separate network-disabled publisher runs after runtime quiescence and copies durable files back create-only, preserves excluded host trees, and fails closed on durable conflicts. Defaults remain `node_modules`, `.venv`, `vendor`, `.godot`, and `target`; configured entries are treated as dependency basenames at arbitrary depth. The publisher is intentionally conservative: unsupported file types, races, and ambiguous ownership are errors rather than silent overwrite.

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

`-t` is one immutable total wall-clock deadline. The launcher uses that same absolute deadline for Docker creation, attached execution, and hard abort. The runtime reserves a bounded finalization window for its final response, container stop, and create-only publication; before every provider turn it replaces a single remaining-time notice, and the initial instructions require an early runnable baseline, continuous saves, and final verification. Cleanup has its own bounded grace after the hard deadline; timeout/interruption receipts are uncertain and may be partial (`src/container-runtime.mjs`, `src/runtime.mjs`, `src/container-launcher.mjs`).

Intended cleanup is exact and fail-closed: verify run labels/name/ID, stop, kill if needed, remove, poll for absence, reconcile the run-owned volume/helpers, and remove only safe empty scaffolds. Docker volumes are reconciled and removed only after exact name/label ownership verification, including uncertain create and interrupted-run paths. Busy, ownership, parse, transport, and permission uncertainty is retained as `cleanup_unknown`; interrupted runs may preserve evidence. A completion receipt is not an independent verifier. Current implementation writes `.yolo/runs/<run>/events.jsonl` and `.yolo/last-receipt.json`; runtime receipt persistence, publication, and launcher finalization are the single receipt authority, and there is no resume/replay CLI.

## Installation and validation limits

`node install.mjs` installs app assets below the XDG data root, preserves config/credentials/shared skills, and creates `$HOME/.local/bin/yolo`. The exact installed launcher provides `yolo uninstall`: it removes that launcher, installation-owned app, image metadata, and the exact immutable Docker image recorded by setup. Credentials, model configuration, shared skills, projects, shell startup files, volumes, and unrelated images are preserved. Image-removal failure stops before deletion so the command can be retried; it does not force removal or use broad Docker prune (`src/uninstaller.mjs`, `src/cli.mjs`).

`npm test` is the offline suite. `npm run test:docker` is opt-in and selects `real-docker*.test.mjs`; `shipped-preflight.test.mjs` is not included by that glob. Some real-Docker tests simulate identity/platform and do not prove native rootful Linux or every macOS behavior. A user-executed ARM64 macOS/Colima run succeeded, but native rootful Linux validation and repository-automated native macOS coverage remain external. No live provider/OAuth entitlement was validated in this documentation task. See test references in `test/integration.test.mjs`, `test/container-launcher.test.mjs`, `test/real-docker*.test.mjs`, `test/volume-reconciliation.test.mjs`, and `test/install-skills.test.mjs`.

## Workspace containment architecture

The previous writable bind bypass is closed: creating `/workspace/neobrui-vite/node_modules` stays in Docker-managed storage because the untrusted runtime sees only the staged workspace volume. Dependency names are filtered recursively at arbitrary depth; source, manifests, lockfiles, configuration, and intended outputs outside those names are published create-only back. The selected cwd must be empty before Docker discovery or authentication. Existing host entries are never copied over, overwritten, renamed, chmodded, or deleted; interruption can leave retained partial output.

Lifecycle:

```text
preflight -> volume_created -> seeded -> running -> quiescing
 -> frozen -> export_validated -> publishing -> published
 -> resources_removed -> complete
```

Unknown publication or cleanup enters `effect_state: uncertain`; no false success and no promise of whole-tree atomicity. Publication is create-only into the originally selected empty directory. If interruption or conflict occurs after output creation, the partial output is retained and the user must inspect or delete the directory before retrying. There is no journal, merge, recovery, inspect, or discard command. The runtime preserves recursive dependency exclusions while retaining source, manifests, lockfiles, configuration, and intended outputs.

The runtime retains the existing versioned `ephemeralPaths` policy; no migration is performed here. Optional feedback and memory remain unimplemented and are not part of publication recovery.

## Proposed feedback and memory (not approved)

The recommended future flag is `--feedback`, not `--eval`. It is host-only, record-only, and collected after verified container cleanup and baseline receipt persistence; it never starts a second provider turn or extends execution. Non-TTY use is rejected before Docker. A 60-second input/confirmation timeout, one UTF-8 line capped at 4 KiB, and explicit project-save confirmation are recommended defaults. Empty/EOF skips; Ctrl-C preserves the execution result and reports cancellation.

Local artifact: `<cwd>/.yolo-feedback-<host-invocation-uuid>.md`, mode 0600, with versioned metadata and a literal untrusted feedback block. Central store: `${dataRoot()}/memory/store.json`, mode 0600, bounded versioned JSON, project-scoped by canonical cwd plus directory identity, 90-day expiry, at most 200 entries/1 MiB per scope and 1,000/4 MiB total. Writes are lock/read/validate/add/prune/atomic replace with fsync; malformed or unsafe stores are not repaired automatically. `--memory=off|project|global|all` would default to off; global promotion/use requires separate approval. Inject only a bounded separate user-role JSON context item, never developer instructions or a skill, and record omitted entries/provenance. Feedback and memory are untrusted data and cannot grant authority or erase policy.

Decisions Ryan must make before implementation: accept post-teardown collection; record-only versus revision turn; opt-in future reads versus automatic project injection; and cwd-visible plaintext versus private-only feedback. These are recommendations, not authorization. The existing `memory/memory-design.md` is a broader proposal and does not describe shipped behavior.

## References

Primary source files: `src/cli.mjs`, `src/config.mjs`, `src/auth.mjs`, `src/bootstrap.mjs`, `src/container-launcher.mjs`, `src/container-runtime.mjs`, `src/container-executor.mjs`, `src/runtime.mjs`, `src/skills.mjs`, `src/events.mjs`. External primitive references used by the design: Docker bind/volume documentation, `openat2(2)`, `inotify(7)`, XDG Base Directory Specification, and Node.js v22 filesystem documentation. External references support primitive cautions; they do not validate the proposed implementation.
