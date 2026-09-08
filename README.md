# YOLOharness

**YOLO in the sandbox; receipts at the boundary.**

A ten-minute experiment in the harness Astra would choose for itself: a small, inspectable working environment that knows what it knows, preserves unfinished work, and makes experiments cheap without making external consequences casual.

## Current direction

A thin, container-first, one-shot agent: `yolo "<prompt>"` or `yolo -t <minutes> "<prompt>"`. Ordinary runs execute the provider, planner, parser, dispatch, and generated commands inside Docker. On a rootless Linux daemon, the container uses UID/GID 0:0 because container root maps to the invoking host user. On standard rootful Linux Docker, it uses the invoking host UID/GID and numeric supplementary groups so files in the project bind remain owned by the invoker; `/home/worker` and `/tmp` are selected-identity-owned mode 0700 tmpfs mounts. On macOS, a Docker-compatible runtime that reports Linux containers (such as Colima or Docker Desktop) is a v0.1.1 candidate pending native validation; it uses container UID/GID 0:0 with no macOS host groups. A host-root invocation therefore may create host-root-owned files. Native Linux user-namespace-remapped daemons and non-Linux or unverifiable daemon shapes fail closed. The selected project path must be mountable/shareable by the chosen macOS runtime. The host process is only a bounded launcher/supervisor; deterministic fixtures exist only in the non-shipped test harness. No host chmod/chown or ACL preparation is performed; the launcher never chmods or chowns the project. The selected Docker daemon is trusted host infrastructure, and rootful Docker access is already host-privileged; this distinction does not change the model/container restrictions.

Run `yolo setup` to build the installation-owned runtime image and store its immutable local image ID plus source digest/version (`{version:1,imageId,sourceDigest,sourceVersion}`) under `$XDG_DATA_HOME/yoloharness/image.json` (or `$HOME/.local/share/yoloharness/image.json`). Ordinary runs use that exact ID with `--pull=never`. The selected project is the only host bind at `/workspace`; the runtime has a read-only root, dropped capabilities, bounded tmpfs/resource limits, and network egress for provider traffic. Project contents and the in-container access token are intentionally not treated as confidential from generated code.

The shared runtime resource policy is intentionally bounded and platform-neutral: `/tmp` is a 256 MiB noexec/nosuid tmpfs, `/home/worker` is a 64 MiB noexec/nosuid tmpfs, memory is capped at 512 MiB, CPU at 1, and processes at 128. The 256 MiB scratch limit was selected from an offline local-package install probe: a 70 MiB test package used 74,308 KiB peak `/tmp`, 0 KiB in `/home/worker`, and completed under the 512 MiB memory cap; the same package-manager fixture exceeded the former 64 MiB boundary with `ENOSPC`. These are container limits, not host-disk cleanup guidance; tmpfs exhaustion, memory OOM, command timeout, and the outer run deadline remain distinct failure conditions in receipts.

## Direct provider setup (explicit opt-in)

Authentication is separate from a run and never starts automatically. Run `yolo auth login`; device authentication uses the built-in public Codex client configuration and credentials are stored at `$XDG_CONFIG_HOME/yoloharness/credentials.json` (or `YOLO_AUTH_FILE`) outside the project with mode 0600. In an interactive terminal, login asks `Model name?` after authentication and stores non-secret configuration at `$XDG_CONFIG_HOME/yoloharness/config.json`; Enter retains an existing model. Noninteractive login never waits for model input. You can set or change it independently with `yolo config set model <model-id>`. At run time, an explicit `YOLO_MODEL` overrides the saved model without changing it. `yolo auth status` reports only local presence/expiry and `yolo auth logout` removes local credentials; it does not claim remote revocation. Production runs use the installation-owned canonical HTTPS Responses endpoint; the endpoint is not selectable through environment variables. Loopback HTTP providers are available only through explicit test construction with synthetic credentials; the production CLI never routes stored bearer credentials to arbitrary endpoints. No live OAuth, entitlement, Docker isolation, or native macOS execution has been verified in this repository.

## What is here

- **[DESIGN.md](DESIGN.md):** the opinionated architecture and build plan. Start here.
- **[src/](src/):** bounded one-shot CLI/runtime. Ordinary runs are container-only and fail closed when setup, credentials, or the immutable image is unavailable.

## Install and run (Linux MVP; macOS Docker-compatible Linux VM candidate)

WARNING: Run in a fresh, disposable directory. The agent can overwrite or delete anything in the working directory without asking. Using it on an existing project is at your own risk; back up or commit your work first. Keep secrets out of the directory: networked generated code can send project contents out, and Docker does not protect files inside the mounted project.

Node 22+ and Docker are prerequisites. From a downloaded package directory (or an extracted `yoloharness-0.1.1.tgz`), install to the user account; this never uses sudo, a global prefix, or shell startup files:

1. Install: `node install.mjs`
2. Add `$HOME/.local/bin` to PATH: `export PATH="$HOME/.local/bin:$PATH"` (persist this yourself if desired).
3. Check offline readiness: `yolo doctor`.
4. In a fresh disposable project, run `yolo setup`.
5. Authenticate: `yolo auth login`.
6. Set a model if needed: `yolo config set model <model-id>`.
7. Run: `yolo -t 10 "verify the harness"` (or `yolo "verify the harness"`).

`yolo doctor` performs no provider call and reports Docker executable, runtime image metadata, built-in device-auth client readiness, local credentials, and model status.

The installer atomically replaces only app assets below `${XDG_DATA_HOME:-$HOME/.local/share}/yoloharness`, preserves config, credentials, and shared skills, and creates `$HOME/.local/bin/yolo`. It refuses symlinked or non-directory data/bin destinations. Back up or commit the selected project first: the agent can overwrite or delete files there, and networked generated code may disclose them.

