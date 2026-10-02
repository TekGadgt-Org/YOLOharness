import { mkdir, rename, open, readFile, chmod, rm } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export class ConfigError extends Error { constructor(message, code = 'config_error') { super(message); this.name = 'ConfigError'; this.code = code; } }
export function validateModel(model) {
  if (typeof model !== 'string' || model.length === 0 || /\s|[\u0000-\u001f\u007f-\u009f]/u.test(model)) throw new ConfigError('model name must be non-empty and contain no whitespace or control characters', 'invalid_model');
  return model;
}
export const DEFAULT_EPHEMERAL_PATHS = Object.freeze(['node_modules', '.venv', 'vendor', '.godot', 'target']);
const MAX_EPHEMERAL_PATHS = 64; const MAX_EPHEMERAL_LENGTH = 240; const MAX_EPHEMERAL_DEPTH = 16;
export function validateEphemeralPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EPHEMERAL_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new ConfigError('ephemeral path must be a non-empty relative path without control characters', 'invalid_ephemeral_path');
  const path = value.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:\//u.test(path) || path === '.' || path.startsWith('./') || path.includes('//')) throw new ConfigError(`invalid ephemeral path: ${value}`, 'invalid_ephemeral_path');
  const parts = path.split('/');
  if (parts.length > MAX_EPHEMERAL_DEPTH || parts.some(part => !part || part === '..') || parts.includes('.git') || parts.includes('.yolo')) throw new ConfigError(`invalid ephemeral path: ${value}`, 'invalid_ephemeral_path');
  return parts.join('/');
}
export function validateEphemeralPaths(values) {
  if (!Array.isArray(values) || values.length > MAX_EPHEMERAL_PATHS) throw new ConfigError('ephemeralPaths must be a bounded array', 'invalid_ephemeral_paths');
  const paths = values.map(validateEphemeralPath);
  if (new Set(paths).size !== paths.length) throw new ConfigError('ephemeral paths must not overlap', 'invalid_ephemeral_paths');
  for (const path of paths) for (const other of paths) if (path !== other && (path.startsWith(`${other}/`) || other.startsWith(`${path}/`))) throw new ConfigError('ephemeral paths must not overlap', 'invalid_ephemeral_paths');
  return paths;
}
export function effectiveEphemeralPaths(value) { return validateEphemeralPaths(value?.ephemeralPaths ?? DEFAULT_EPHEMERAL_PATHS); }
export function configRoot(env = process.env) {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0 && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), '.config');
  return xdg;
}
export function configPath(env = process.env) { return join(configRoot(env), 'yoloharness', 'config.json'); }
export function dataRoot(env = process.env) {
  const xdg = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.length > 0 && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), '.local', 'share');
  return join(xdg, 'yoloharness');
}
export function imageMetadataPath(env = process.env) { return join(dataRoot(env), 'image.json'); }
export class ConfigStore {
  constructor(path, { syncFile = fh => fh.sync(), syncDirectory = fh => fh.sync() } = {}) { this.path = path; this.syncFile = syncFile; this.syncDirectory = syncDirectory; }
  async load() {
    let value;
    try { value = JSON.parse(await readFile(this.path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof SyntaxError) throw new ConfigError(`model configuration is malformed JSON: ${this.path}`); throw new ConfigError(`model configuration is unreadable: ${this.path}`); }
    if (!value || ![1, 2].includes(value.version) || typeof value.model !== 'string') throw new ConfigError(`model configuration has unsupported schema (expected version 1 or 2 with a model): ${this.path}`);
    const keys = Object.keys(value).sort();
    if (value.version === 1 && keys.join(',') !== 'model,version') throw new ConfigError(`model configuration has unsupported schema (expected version 1 with model only): ${this.path}`);
    if (value.version === 2 && keys.join(',') !== 'ephemeralPaths,model,version') throw new ConfigError(`model configuration has unsupported schema (expected version 2 with ephemeralPaths): ${this.path}`);
    validateModel(value.model); if (value.version === 1) return { version: 1, model: value.model }; if (!Array.isArray(value.ephemeralPaths)) throw new ConfigError(`model configuration has unsupported schema (expected version 2 with ephemeralPaths): ${this.path}`); return { version: 2, model: value.model, ephemeralPaths: validateEphemeralPaths(value.ephemeralPaths) };
  }
  async save(model) { return this.saveDocument({ version: 1, model }, { legacy: true }); }
  async saveDocument(document, { legacy = false } = {}) {
    validateModel(document?.model); const ephemeralPaths = validateEphemeralPaths(document?.ephemeralPaths ?? DEFAULT_EPHEMERAL_PATHS);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); const tmp = `${this.path}.${randomUUID()}.tmp`; let committed = false; const fh = await open(tmp, 'wx', 0o600);
    try { try { await fh.writeFile(JSON.stringify(legacy ? { version: 1, model: document.model } : { version: 2, model: document.model, ephemeralPaths }) + '\n'); await this.syncFile(fh); } finally { await fh.close(); } await chmod(tmp, 0o600); await rename(tmp, this.path); committed = true; await chmod(this.path, 0o600); const dir = await open(dirname(this.path), 'r'); try { await this.syncDirectory(dir); } finally { await dir.close(); } } catch (error) { if (!committed) await rm(tmp, { force: true }).catch(() => {}); throw error; }
    return legacy ? { version: 1, model: document.model } : { version: 2, model: document.model, ephemeralPaths };
  }
}