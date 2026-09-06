import { Buffer } from 'node:buffer';

export const BOOTSTRAP_VERSION = 1;
export const MAX_BOOTSTRAP = 128 * 1024;

export function encodeBootstrap({ prompt, model, deadline, accessToken, expiresAt, skills = {} }) {
  if (typeof prompt !== 'string' || !prompt.trim() || typeof model !== 'string' || !model ||
      typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= Date.now() ||
      typeof accessToken !== 'string' || !accessToken ||
      typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new TypeError('invalid runtime bootstrap');
  }
  const payload = JSON.stringify({ version: BOOTSTRAP_VERSION, prompt, model, deadline, accessToken, expiresAt, skills });
  const frame = Buffer.from(payload);
  if (frame.byteLength > MAX_BOOTSTRAP) throw new TypeError('runtime bootstrap too large');
  return Buffer.concat([Buffer.from(`${frame.byteLength}:`), frame]);
}

export function decodeBootstrap(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const separator = data.indexOf(58);
  if (separator < 1 || separator > 8) throw new TypeError('malformed runtime bootstrap');
  const length = Number(data.subarray(0, separator).toString());
  if (!Number.isInteger(length) || length < 1 || length > MAX_BOOTSTRAP || data.length !== separator + 1 + length) throw new TypeError('malformed runtime bootstrap');
  let value;
  try { value = JSON.parse(data.subarray(separator + 1).toString()); } catch { throw new TypeError('malformed runtime bootstrap'); }
  if (!value || value.version !== BOOTSTRAP_VERSION || typeof value.prompt !== 'string' || !value.prompt.trim() ||
      typeof value.model !== 'string' || !value.model || typeof value.deadline !== 'number' || !Number.isFinite(value.deadline) || value.deadline <= Date.now() ||
      typeof value.accessToken !== 'string' || !value.accessToken || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= value.deadline) throw new TypeError('malformed runtime bootstrap');
  if (!value.skills || typeof value.skills !== 'object' || Array.isArray(value.skills)) throw new TypeError('malformed runtime bootstrap');
  return value;
}