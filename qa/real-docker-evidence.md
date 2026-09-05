# Real Docker phase1 gate evidence

Run date: 2026-09-05 20:02 UTC
Docker server: 29.8.0, context `rootless`
Kernel: `6.8.0-138-generic`; cgroup version 2; rootless security option observed; storage `overlayfs`.
Base image: `yoloharness-local:0.1.0`, immutable ID `sha256:e1108dbd2d039e708c0e4e357254265d606425e2e42f212ed31ad8c3978d27df`.
Embedded source label: `org.yoloharness.source-digest=sha256:d3bf64be694a472f83a0cae8ec22346fd5c7e90f8ecb079a60d063c743440f8e`; the shipped test recomputed the same digest from the checkout and rejected images without an exact match.
The shipped-path provider row derives a separate ephemeral CA-only image from that base. Its ID is intentionally ephemeral and is not configured as the production image; the test asserts the base label before deriving it.

Commands:

- `XDG_CONFIG_HOME=/tmp/yoloharness-build-config-phase1 XDG_DATA_HOME=/tmp/yoloharness-build-data-phase1 node src/cli.mjs setup`
- `YOLO_REAL_DOCKER=1 YOLO_DOCKER_IMAGE=yoloharness-local:0.1.0 node --test test/real-docker.test.mjs`
- `npm test`

Result: real-Docker gate 2 passed, 0 failed, 0 skipped; full suite 80 passed, 0 failed, 2 skipped. The real gate also rejected the previously unlabelled image before this rebuild.

Exact real-Docker test names:

- `shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network` — PASS.
- `configured final image has read-only root and rootless UID0 workspace write/delete canary` — PASS.

The first row invokes `src/cli.mjs` as an OS subprocess from a disposable workspace. It does not call `main` with a launcher factory, instantiate `ContainerLauncher` directly, or mount the repository. A test-owned PATH wrapper resolves the absolute Docker binary and rewrites only the exact launcher `--network bridge` token to the pre-created internal network; production source retains fixed `bridge` and canonical HTTPS policy.

- The synthetic HTTPS provider ran in a separate container attached only to a pre-created `--internal` network, with alias `chatgpt.com`, no published ports, and SAN `chatgpt.com`; it captured the request nonce, remote container address, and provider PID.
- The first provider request produced a tool call; the runtime executed `printf` inside the whole-runtime container; the second provider request contained the paired function-call output and returned `whole-runtime-ok`.
- The shipped CLI path selected the configured immutable derivative image ID from synthetic image metadata, while access/refresh credentials and XDG configuration remained in isolated temporary directories. The derivative differs from the verified base only by the ephemeral public CA certificate and `NODE_EXTRA_CA_CERTS`; the CA/key/server-key are never copied into the derivative. No canonical external provider request was made.

- Preflight returned Docker server version `29.8.0`, with daemon security option `name=rootless`.
- The whole-runtime container was created with `--pull=never`, read-only root, dropped capabilities, no-new-privileges, bounded PID/memory/CPU limits, bounded `/tmp` and synthetic-home tmpfs, and exactly one writable `/workspace` bind. The image canary observed `/app` as read-only and confirmed write/delete on the project bind.
- Cleanup removed the exact owned provider, runtime IDs, network, temporary CA/key/capture/workspace roots, and wrapper root. The remaining stopped Docker container on the daemon (`objective_chatelet`) is pre-existing and not owned by this test.
- The offline launcher regression `uncertain create waits for stable absence and removes a delayed daemon container` passed: exact name+label reconciliation observed a delayed ID, removed it, verified not-found, and required stable absence.

The test is opt-in because it requires a rootless Docker daemon, OpenSSL, and prebuilt image. It uses only synthetic credentials/config and a local internal-network provider; no live OAuth/provider request or real credential was used. Rootless behavior is daemon/kernel dependent. WRC-03..WRC-19 rows not listed as PASS in `qa/phase1-acceptance-matrix.md` remain unrun or partial; WRC-21/native macOS remains untested. This evidence is not a claim that the remaining amended WRC-01..20 rows passed.
