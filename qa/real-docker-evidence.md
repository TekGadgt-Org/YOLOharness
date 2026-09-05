# Real Docker phase1 gate evidence

Run date: 2026-09-05 22:17 UTC
Docker server: 29.8.0, context `rootless`
Kernel: `6.8.0-138-generic`; cgroup version 2; rootless security option observed; storage `overlayfs`.
Base image: `yoloharness-local:0.1.0`, immutable ID `sha256:82a2570d54ef119b57d0abfd1ae9b36e4648fbe64dbdc3244caa290b19ebf432` (RepoTags includes the installation-owned tag).
Embedded source label: `sha256:5cf967d71564dc79b0b1e961b6b5885298b85de2e8ea85d3e38512d9eb35b13b`, verified against the current deterministic checkout digest by `yolo setup` and the shipped test; stale labels and untagged substituted images are rejected before credentials/bootstrap.
The shipped-path provider row derives a separate ephemeral CA-only image from that base. Its ID is intentionally ephemeral and is not configured as the production image; the test asserts the base label before deriving it.

Commands:

- `XDG_CONFIG_HOME=$PWD/.evidence-setup.Szvllb/config XDG_DATA_HOME=$PWD/.evidence-setup.Szvllb/data node src/cli.mjs setup` (exit 0; image `sha256:82a2570d54ef119b57d0abfd1ae9b36e4648fbe64dbdc3244caa290b19ebf432`)
- `YOLO_EVIDENCE_DIR=qa/wrc-baseline-raw YOLO_REAL_DOCKER=1 node --test test/real-docker.test.mjs` (exit 0)
- `npm test`

The current candidate result is 2 passed, 0 failed, 0 skipped, with full suite 84 passed, 0 failed, 2 skipped. Raw commands, stdout, stderr, exit status, and timestamps are retained under `qa/wrc-baseline-raw/`.

After the trusted-client policy was changed to resolve Docker once from the invoker's PATH and preserve normal Docker context/host selection, `yolo setup` rebuilt the image and `npm run test:docker` was rerun. Both shipped subprocess tests passed (2/2): the CA-only internal-network provider roundtrip and the read-only-root/rootless UID0 write/delete canary. The image was rebuilt before execution and its embedded source digest matched the current runtime source.

Exact real-Docker test names:

- `shipped yolo subprocess uses the immutable CA-only derivative and an internal provider network` — PASS (the test-owned PATH wrapper routes only the synthetic derivative's bridge network; production selection APIs remain fixed).
- `configured final image has read-only root and rootless UID0 workspace write/delete canary` — PASS.

- The first row invokes `src/cli.mjs` as an OS subprocess from a disposable workspace. It does not call `main` with a launcher factory, instantiate `ContainerLauncher` directly, or mount the repository. The Docker client is resolved once from the invoker's PATH and the normal Docker context/host configuration is preserved; the test-owned PATH wrapper remains a declared synthetic routing fixture only.

- The synthetic HTTPS provider ran in a separate container attached only to a pre-created `--internal` network, with alias `chatgpt.com`, no published ports, and SAN `chatgpt.com`; it captured the request nonce, remote container address, and provider PID.
- The first provider request produced a tool call; the runtime executed `printf` inside the whole-runtime container; the second provider request contained the paired function-call output and returned `whole-runtime-ok`.
- The shipped CLI path selected the configured immutable tagged base image ID from synthetic image metadata. An external test-only wrapper rewrote only the create image/network to the ephemeral CA-only derivative; production image selection therefore remained bound to the verified base. Access/refresh credentials and XDG configuration remained in isolated temporary directories, and the CA/key/server-key were never copied into the derivative. No canonical external provider request was made.
- The shipped subprocess received a test-owned empty Docker config and the verified local daemon endpoint (`unix:///run/user/999/docker.sock`); it did not consume the invoker's Docker config, credential helpers, or context files.
- A hostile XDG metadata fixture pointing at the untagged CA derivative failed with `runtime image is not the installation-owned image tag` while its credential path was intentionally absent; the tagged base metadata then restored the positive control.
- A disposable cwd containing a literal newline failed closed with `workspace path contains unsupported control characters`; the ordinary disposable cwd completed successfully.

- Preflight returned Docker server version `29.8.0`, with daemon security option `name=rootless`.
- The whole-runtime container was created with `--pull=never`, read-only root, dropped capabilities, no-new-privileges, bounded PID/memory/CPU limits, bounded `/tmp` and synthetic-home tmpfs, and exactly one writable `/workspace` bind. The image canary observed `/app` as read-only and confirmed write/delete on the project bind.
- `runtime-inspect.stdout` is the daemon's post-start inspection of the shipped runtime before cleanup; assertions cover read-only root, dropped capabilities, no-new-privileges, PID/memory/CPU limits, exactly one `/workspace` bind, absence of host secret/socket mounts, explicit network attachment, and absence of token/Docker selector variables from the container environment.
- Cleanup removed the exact owned provider, runtime IDs, network, temporary CA/key/capture/workspace roots, and wrapper root. The remaining stopped Docker container on the daemon (`objective_chatelet`) is pre-existing and not owned by this test.
- The offline launcher regression `uncertain create waits for stable absence and removes a delayed daemon container` passed: exact name+label reconciliation observed a delayed ID, removed it, verified not-found, and required stable absence.
- The mountinfo regression `mountinfo decoding preserves escaped newline targets for nested-mount checks` passed; Linux `\\012` escapes now decode before nested-target comparison.

The test is opt-in because it requires a rootless Docker daemon, OpenSSL, and prebuilt image. It uses only synthetic credentials/config; no live OAuth/provider request or real credential was used. Rootless behavior is daemon/kernel dependent. WRC-03..WRC-19 rows not listed as PASS in `qa/phase1-acceptance-matrix.md` remain unrun or partial; WRC-21/native macOS remains untested. This evidence is not a claim that the remaining amended WRC-01..20 rows passed.
