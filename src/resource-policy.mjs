// Shared runtime limits. Scratch is Docker-managed per run; identity state stays bounded.
export const RUNTIME_RESOURCE_POLICY = Object.freeze({
  homeTmpfs: '64m',
  memory: '512m',
  pids: '128',
  cpus: '1',
});
