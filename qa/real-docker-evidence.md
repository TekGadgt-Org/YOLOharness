# Real Docker phase1 gate evidence

Run date: 2026-09-05 (UTC)
Docker server: 29.8.0, context `rootless`
Image: `yoloharness-phase1:local`, built locally with `docker build --pull -t yoloharness-phase1:local .`

Commands:

- `docker build --pull -t yoloharness-phase1:local .`
- `npm run test:docker`

Result: 4 passed, 0 failed, 0 skipped.

Observed through the actual `DockerExecutor` and worker:

- Preflight returned Docker server version `29.8.0`.
- Successful worker receipt returned `ok: true`, `call_id: real-success`, and UID `10001`.
- The worker wrote `artifact` to the explicitly writable mounted workspace.
- A command exiting 7 returned a typed failure receipt with exit code 7 and the stderr text.
- `/app` write failed with `Read-only file system`.
- `/proc/net/route` was empty, confirming the worker had no configured network route.
- `CapEff` was `0000000000000000`, confirming dropped effective capabilities for this image/kernel.
- A non-interrupted delayed write to `/workspace/delayed-control.txt` appeared in the host workspace, proving the negative delayed-write probes target the actual writable bind mount.
- The deadline probe first wrote a `deadline-started.txt` marker from inside the worker, then a 2-second delayed workspace write was cancelled by the 1500ms executor deadline; the marker was observed before rejection, the test waited 3 seconds (strictly beyond the scheduled write with margin) before asserting the delayed artifact never appeared, and the exact generated container name was independently absent from `docker ps -a`.
- A synthetic provider was driven through `runOnce` and the real `DockerExecutor`; the test waited for an `interrupt-started.txt` marker written inside the worker before aborting its signal, then waited 3 seconds (strictly beyond the worker's 2-second delayed write with margin). The run produced `interrupted`, the delayed write to the mounted `/workspace` path never appeared, and the exact generated container name was absent. This validates runtime abort-signal cleanup, not OS-level CLI SIGINT wiring.
- A nonexistent image failed closed with `--pull=never`; its exact generated container name was absent.
- The daemon's `docker inspect` response for a created (then removed) executor container reported `NetworkMode=none`, `ReadonlyRootfs=true`, `CapDrop=[ALL]`, `SecurityOpt=[no-new-privileges]`, `PidsLimit=128`, `Memory=512 MiB`, `NanoCpus=1`, and only the `/workspace` writable bind mount.
- After every owned operation, `docker ps -a` contained no `yoloharness-real-*` containers.

Configuration asserted by `DockerExecutor.args()` (and sent to the real daemon): `--pull=never`, `--network none`, `--read-only`, `--cap-drop=ALL`, `--security-opt no-new-privileges`, `--pids-limit 128`, `--memory 512m`, `--cpus 1`, and only the workspace bind mount at `/workspace:rw`.

The test is opt-in because it requires a Docker daemon and prebuilt image. Run the build and `npm run test:docker`, or set `YOLO_REAL_DOCKER=1` and optionally `YOLO_DOCKER_IMAGE`. The resource and security values above are daemon-observed configuration; practical enforcement was additionally observed for read-only root, no route, dropped capabilities, and post-deadline/interrupt process cleanup on this rootless daemon/kernel. Rootless behavior is daemon/kernel dependent; native macOS, live OAuth/provider traffic, and compromised daemon/image scenarios remain untested.
