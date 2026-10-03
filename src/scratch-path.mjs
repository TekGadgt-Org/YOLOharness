import { createHash } from 'node:crypto';

export function volumeSubpath(path) {
  if (typeof path !== 'string' || !path || path === 'tmp') throw new TypeError('invalid scratch subpath');
  const normalized = path.replaceAll('\\', '/');
  return `workspace-${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

export function scratchSubpaths(paths) {
  const names = paths.map(volumeSubpath);
  if (new Set(names).size !== names.length) throw new Error('ephemeral paths produce colliding scratch subpaths');
  return names;
}
