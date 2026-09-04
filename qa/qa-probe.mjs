import { EventLog, authorizeEffect } from '../prototype/kernel.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'yolo-qa-'));
const path = join(dir, 'events.jsonl');
await new EventLog(path).append('r', 'one');
await new EventLog(path).append('r', 'two');
console.log('log=', JSON.stringify(await readFile(path, 'utf8')));
try {
  const event = await new EventLog(path).append('r', 'three');
  console.log('reopen=', JSON.stringify(event));
} catch (error) {
  console.log('reopen_error=', error.message);
}
console.log('traversal=', JSON.stringify(authorizeEffect({ type: 'file.write', path: '..' }, { workspaceRoot: '/workspace/project' })));
console.log('nested=', JSON.stringify(authorizeEffect({ type: 'file.write', path: 'sub/ok.txt' }, { workspaceRoot: '/workspace/project' })));
console.log('absolute-outside=', JSON.stringify(authorizeEffect({ type: 'file.write', path: '/etc/passwd' }, { workspaceRoot: '/workspace/project' })));
