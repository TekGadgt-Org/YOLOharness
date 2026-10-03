#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { relative, join } from 'node:path';
import { encodeRecordHeader, PROTOCOL_VERSION } from './workspace-protocol.mjs';
const excluded = new Set(['node_modules', '.venv', 'vendor', '.godot', 'target', ...process.argv.slice(2)]);
const out = process.stdout;
const write = chunk => new Promise((resolve, reject) => { if (out.write(chunk)) resolve(); else out.once('drain', resolve); out.once('error', reject); });
await write(Buffer.from('YHP1'));
async function walk(root, current = root) {
  for (const name of (await readdir(current)).sort()) {
    if (excluded.has(name)) continue;
    const path = join(current, name); const info = await lstat(path);
    const key = relative(root, path).split('\\').join('/');
    if (info.isSymbolicLink() || info.isBlockDevice() || info.isCharacterDevice() || info.isFIFO() || info.isSocket() || info.nlink > 1) throw new Error(`unsupported export entry: ${key}`);
    if (info.isDirectory()) { await write(encodeRecordHeader({ type: 'directory', path: key, mode: info.mode & 0o777 }, 0)); await walk(root, path); }
    else if (info.isFile()) { await write(encodeRecordHeader({ type: 'file', path: key, mode: info.mode & 0o777 }, info.size)); for await (const chunk of createReadStream(path)) await write(chunk); }
    else throw new Error(`unsupported export entry: ${key}`);
  }
}
await walk('/tmp/workspace');
