import test from 'node:test';
import assert from 'node:assert/strict';
import { PROGRESS_MAGIC, encodeProgressFrame, ProgressFrameDecoder, sanitizeTerminalText } from '../src/progress.mjs';

test('YVP1 frames decode only bounded nonterminal progress', () => {
  const event = { v: 1, seq: 1, type: 'lifecycle', phase: 'runtime_started' };
  const frame = encodeProgressFrame(event);
  assert.equal(frame.toString(), `${PROGRESS_MAGIC}{"v":1,"seq":1,"type":"lifecycle","phase":"runtime_started"}\n`);
  const seen = [];
  const decoder = new ProgressFrameDecoder(value => seen.push(value));
  decoder.push(frame.subarray(0, 4)); decoder.push(frame.subarray(4)); decoder.end();
  assert.deepEqual(seen, [event]);
});

test('malformed or unsafe progress disables observability without throwing', () => {
  const faults = []; const decoder = new ProgressFrameDecoder(() => {}, { onFault: value => faults.push(value) });
  decoder.push(Buffer.from(`${PROGRESS_MAGIC}{"v":1,"seq":1,"type":"lifecycle","phase":"runtime_finished","status":"completed"}\n`));
  assert.equal(decoder.state, 'FAULT'); assert.equal(faults.length, 1);
  const clean = sanitizeTerminalText('x\r\u001b]0;owned\u0007\u202Etxt');
  assert.doesNotMatch(clean, /[\u0000-\u001f\u007f\u0080-\u009f]/); assert.match(clean, /\\r/);
});
