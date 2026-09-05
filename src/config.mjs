import { mkdir, rename, open, readFile, chmod, rm } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export class ConfigError extends Error { constructor(message, code = 'config_error') { super(message); this.name = 'ConfigError'; this.code = code; } }

export function validateModel(model) {
  if (typeof model !== 'string' || model.length === 0 || /\s|[\u0000-\u001f\u007f-\u009f]/u.test(model)) throw new ConfigError('model name must be non-empty and contain no whitespace or control characters', 'invalid_model');
  return model;
}

export function configRoot(env = process.env) {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0 && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : join(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), '.config');
  return xdg;
}
export function configPath(env = process.env) { return join(configRoot(env), 'yoloharness', 'config.json'); }

export class ConfigStore {
  constructor(path, { syncFile = fh => fh.sync(), syncDirectory = fh => fh.sync() } = {}) { this.path = path; this.syncFile = syncFile; this.syncDirectory = syncDirectory; }
  async load() {
    let value;
    try { value = JSON.parse(await readFile(this.path, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new ConfigError(`model configuration is malformed JSON: ${this.path}`);
      throw new ConfigError(`model configuration is unreadable: ${this.path}`);
    }
    if (!value || value.version !== 1 || typeof value.model !== 'string') throw new ConfigError(`model configuration has unsupported schema (expected version 1 with a model): ${this.path}`);
    validateModel(value.model);
    return { version: 1, model: value.model };
  }
  async save(model) {
    validateModel(model);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`; let committed = false;
    const fh = await open(tmp, 'wx', 0o600);
    try {
      try { await fh.writeFile(JSON.stringify({ version: 1, model }) + '\n'); await this.syncFile(fh); } finally { await fh.close(); }
      await chmod(tmp, 0o600); await rename(tmp, this.path); committed = true; await chmod(this.path, 0o600);
      const dir = await open(dirname(this.path), 'r'); try { await this.syncDirectory(dir); } finally { await dir.close(); }
    } catch (error) { if (!committed) await rm(tmp, { force: true }).catch(() => {}); throw error; }
    return { version: 1, model };
  }
}