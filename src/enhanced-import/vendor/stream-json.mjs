/** Bounded UTF-8 JSON framing. JSON.parse still validates each complete value;
 * only container separators are interpreted here. No expressions are evaluated. */
import { parseJSON } from './providers/common.mjs';

const abort = signal => { if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError'); };
const space = /[^\x20\t\r\n]/;

class Cursor {
  constructor(source, { signal, limits }) {
    this.iterator = source[Symbol.asyncIterator](); this.signal = signal; this.limits = limits;
    this.decoder = new TextDecoder('utf-8', { fatal: true }); this.text = ''; this.pos = 0; this.ended = false; this.bytes = 0;
  }
  async available() {
    while (this.pos >= this.text.length && !this.ended) {
      abort(this.signal);
      const next = await this.iterator.next();
      if (next.done) { this.ended = true; this.text = this.decoder.decode(); }
      else {
        this.bytes += next.value.byteLength;
        if (this.bytes > this.limits.streamBytes) throw new Error('JSON exceeds the configured streaming input safety limit.');
        this.text = this.decoder.decode(next.value, { stream: true });
      }
      this.pos = 0;
    }
    return this.pos < this.text.length;
  }
  async whitespace() {
    while (await this.available()) {
      const relative = this.text.slice(this.pos).search(space);
      if (relative >= 0) { this.pos += relative; return this.text[this.pos]; }
      this.pos = this.text.length;
    }
    return '';
  }
  async expect(wanted) {
    if (await this.whitespace() !== wanted) throw new Error(`Invalid JSON container: expected ${JSON.stringify(wanted)}.`);
    this.pos++;
  }
  async value(maxBytes = this.limits.recordBytes) {
    const first = await this.whitespace();
    if (!first || /[,\]}:]/.test(first)) throw new Error('Missing JSON value.');
    const parts = []; let bytes = 0, depth = 0, quoted = false, escaped = false, started = false;
    const container = first === '[' || first === '{', string = first === '"';
    const append = part => {
      bytes += Buffer.byteLength(part, 'utf8');
      if (bytes > maxBytes) throw new Error(`Individual JSON record exceeds the ${Math.round(maxBytes / 1024 ** 2)} MiB per-record safety limit. Split this conversation or export smaller records.`);
      parts.push(part);
    };
    while (await this.available()) {
      const start = this.pos; let complete = false;
      while (this.pos < this.text.length) {
        const c = this.text[this.pos];
        if (!container && !string && started && /[\x20\t\r\n,\]}]/.test(c)) { complete = true; break; }
        this.pos++; started = true;
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') { quoted = false; if (string && depth === 0) { complete = true; break; } }
        } else if (c === '"') quoted = true;
        else if (c === '[' || c === '{') {
          if (++depth > this.limits.jsonDepth) throw new Error('JSON exceeds the supported complexity limit.');
        } else if (c === ']' || c === '}') {
          if (--depth === 0 && container) { complete = true; break; }
        }
      }
      append(this.text.slice(start, this.pos));
      if (complete) break;
    }
    abort(this.signal);
    return { value: parseJSON(parts.join('')), bytes };
  }
  async close() { await this.iterator.return?.(); }
}

/** Events: start(array/object/value), record, field and value. Root object
 * `conversations` arrays are framed separately; all other fields remain bounded. */
export async function* jsonEvents(source, options) {
  const cursor = new Cursor(source, options);
  async function* array() {
    await cursor.expect('['); let index = 0;
    if (await cursor.whitespace() === ']') { cursor.pos++; return; }
    while (true) {
      const result = await cursor.value();
      yield { type: 'record', index: index++, ...result };
      const c = await cursor.whitespace(); cursor.pos++;
      if (c === ']') return;
      if (c !== ',') throw new Error('Invalid JSON array separator.');
    }
  }
  try {
    const first = await cursor.whitespace();
    if (first === '[') {
      yield { type: 'start', kind: 'array' }; yield* array();
    } else if (first === '{') {
      yield { type: 'start', kind: 'object' }; cursor.pos++;
      const names = new Set();
      if (await cursor.whitespace() === '}') cursor.pos++;
      else while (true) {
        const { value: name } = await cursor.value(1024 * 1024);
        if (typeof name !== 'string') throw new Error('Invalid JSON object key.');
        if (names.has(name)) throw new Error('Duplicate root JSON key: ' + name);
        names.add(name); await cursor.expect(':');
        if (name === 'conversations' && await cursor.whitespace() === '[') {
          yield { type: 'container', name }; yield* array();
        } else yield { type: 'field', name, ...await cursor.value() };
        const c = await cursor.whitespace(); cursor.pos++;
        if (c === '}') break;
        if (c !== ',') throw new Error('Invalid JSON object separator.');
      }
    } else {
      yield { type: 'start', kind: 'value' }; yield { type: 'value', ...await cursor.value() };
    }
    if (await cursor.whitespace()) throw new Error('Unexpected data after JSON document.');
    yield { type: 'end', bytes: cursor.bytes };
  } finally { await cursor.close(); }
}
