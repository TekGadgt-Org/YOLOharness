# Real Docker phase1 gate evidence

Run date: 2026-09-05 (UTC)
Docker server: 29.8.0, context `rootless`
Image: `yoloharness-phase1:local`, built locally with `docker build --pull -t yoloharness-phase1:local .`

Command: `npm run test:docker`
Result: 1 passed, 0 failed.

Observed through the actual `DockerExecutor` and worker:

- Preflight returned Docker server version `29.8.0`.
- Successful worker receipt returned `ok: true`, `call_id: real-success`, and UID `10001`.
- The worker wrote `artifact` to the explicitly writable mounted workspace.
- A command exiting 7 returned a typed failure receipt with the stderr text.
- `/app` write failed with `Read-only file system`.
- `/proc/net/route` was empty, confirming the worker had no configured network route.
- `CapEff` was `0000000000000000`, confirming dropped effective capabilities for this image/kernel.
- A 100ms executor deadline interrupted `sleep 30` and returned `executor deadline exceeded`.
- After every operation, `docker ps -a --filter name=yoloharness-` returned no containers.

Configuration asserted by `DockerExecutor.args()` (and sent to the real daemon): `--pull=never`, `--network none`, `--read-only`, `--cap-drop=ALL`, `--security-opt no-new-privileges`, `--pids-limit 128`, `--memory 512m`, `--cpus 1`, and only the workspace bind mount at `/workspace:rw`.

The test is opt-in because it requires a Docker daemon and prebuilt image. Run `npm run test:docker`, or set `YOLO_REAL_DOCKER=1` and optionally `YOLO_DOCKER_IMAGE`. Rootless behavior is daemon/kernel dependent; native macOS, live OAuth/provider traffic, and compromised daemon/image scenarios remain untested.
