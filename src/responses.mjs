const MAX_EVENT = 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_ARGUMENTS = 256 * 1024;
const MAX_CALLS = 16;
export class ProtocolError extends Error { constructor(message) { super(message); this.name = 'ProtocolError'; this.code = 'stream_incomplete'; } }
export function *parseSSE(input) {
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
  let data = [];
  const dispatch = () => { if (!data.length) return null; const value = data.join('\n'); data = []; return value; };
  for (const line of text.replace(/^\ufeff/, '').split(/\r\n|\n|\r/)) {
    if (line === '') { const value = dispatch(); if (value !== null) yield value; continue; }
    if (line.startsWith(':')) continue;
    const i = line.indexOf(':'); const field = i < 0 ? line : line.slice(0, i); const value = (i < 0 ? '' : line.slice(i + 1)).replace(/^ /, '');
    if (field === 'data') { data.push(value); if (Buffer.byteLength(data.join('\n')) > MAX_EVENT) throw new ProtocolError('event too large'); }
  }
  const value = dispatch(); if (value !== null) yield value;
}
async function *frames(stream) {
  const decoder = new TextDecoder(); let carry = ''; let total = 0;
  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(String(chunk)); total += bytes;
    if (total > MAX_RESPONSE) throw new ProtocolError('response too large');
    carry += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(carry) > MAX_LINE) throw new ProtocolError('event line too large');
    const lines = carry.split(/\r\n|\n|\r/); carry = lines.pop();
    for (const line of lines) { if (Buffer.byteLength(line) > MAX_LINE) throw new ProtocolError('event line too large'); yield line; }
  }
  carry += decoder.decode(); if (Buffer.byteLength(carry) > MAX_LINE) throw new ProtocolError('event line too large'); if (carry) yield carry;
}
export class ResponsesClient {
  constructor(config) { if (!config?.url || !config.model) throw new TypeError('responses url and model required'); this.url = config.url; this.model = config.model; this.fetch = config.fetch ?? fetch; this.accessToken = config.accessToken; this.headers = config.headers ?? {}; }
  async *respond({ input, instructions = 'Complete the task using only declared tools.', tools = [], signal, runId = 'run' } = {}) {
    const body = { model: this.model, instructions, input, tools, store: false, stream: true };
    if (tools.length) { body.tools = tools; body.tool_choice = 'auto'; body.parallel_tool_calls = false; }
    const response = await this.fetch(this.url, { method: 'POST', redirect: 'error', signal, headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json', accept: 'text/event-stream', originator: 'yoloharness', session_id: runId, 'x-client-request-id': runId.slice(0, 64), ...this.headers }, body: JSON.stringify(body) });
    if (!response.ok) throw Object.assign(new Error(`responses request failed (${response.status})`), { code: response.status === 429 ? 'rate_limited' : 'provider_error', status: response.status });
    if (!response.body) throw new ProtocolError('missing response stream');
    const calls = new Map(); let terminal = false; let text = '';
    for await (const line of frames(response.body)) {
      if (!line.trim() || line.startsWith(':') || !line.startsWith('data:')) continue;
      const raw = line.slice(5).replace(/^ /, ''); if (raw === '[DONE]') continue;
      let event; try { event = JSON.parse(raw); } catch { throw new ProtocolError('malformed event JSON'); }
      if (event.type === 'response.output_text.delta') { const delta = String(event.delta ?? ''); text += delta; if (Buffer.byteLength(text) > MAX_TEXT) throw new ProtocolError('response text too large'); yield { type: 'text_delta', delta }; }
      else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') { if (calls.size >= MAX_CALLS) throw new ProtocolError('too many tool calls'); calls.set(event.item.id, { ...event.item, arguments: event.item.arguments ?? '' }); }
      else if (event.type === 'response.function_call_arguments.delta') { const call = calls.get(event.item_id); if (call) { call.arguments += String(event.delta ?? ''); if (Buffer.byteLength(call.arguments) > MAX_ARGUMENTS) throw new ProtocolError('tool arguments too large'); } }
      else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') { const saved = calls.get(event.item.id); const call = { ...event.item, arguments: event.item.arguments ?? saved?.arguments ?? '' }; if (Buffer.byteLength(call.arguments) > MAX_ARGUMENTS) throw new ProtocolError('tool arguments too large'); yield { type: 'tool_call', call }; }
      else if (event.type === 'response.completed' || event.type === 'response.done') { terminal = true; yield { type: 'completed', status: 'completed', text }; }
    }
    if (!terminal) throw new ProtocolError('stream ended without completed response');
  }
}