## Uninstall

YOLOharness does not have an uninstall command yet. Stop any active `yolo` run before removing it.

These Bash commands remove the launcher, installed app, image metadata, and the exact Docker image recorded by `yolo setup`. They keep your credentials, model setting, and shared skills so a later reinstall can reuse them. If you want to purge credentials too, run `yolo auth logout` now, before removing the launcher. Logout only deletes the local credential file; it does not remotely revoke the OAuth token.

```bash
case ${XDG_DATA_HOME:-} in
  /*) data_home=$XDG_DATA_HOME ;;
  *) data_home="$HOME/.local/share" ;;
esac
case ${XDG_CONFIG_HOME:-} in
  /*) config_home=$XDG_CONFIG_HOME ;;
  *) config_home="$HOME/.config" ;;
esac
app_root="$data_home/yoloharness"
config_root="$config_home/yoloharness"
launcher="$HOME/.local/bin/yolo"
image_metadata="$app_root/image.json"
expected_launcher="$app_root/app/src/cli.mjs"

printf 'launcher: %s\napp data: %s\nconfig: %s\n' \
  "$launcher" "$app_root" "$config_root"

if [ -f "$image_metadata" ]; then
  image_id="$(node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!/^sha256:[0-9a-f]{64}$/i.test(value.imageId)) process.exit(2);
    process.stdout.write(value.imageId);
  ' "$image_metadata")" || {
    printf 'Refusing to remove an image: %s is malformed.\n' "$image_metadata" >&2
    exit 1
  }
  docker image rm "$image_id" || {
    printf 'Image removal failed; keeping installation metadata.\n' >&2
    exit 1
  }
fi

if [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$expected_launcher" ]; then
  rm -- "$launcher"
elif [ -e "$launcher" ] || [ -L "$launcher" ]; then
  printf 'Refusing to remove unexpected launcher: %s\n' "$launcher" >&2
  exit 1
fi

[ ! -e "$app_root/app" ] || rm -r -- "$app_root/app"
rm -f -- "$image_metadata"
rmdir "$app_root" 2>/dev/null || true
hash -r
```

`docker image rm` fails rather than forcing removal if another container still uses that image. Inspect and stop the container before retrying; do not replace it with a forced broad cleanup.

To finish a full purge after logging out above, delete the saved model, remaining configuration, and shared skills:

```bash
[ ! -e "$config_root" ] || rm -r -- "$config_root"
[ ! -e "$app_root" ] || rm -r -- "$app_root"
```

If you configured `YOLO_AUTH_FILE`, logout removes that custom file; deleting `$config_root` alone does not.

The installer does not edit shell startup files. If you manually added `$HOME/.local/bin` to PATH solely for YOLOharness, remove that edit yourself. Do not remove it when other user-installed commands depend on the same directory.

Each project keeps its own run receipts. From a project you have checked carefully, remove only those receipts with:

```bash
pwd
rm -r -- .yolo
```

This does not remove files the agent created elsewhere in that project.

For development, run `npm test`; no package dependencies are required.

The opt-in real-Docker gate requires the installation-owned whole-runtime image and a Docker daemon: `npm run test:docker`. The retained tests under `test/` are the source of truth for shipped-CLI/provider, workspace-boundary, token-secrecy, resource, deadline, SIGINT, and cleanup behavior. The default `npm test` remains offline and skips real Docker. Native macOS validation with a Docker-compatible Linux VM runtime remains a separate, explicitly unrun gate; Linux synthetic tests do not prove native macOS success.

Agent Skills are discovered only from `<cwd>/.agents/skills/<name>/SKILL.md` and `${XDG_DATA_HOME:-$HOME/.local/share}/yoloharness/skills/<name>/SKILL.md`; project skills override shared skills. Names, traversal, symlinks, special files, and bundled resources are bounded and validated. A catalog and bounded snapshots enter the container; `skill_load` content is instructions/data, never authority, and there is no ancestor, Hermes-profile, or remote discovery. Runs write bounded, redacted JSONL receipts below `.yolo/runs/`. Native macOS Docker-compatible Linux VM runs, live OAuth/provider calls, and non-Linux installation are unverified limits of this MVP.

`SKILL.md` may be plain text (metadata description is `null`) or begin with a small YAML-style frontmatter block. This MVP intentionally supports the bounded subset of exactly non-empty `name` and `description` fields; other Agent Skills frontmatter keys are rejected. The name must match the directory, and descriptions are limited to 512 characters; malformed or mismatched metadata is rejected. The provider receives only bounded catalog metadata first (including source `local` or `shared` and resource names), encoded as a standard developer message item accepted by the Responses API, then requests instruction/resource content progressively.

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
- Official `codex` CLI was **not found on PATH** at initial inspection. Ryan would need to install an official supported version before live integration.
- Authenticate through the official Codex client with an eligible account. Existing Hermes OAuth does not establish that a separate client is authenticated, and we will not copy token files.
- Verify the desired model is actually exposed to that account/client. This project makes no claim that the model alias used by Hermes maps directly to the public CLI.
- Verify supported sandbox/approval controls in the exact client version. A cwd or a lexical path check is not an OS sandbox. Any additional platform sandbox prerequisite must be documented before installation.

## Scope and provenance

Created for Ryan's ~10-minute hallucination challenge on 2026-09-04. Work used the configured researcher (Astra), backend/data/frontend/maintainability/QA/performance profiles (Luna), security profile (Sol), and orchestrator (Astra). A dedicated `yoloharness` Kanban board records work and review.

Public documentation is cited; proprietary or unreleased OpenAI implementation details are unknown. Architecture choices are hypotheses, not claims that this design has been proven optimal. No production implementation, live OAuth/model turn, push, deployment, or publication is authorized by this plan.
