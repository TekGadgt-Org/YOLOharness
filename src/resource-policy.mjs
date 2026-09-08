// Shared bounded runtime limits. Keep this policy identical across daemon and host platforms.
export const RUNTIME_RESOURCE_POLICY = Object.freeze({
  tmpfs: '256m',
  homeTmpfs: '64m',
  memory: '512m',
  pids: '128',
  cpus: '1',
});
