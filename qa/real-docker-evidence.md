# Real Docker phase1 gate evidence

Run date: 2026-09-05 18:02 UTC
Docker server: 29.8.0, context `rootless`
Image: `yoloharness-local:0.1.0`, immutable ID `sha256:0ef6dd2d0d2acd040fd8b04ef547b4a8a1cfa35f88b9ce49497a169c6ce32824`, rebuilt locally from `assets/runtime/Dockerfile` after the whole-runtime changes.

Commands:

- `docker build -f assets/runtime/Dockerfile -t yoloharness-local:0.1.0 .`
- `YOLO_REAL_DOCKER=1 YOLO_DOCKER_IMAGE=yoloharness-local:0.1.0 node --test test/real-docker.test.mjs`
- `npm test`

Result: real-Docker gate 2 passed, 0 failed, 0 skipped; full suite 72 passed, 0 failed, 2 skipped.

Exact real-Docker test names:

- `shipped CLI runs the whole runtime in the configured immutable image against an isolated synthetic provider` — PASS.
- `final image has a read-only root and rootless UID0 workspace write/delete canary` — PASS.

Observed through the shipped `main`/`ContainerLauncher` path and the final image:

- The synthetic provider ran in a separate container attached only to a per-test Docker network; it captured the request nonce, remote container address, and provider PID.
- The first provider request produced a tool call; the runtime executed `printf` inside the whole-runtime container; the second provider request contained the paired function-call output and returned `whole-runtime-ok`.
- The shipped CLI path selected the configured immutable image ID from synthetic image metadata, while access/refresh credentials and XDG configuration remained in isolated temporary directories. No canonical external provider request was made.

- Preflight returned Docker server version `29.8.0`, with daemon security option `name=rootless`.
- The whole-runtime container was created with `--pull=never`, read-only root, dropped capabilities, no-new-privileges, bounded PID/memory/CPU limits, bounded `/tmp` and synthetic-home tmpfs, and exactly one writable `/workspace` bind. The image canary observed `/app` as read-only and confirmed write/delete on the project bind.
- Cleanup left no owned provider or runtime containers in `docker ps -a`.
- The offline launcher regression `uncertain create waits for stable absence and removes a delayed daemon container` passed: exact name+label reconciliation observed a delayed ID, removed it, verified not-found, and required stable absence.

The test is opt-in because it requires a Docker daemon and prebuilt image. It uses only synthetic credentials/config and a local Docker-network provider; no live OAuth/provider request or real credential was used. Rootless behavior is daemon/kernel dependent. WRC-02 through WRC-21 rows not listed as PASS in `qa/phase1-acceptance-matrix.md` remain unrun or partial, and native macOS remains untested. This evidence is not a claim that the remaining amended WRC-01..20 rows passed.
