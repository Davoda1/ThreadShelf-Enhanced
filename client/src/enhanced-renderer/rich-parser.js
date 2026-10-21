/** Reader-owned, bounded, data-only adapters for the evidenced export vocabulary.
 * This is deliberately not JSX, HTML, Svelte, or a JavaScript interpreter.
 * All representations are transient; nothing here writes back to a message.
 */
import { marked } from 'marked';
import { safeImageUrl } from './images.js';

export const RICH_LIMITS = Object.freeze({
  message: 2 * 1024 * 1024, span: 256 * 1024, depth: 24, nodes: 4096,
  values: 20000, string: 32768, iterations: 512, array: 512,
  output: 1024 * 1024, fragments: 256, operations: 1000000, milliseconds: 300,
});
const TAGS = new Set(['box', 'row', 'text', 'title', 'caption', 'divider', 'icon', 'grid', 'grid-item', 'Entity', 'AsyncImage', 'AsyncImageGroup', 'Chart', 'Cite', 'Link', 'svg']);
const INLINE = new Set(['Entity', 'Cite', 'Link', 'icon']);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const ENUMS = Object.freeze({
  align: ['start', 'center', 'end', 'stretch'], justify: ['start', 'center', 'end', 'between'],
  direction: ['row', 'column'], wrap: ['wrap', 'nowrap'], radius: ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', 'full'],
  weight: ['normal', 'medium', 'semibold', 'bold'], textAlign: ['start', 'left', 'center', 'right', 'end'],
  color: ['default', 'secondary', 'tertiary', 'subtle', 'success', 'info', 'warning', 'danger', 'error'],
});
const PROPS = Object.freeze({
  box: ['gap', 'width', 'height', 'size', 'minWidth', 'align', 'flex', 'border', 'radius', 'padding', 'justify', 'background', 'clip', 'direction'],
  row: ['align', 'gap', 'justify', 'wrap'], text: ['color', 'size', 'weight', 'tabularNums', 'textAlign'],
  title: ['size', 'color', 'tabularNums'], caption: ['textAlign'], divider: ['color'], grid: ['columns', 'gap'],
  'grid-item': [], icon: ['name', 'color', 'size', 'inline'], Entity: ['category', 'value', 'disambig'],
  Link: ['url', 'title'], Cite: ['ref', 'refs'], Chart: ['content'],
  AsyncImage: ['query', 'src', 'url', 'aspectRatio', 'width', 'maxWidth'], AsyncImageGroup: ['query', 'aspectRatio', 'layout'],
});
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const plainRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const fail = (message) => { throw new SyntaxError(message); };
function budget() {
  return { started: Date.now(), operations: 0, nodes: 0, values: 0, iterations: 0, output: 0, fragments: 0, codeCache: new WeakMap() };
}
function tick(b, kind, amount = 1) {
  b.operations += amount;
  if (kind) b[kind] += amount;
  if (b.operations > RICH_LIMITS.operations || (kind && b[kind] > RICH_LIMITS[kind])) fail('Rich content budget exceeded');
  if ((b.operations & 255) === 0 && Date.now() - b.started > RICH_LIMITS.milliseconds) fail('Rich content time budget exceeded');
}
function depthCheck(depth) { if (depth > RICH_LIMITS.depth) fail('Rich content nesting limit exceeded'); }
function keyCheck(key) { if (FORBIDDEN.has(key)) fail('Forbidden property'); }

class LiteralParser {
  constructor(source, b) { this.source = source; this.pos = 0; this.b = b; }
  ws() { while (/\s/.test(this.source[this.pos] || '') && this.pos < this.source.length) { this.pos++; tick(this.b); } }
  string() {
    const quote = this.source[this.pos++]; let result = '';
    while (this.pos < this.source.length) {
      tick(this.b);
      const c = this.source[this.pos++];
      if (c === quote) { if (result.length > RICH_LIMITS.string) fail('Literal string limit exceeded'); return result; }
      if (c === '\\') {
        const e = this.source[this.pos++];
        if (e === 'u') {
          const hex = this.source.slice(this.pos, this.pos + 4);
          if (!/^[a-fA-F0-9]{4}$/.test(hex)) fail('Invalid Unicode escape');
          result += String.fromCharCode(parseInt(hex, 16)); this.pos += 4;
        } else {
          const escapes = { '"': '"', "'": "'", '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
          if (!Object.hasOwn(escapes, e)) fail('Invalid literal escape');
          result += escapes[e];
        }
      } else {
        if (c.charCodeAt(0) < 32) fail('Control character in literal');
        result += c;
      }
      if (result.length > RICH_LIMITS.string) fail('Literal string limit exceeded');
    }
    fail('Unterminated literal string');
  }
  value(depth = 0) {
    depthCheck(depth); tick(this.b, 'values'); this.ws();
    const c = this.source[this.pos];
    if (c === '"' || c === "'") return this.string();
    if (c === '[') {
      this.pos++; const result = []; this.ws();
      while (this.source[this.pos] !== ']') {
        if (result.length >= RICH_LIMITS.array) fail('Literal array limit exceeded');
        result.push(this.value(depth + 1)); this.ws();
        if (this.source[this.pos] === ']') break;
        if (this.source[this.pos++] !== ',') fail('Expected array comma');
        this.ws();
      }
      this.pos++; return result;
    }
    if (c === '{') {
      this.pos++; const result = Object.create(null); this.ws();
      while (this.source[this.pos] !== '}') {
        let key;
        if (this.source[this.pos] === '"' || this.source[this.pos] === "'") key = this.string();
        else {
          const match = this.source.slice(this.pos).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
          if (!match) fail('Expected literal object key');
          key = match[0]; this.pos += key.length;
        }
        keyCheck(key); if (Object.hasOwn(result, key)) fail('Duplicate literal key');
        this.ws(); if (this.source[this.pos++] !== ':') fail('Expected object colon');
        result[key] = this.value(depth + 1); this.ws();
        if (this.source[this.pos] === '}') break;
        if (this.source[this.pos++] !== ',') fail('Expected object comma');
        this.ws();
      }
      this.pos++; return result;
    }
    const keyword = this.source.slice(this.pos).match(/^(true|false|null)(?![A-Za-z0-9_$])/);
    if (keyword) { this.pos += keyword[0].length; return keyword[0] === 'null' ? null : keyword[0] === 'true'; }
    const number = this.source.slice(this.pos).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) { this.pos += number[0].length; const n = Number(number[0]); if (!Number.isFinite(n)) fail('Non-finite number'); return n; }
    fail('Expected literal data');
  }
}
export function parseLiteral(source, sharedBudget) {
  const s = String(source); if (s.length > RICH_LIMITS.span) fail('Literal input limit exceeded');
  const parser = new LiteralParser(s, sharedBudget || budget());
  const result = parser.value(); parser.ws(); if (parser.pos !== s.length) fail('Expressions are not literal data');
  return result;
}
function binding(source) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(source)) fail('Unsupported binding');
  const path = source.split('.'); path.forEach(keyCheck); return { expression: 'binding', path };
}
function expression(source, b) {
  const s = source.trim();
  if (/^(?:[[{'"-]|\d|true\b|false\b|null\b)/.test(s)) return { expression: 'literal', value: parseLiteral(s, b) };
  return binding(s);
}
function resolve(expr, env) {
  if (expr.expression === 'literal') return expr.value;
  let value = env;
  for (const key of expr.path) {
    keyCheck(key); if (!plainRecord(value) || !own(value, key)) fail('Binding is not a local own property');
    value = value[key];
  }
  return value;
}
function condition(source, b) {
  const match = source.match(/^(.+?)\s*(===|!==|==|!=|<=|>=|<|>)\s*(.+)$/);
  if (!match) fail('Unsupported condition');
  return { left: expression(match[1], b), operator: match[2], right: expression(match[3], b) };
}
function compare(c, env) {
  const a = resolve(c.left, env), b = resolve(c.right, env);
  if (!['number', 'string', 'boolean'].includes(typeof a) || typeof a !== typeof b) fail('Condition operands must share a primitive type');
  switch (c.operator) {
    case '==': case '===': return a === b;
    case '!=': case '!==': return a !== b;
    case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
    default: return false;
  }
}
export function safeRichUrl(value) {
  // eslint-disable-next-line no-control-regex -- Reject control characters in archive URLs.
  if (typeof value !== 'string' || value.length > 4096 || !/^(?:https?:\/\/|mailto:)/i.test(value) || /[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  try { const u = new URL(value); return ['https:', 'http:', 'mailto:'].includes(u.protocol) ? value : null; } catch { return null; }
}
function dimensions(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d+(?:\.\d+)?)(px|%)$/);
  return !!m && Number(m[1]) <= (m[2] === '%' ? 100 : 2048);
}
function validateAttributes(tag, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (!PROPS[tag].includes(key)) fail(`Unsupported ${tag} property`);
    if (['border', 'clip', 'tabularNums', 'inline'].includes(key)) { if (typeof value !== 'boolean') fail('Expected boolean'); }
    else if (['gap', 'padding'].includes(key)) { if (!Number.isInteger(value) || value < 0 || value > 16) fail('Invalid spacing'); }
    else if (key === 'columns') { if (!Number.isInteger(value) || value < 1 || value > 12) fail('Invalid grid columns'); }
    else if (key === 'flex') { if (!/^(?:\d+(?:\.\d+)?)$/.test(String(value)) || Number(value) > 1024) fail('Invalid flex'); }
    else if (['width', 'height', 'minWidth', 'maxWidth'].includes(key) || (key === 'size' && tag === 'box')) { if (!dimensions(value)) fail('Invalid dimension'); }
    else if (key === 'size') { if (!['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'].includes(value)) fail('Invalid text size'); }
    else if (key === 'background') { if (typeof value !== 'string' || !(/^(?:#[0-9a-fA-F]{6}|surface-secondary|surface-tertiary|info|success|warning|danger|error)$/.test(value))) fail('Invalid background'); }
    else if (ENUMS[key]) { if (!ENUMS[key].includes(value)) fail('Invalid enum'); }
    else if (key === 'content') { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Chart content must be an object'); }
    else if (key === 'refs') { if (!Array.isArray(value) || !value.length || value.length > 64 || value.some(v => typeof v !== 'string' || !v.length || v.length > 256 || /\s/.test(v))) fail('Invalid references'); }
    else if (key === 'ref') { if (typeof value !== 'string' || !value.length || value.length > 256 || /\s/.test(value)) fail('Invalid reference'); }
    else if (key === 'query') { if (tag === 'AsyncImageGroup') { if (!Array.isArray(value) || value.length > 32 || value.some(v => typeof v !== 'string' || v.length > 4096)) fail('Invalid image queries'); } else if (typeof value !== 'string' || value.length > 4096) fail('Invalid image query'); }
    else if (tag === 'AsyncImage' && ['src', 'url'].includes(key)) { if (!safeImageUrl(value)) fail('Unsafe image URL'); }
    else if (key === 'url') { if (!safeRichUrl(value)) fail('Unsafe link URL'); }
    else if (key === 'aspectRatio') { if (typeof value !== 'string' || !/^[1-9]\d?:[1-9]\d?$/.test(value)) fail('Invalid aspect ratio'); }
    else if (key === 'layout') { if (value !== 'carousel') fail('Unsupported image layout'); }
    else if (typeof value !== 'string' || value.length > 4096) fail('Invalid text property');
  }
  if (tag === 'Entity' && typeof attrs.value !== 'string') fail('Entity has no label');
  if (tag === 'Link' && !safeRichUrl(attrs.url)) fail('Link has no safe URL');
  if (tag === 'Chart' && !attrs.content) fail('Chart has no content');
  if (tag === 'Cite' && ((!attrs.ref && !attrs.refs) || (attrs.ref && attrs.refs))) fail('Citation requires exactly one reference field');
  return attrs;
}
function richTagAt(source, position) {
  const m = source.slice(position, position + 40).match(/^<([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/);
  return m && TAGS.has(m[1]) ? m[1] : null;
}
function escaped(source, index) {
  let n = 0; for (let p = index - 1; p >= 0 && source[p] === '\\'; p--) n++;
  return n % 2 === 1;
}

// A small, static illustration vocabulary, independent of HTML/JSX. These are
// the geometry and paint fields used by the saved area/doughnut illustrations.
// No CSS, URLs, references, animation, events, text markup or foreign content.
const SVG_PAINT = ['fill', 'stroke', 'strokeWidth', 'stroke-width', 'strokeLinecap', 'stroke-linecap', 'strokeLinejoin', 'stroke-linejoin', 'opacity', 'fillOpacity', 'fill-opacity', 'strokeOpacity', 'stroke-opacity'];
const SVG_PROPS = Object.freeze({
  svg: ['viewBox', 'width', 'height', 'preserveAspectRatio'],
  path: ['d', ...SVG_PAINT],
  circle: ['cx', 'cy', 'r', ...SVG_PAINT],
});
const SVG_NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
function svgNumbers(value, limit = 2048) {
  const parts = value.match(new RegExp(SVG_NUMBER, 'g')) || [];
  if (parts.length > limit || parts.some(n => !Number.isFinite(Number(n)) || Math.abs(Number(n)) > 100000)) fail('SVG numeric limit exceeded');
  return parts.map(Number);
}
function validateSvgPath(value) {
  const tokens = [], lexer = new RegExp(`[MmZzLlHhVvCcSsQqTtAa]|${SVG_NUMBER}`, 'g');
  let end = 0;
  for (const match of value.matchAll(lexer)) {
    if (!/^[\s,]*$/.test(value.slice(end, match.index))) fail('Invalid SVG path token');
    tokens.push(match[0]); end = match.index + match[0].length;
  }
  if (!/^[\s,]*$/.test(value.slice(end)) || !/^[Mm]$/.test(tokens[0] || '')) fail('Invalid SVG path');
  svgNumbers(value);
  const sizes = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let pos = 0, commands = 0;
  while (pos < tokens.length) {
    const command = tokens[pos++].toUpperCase(), size = sizes[command];
    if (size === undefined || ++commands > 512) fail('Invalid SVG path command');
    const start = pos; while (pos < tokens.length && !/^[A-Za-z]$/.test(tokens[pos])) pos++;
    const count = pos - start;
    if (size === 0 ? count !== 0 : count === 0 || count % size !== 0) fail('Invalid SVG path geometry');
    if (command === 'A') for (let i = start; i < pos; i += 7) {
      if (Number(tokens[i]) < 0 || Number(tokens[i + 1]) < 0 || !['0', '1'].includes(tokens[i + 3]) || !['0', '1'].includes(tokens[i + 4])) fail('Invalid SVG arc');
    }
  }
}
function validateSvgAttributes(tag, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value !== 'string' || value.length > 8192) fail('Invalid SVG value');
    if (key === 'width' || key === 'height') { if (!dimensions(value)) fail('Invalid SVG dimension'); }
    else if (key === 'viewBox') {
      if (!new RegExp(`^\\s*${SVG_NUMBER}(?:[ ,]+${SVG_NUMBER}){3}\\s*$`).test(value)) fail('Invalid SVG viewBox');
      const values = svgNumbers(value, 4); if (values[2] <= 0 || values[3] <= 0) fail('Empty SVG viewBox');
    } else if (key === 'preserveAspectRatio') { if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/.test(value)) fail('Invalid SVG aspect ratio'); }
    else if (key === 'd') validateSvgPath(value);
    else if (key === 'fill' || key === 'stroke') { if (!/^(?:none|currentColor|#[a-fA-F0-9]{3}|#[a-fA-F0-9]{6})$/.test(value)) fail('Invalid SVG paint'); }
    else if (key === 'strokeLinecap' || key === 'stroke-linecap') { if (!['butt', 'round', 'square'].includes(value)) fail('Invalid SVG cap'); }
    else if (key === 'strokeLinejoin' || key === 'stroke-linejoin') { if (!['miter', 'round', 'bevel'].includes(value)) fail('Invalid SVG join'); }
    else {
      if (!new RegExp(`^${SVG_NUMBER}$`).test(value)) fail('Invalid SVG number');
      const n = svgNumbers(value, 1)[0];
      if (/opacity/i.test(key) && (n < 0 || n > 1)) fail('Invalid SVG opacity');
      if (['r', 'strokeWidth', 'stroke-width'].includes(key) && (n < 0 || n > 2048)) fail('Invalid SVG size');
    }
  }
  if (tag === 'svg' && !attrs.viewBox) fail('SVG requires a viewBox');
  if (tag === 'path' && !attrs.d) fail('SVG path requires geometry');
  if (tag === 'circle' && !['cx', 'cy', 'r'].every(k => Object.hasOwn(attrs, k))) fail('SVG circle requires geometry');
}

function protectedMathEnd(source, at) {
  if (escaped(source, at)) return at;
  let opening = '', closing = '';
  for (const [a, z] of [['\\(', '\\)'], ['\\[', '\\]'], ['$$', '$$']]) {
    if (source.startsWith(a, at)) { opening = a; closing = z; break; }
  }
  if (opening) {
    let p = source.indexOf(closing, at + opening.length);
    while (p >= 0 && escaped(source, p)) p = source.indexOf(closing, p + closing.length);
    return p >= 0 ? p + closing.length : at;
  }
  if ((at === 0 || source[at - 1] === '\n') && /^ *\[ *\r?\n/.test(source.slice(at, at + 512))) {
    const contentStart = source.indexOf('\n', at) + 1;
    const closing = /(?:^|\n)[ \t]*\][ \t]*(?=\r?\n|$)/g;
    closing.lastIndex = contentStart;
    const match = closing.exec(source);
    if (match && match.index - at <= RICH_LIMITS.span) {
      const tex = source.slice(contentStart, match.index);
      if (/\\[a-zA-Z]|[_^](?:\{|[a-zA-Z0-9])|(?:^|\s)=(?:\s|$)/.test(tex)) return match.index + match[0].length;
    }
  }
  if (source.startsWith('\\begin{', at)) {
    const m = source.slice(at).match(/^\\begin\{(equation\*?|align\*?|aligned|gather\*?|gathered|multline\*?|split|cases|[pbBvV]?matrix)\}/);
    if (m) { const close = `\\end{${m[1]}}`, p = source.indexOf(close, at + m[0].length); if (p >= 0) return p + close.length; }
  }
  if (source[at] === '$' && source[at + 1] !== '$') {
    let end = source.indexOf('$', at + 1);
    while (end >= 0 && escaped(source, end)) end = source.indexOf('$', end + 1);
    if (end >= 0 && source[end + 1] !== '$') {
      const tex = source.slice(at + 1, end);
      if (tex && !/\n|^\s|\s$/.test(tex) && (/\\[a-zA-Z]|[_^](?:\{|[a-zA-Z0-9])|(?:^|\s)=(?:\s|$)/.test(tex) || /^[A-Za-z]$/.test(tex))) return end + 1;
    }
  }
  return at;
}

/** Markdown's lexer is authoritative for code, escapes, links and raw HTML.
 * Root raw-HTML blocks beginning with known rich tags are passed to the bounded
 * grammar; unrelated HTML is protected instead of interpreted or repaired.
 */
function lexicalPreflight(source) {
  if (source.length > RICH_LIMITS.message) return false;
  let tags = 0, delimiters = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '<' && ++tags > RICH_LIMITS.nodes) return false;
    if (['{', '}', '[', ']', '`'].includes(source[i]) && ++delimiters > RICH_LIMITS.values) return false;
  }
  return true;
}
export function markdownProtectedRanges(source) {
  if (!lexicalPreflight(source)) fail('Rich lexical budget exceeded');
  const started = Date.now(); let visited = 0;
  const ranges = [];
  // Build the exact closing-tag index once. Repeated unclosed HTML tags must
  // never trigger repeated scans over the entire remaining message.
  const closings = new Map();
  for (const match of source.matchAll(/<\/([A-Za-z][A-Za-z0-9-]*)>/g)) {
    const list = closings.get(match[1]) || []; list.push(match.index); closings.set(match[1], list);
  }
  const closingAt = (name, from) => {
    const list = closings.get(name); if (!list) return -1;
    let low = 0, high = list.length;
    while (low < high) { const mid = (low + high) >>> 1; if (list[mid] < from) low = mid + 1; else high = mid; }
    return list[low] ?? -1;
  };
  const add = (start, end, kind = 'protected') => { if (end > start) ranges.push([start, end, kind]); };
  function walk(tokens, base, region) {
    let cursor = 0;
    for (const token of tokens) {
      if (++visited > RICH_LIMITS.values || Date.now() - started > RICH_LIMITS.milliseconds) fail('Rich Markdown budget exceeded');
      const raw = token.raw || ''; if (!raw) continue;
      const at = region.indexOf(raw, cursor); if (at < 0) continue;
      const start = base + at, end = start + raw.length; cursor = at + raw.length;
      if (['code', 'codespan', 'escape', 'link', 'image'].includes(token.type)) { add(start, end, token.type === 'code' && token.codeBlockStyle === 'indented' ? 'indented' : 'protected'); continue; }
      if (token.type === 'html') {
        const root = raw.match(/^\s*<\/?([A-Za-z][A-Za-z0-9-]*)/);
        if (!root || !TAGS.has(root[1])) {
          let last = end;
          if (root && !/^\s*<\//.test(raw) && !/\/\s*>\s*$/.test(raw)) {
            const close = closingAt(root[1], end);
            if (close >= 0 && close - start <= RICH_LIMITS.span) last = close + root[1].length + 3;
          }
          add(start, last);
        }
        continue;
      }
      if (token.tokens) walk(token.tokens, start, raw);
      if (token.items) walk(token.items, start, raw);
      if (token.type === 'table') {
        // The cell lexer retains its own source; seek within this table only.
        const cells = [...(token.header || []), ...(token.rows || []).flat()]; let pos = 0;
        for (const cell of cells) { const p = raw.indexOf(cell.text, pos); if (p >= 0) { walk(cell.tokens || [], start + p, cell.text); pos = p + cell.text.length; } }
      }
    }
  }
  walk(marked.lexer(source, { gfm: true }), 0, source);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) { const previous = merged.at(-1); if (previous && range[0] <= previous[1] && previous[2] === range[2]) previous[1] = Math.max(previous[1], range[1]); else merged.push(range); }
  return merged;
}

class ComponentParser {
  constructor(source, pos, b, ranges = []) { this.source = source; this.pos = pos; this.start = pos; this.b = b; this.ranges = ranges; }
  check(depth) { depthCheck(depth); tick(this.b); if (this.pos - this.start > RICH_LIMITS.span) fail('Rich span limit exceeded'); }
  ws() { while (this.pos < this.source.length && /\s/.test(this.source[this.pos])) { this.pos++; this.check(0); } }
  brace() {
    if (this.source[this.pos++] !== '{') fail('Expected brace');
    const start = this.pos; let depth = 1, quote = '';
    while (this.pos < this.source.length) {
      this.check(depth);
      const c = this.source[this.pos++];
      if (quote) { if (c === '\\') this.pos++; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return this.source.slice(start, this.pos - 1);
    }
    fail('Unterminated brace');
  }
  staticSvg(depth, root = true, count = { nodes: 0 }) {
    this.check(depth); tick(this.b, 'nodes');
    if (++count.nodes > 256) fail('SVG element limit exceeded');
    const start = this.pos, match = this.source.slice(start).match(/^<(svg|path|circle)(?=[\s/>])/);
    if (!match || (root ? match[1] !== 'svg' : match[1] === 'svg')) fail('Unsupported SVG element');
    const tag = match[1], attrs = Object.create(null); this.pos += match[0].length;
    let selfClosing = false;
    while (true) {
      const previous = this.pos; this.ws();
      if (this.source.startsWith('/>', this.pos)) { this.pos += 2; selfClosing = true; break; }
      if (this.source[this.pos] === '>') { this.pos++; break; }
      if (this.pos === previous) fail('Expected SVG attribute whitespace');
      const keyMatch = this.source.slice(this.pos).match(/^[A-Za-z][A-Za-z0-9-]*/);
      const key = keyMatch?.[0];
      if (!key || !SVG_PROPS[tag].includes(key) || Object.hasOwn(attrs, key)) fail('Unsupported SVG attribute');
      // Camel-case export spellings and standard SVG spellings name the same
      // attribute; accepting both on one shape would make rendering ambiguous.
      const canonical = key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
      if (Object.keys(attrs).some(k => k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`) === canonical)) fail('Duplicate SVG attribute');
      this.pos += key.length; this.ws(); if (this.source[this.pos++] !== '=') fail('Expected SVG attribute value');
      this.ws(); if (!['"', "'"].includes(this.source[this.pos])) fail('SVG values must be quoted literals');
      const lp = new LiteralParser(this.source.slice(this.pos, this.pos + RICH_LIMITS.span), this.b);
      attrs[key] = lp.string(); this.pos += lp.pos; tick(this.b, 'output', attrs[key].length);
    }
    validateSvgAttributes(tag, attrs);
    const children = [];
    if (!selfClosing) {
      while (true) {
        this.ws();
        if (this.source.startsWith(`</${tag}>`, this.pos)) { this.pos += tag.length + 3; break; }
        if (tag !== 'svg' || this.pos >= this.source.length) fail('Unsupported SVG content');
        children.push(this.staticSvg(depth + 1, false, count));
      }
    }
    return { kind: 'static-svg', tag, attrs, children, svgNodes: root ? count.nodes : 1, source: this.source.slice(start, this.pos), inline: false };
  }
  element(depth = 0) {
    if (richTagAt(this.source, this.pos) === 'svg') return this.staticSvg(depth);
    this.check(depth); tick(this.b, 'nodes');
    const start = this.pos, tag = richTagAt(this.source, this.pos); if (!tag) fail('Unsupported component');
    this.pos += tag.length + 1; const attrs = Object.create(null);
    while (true) {
      const previous = this.pos; this.ws();
      if (this.source.startsWith('/>', this.pos)) { this.pos += 2; return { kind: 'element', tag, attrs, children: [], source: this.source.slice(start, this.pos) }; }
      if (this.source[this.pos] === '>') { this.pos++; break; }
      if (this.pos === previous) fail('Expected attribute whitespace');
      const m = this.source.slice(this.pos).match(/^[A-Za-z][A-Za-z0-9]*/); if (!m) fail('Expected attribute name');
      const key = m[0]; keyCheck(key); this.pos += key.length;
      if (!PROPS[tag].includes(key) || Object.hasOwn(attrs, key)) fail('Unsupported or duplicate attribute');
      const afterKey = this.pos; this.ws();
      if (this.source[this.pos] !== '=') {
        if (!['border', 'clip', 'tabularNums', 'inline'].includes(key)) fail('Unsupported presence attribute');
        this.pos = afterKey; attrs[key] = { expression: 'literal', value: true }; continue;
      }
      this.pos++; this.ws();
      const c = this.source[this.pos];
      if (c === '"' || c === "'") {
        const lp = new LiteralParser(this.source.slice(this.pos, this.pos + RICH_LIMITS.span), this.b);
        attrs[key] = { expression: 'literal', value: lp.string() }; this.pos += lp.pos;
      } else if (c === '{') attrs[key] = expression(this.brace(), this.b);
      else {
        const bare = this.source.slice(this.pos).match(/^[A-Za-z-]+/);
        // Only this bare enum is evidenced. Quoted enums use the schema above.
        if (tag !== 'row' || key !== 'align' || !bare || !['start', 'center'].includes(bare[0])) fail('Unsupported bare attribute');
        attrs[key] = { expression: 'literal', value: bare[0] }; this.pos += bare[0].length;
      }
    }
    const children = this.children(depth, `</${tag}>`);
    if (!this.source.startsWith(`</${tag}>`, this.pos)) fail('Mismatched component closing tag');
    this.pos += tag.length + 3;
    return { kind: 'element', tag, attrs, children, source: this.source.slice(start, this.pos) };
  }
  protectedEnd() {
    const at = this.pos;
    const mathEnd = protectedMathEnd(this.source, at); if (mathEnd > at) return mathEnd;
    const r = this.ranges.find(([a, b, kind]) => kind !== 'indented' && a <= at && at < b); if (r) return r[1];
    if (this.source[at] === '`') {
      const token = marked.Lexer.lexInline(this.source.slice(at))[0];
      if (token?.type === 'codespan') return at + token.raw.length;
    }
    if ((at === 0 || this.source[at - 1] === '\n') && /^ {0,3}(?:`{3,}|~{3,})/.test(this.source.slice(at))) {
      const token = marked.lexer(this.source.slice(at))[0]; if (token?.type === 'code') return at + token.raw.length;
    }
    return at;
  }
  children(depth, closing) {
    this.check(depth); const children = []; let text = '';
    const flush = () => { if (text) { children.push({ kind: 'markdown', text }); tick(this.b, 'nodes'); text = ''; } };
    while (this.pos < this.source.length && !this.source.startsWith(closing, this.pos)) {
      this.check(depth); const end = this.protectedEnd();
      if (end > this.pos) { text += this.source.slice(this.pos, end); this.pos = end; continue; }
      if (!escaped(this.source, this.pos) && richTagAt(this.source, this.pos)) { flush(); children.push(this.element(depth + 1)); continue; }
      if (this.source.startsWith('</', this.pos) && /^<\/[A-Za-z]/.test(this.source.slice(this.pos))) fail('Mismatched nested closing tag');
      if (this.source[this.pos] === '{' && !escaped(this.source, this.pos)) {
        flush(); const directiveStart = this.pos; const value = this.brace();
        if (value.startsWith('#each ')) {
          const m = value.slice(6).match(/^([\s\S]+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*([A-Za-z_][A-Za-z0-9_]*))?\s*$/);
          if (!m) fail('Unsupported each directive'); keyCheck(m[2]); if (m[3]) keyCheck(m[3]);
          if (m[2] === m[3]) fail('Duplicate loop binding');
          const iterable = expression(m[1], this.b), body = this.children(depth + 1, '{/each}');
          if (!this.source.startsWith('{/each}', this.pos)) fail('Unterminated each directive'); this.pos += 7;
          children.push({ kind: 'each', iterable, item: m[2], index: m[3], children: body, source: this.source.slice(directiveStart, this.pos) });
        } else if (value.startsWith('#if ')) {
          const test = condition(value.slice(4).trim(), this.b), body = this.children(depth + 1, '{/if}');
          if (!this.source.startsWith('{/if}', this.pos)) fail('Unterminated if directive'); this.pos += 5;
          children.push({ kind: 'if', test, children: body, source: this.source.slice(directiveStart, this.pos) });
        } else if (value.startsWith('#') || value.startsWith('/') || value.startsWith(':')) fail('Unsupported template directive');
        else children.push({ kind: 'bound', expr: expression(value, this.b), source: this.source.slice(directiveStart, this.pos) });
        tick(this.b, 'nodes'); continue;
      }
      text += this.source[this.pos++];
    }
    flush(); return children;
  }
}
function protectChildCode(nodes, b) {
  if (b.codeCache.has(nodes)) return b.codeCache.get(nodes);
  // Source indentation is structural at the component-body level. Identify
  // genuine Markdown code after removing that common indent, before expanding
  // a directive or binding; DOM fallback is too late to recover an each source.
  const slots = []; let skeleton = '';
  nodes.forEach((node, index) => {
    tick(b);
    if (node.kind === 'markdown') skeleton += node.text;
    else { slots.push({ at: skeleton.length, index, node }); skeleton += 'RICHCHILD'; }
  });
  if (!slots.length) { b.codeCache.set(nodes, nodes); return nodes; }
  const lines = skeleton.split('\n');
  const amounts = lines.filter(line => line.trim()).map(line => line.match(/^ */)[0].length);
  const indent = amounts.length ? Math.min(...amounts) : 0;
  let originalStart = 0, nextSlot = 0, dedented = '';
  for (const line of lines) {
    const strip = Math.min(indent, line.match(/^ */)[0].length);
    while (nextSlot < slots.length && slots[nextSlot].at <= originalStart + line.length) {
      slots[nextSlot].dedentedAt = dedented.length + slots[nextSlot].at - originalStart - strip;
      nextSlot++;
    }
    dedented += line.slice(strip) + '\n'; originalStart += line.length + 1;
  }
  const ranges = markdownProtectedRanges(dedented), protectedIndices = new Set(); let rangeIndex = 0;
  for (const slot of slots) {
    while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= slot.dedentedAt) rangeIndex++;
    if (ranges[rangeIndex] && ranges[rangeIndex][0] <= slot.dedentedAt) protectedIndices.add(slot.index);
  }
  const result = nodes.map((node, index) => protectedIndices.has(index) ? { kind: 'markdown', text: node.source || '' } : node);
  b.codeCache.set(nodes, result); return result;
}
function evaluate(nodes, env, b, depth = 0) {
  depthCheck(depth); const out = [];
  for (const node of nodes) {
    tick(b, 'nodes');
    if (node.kind === 'markdown') { tick(b, 'output', node.text.length); out.push(node); }
    else if (node.kind === 'static-svg') { tick(b, 'nodes', node.svgNodes); tick(b, 'output', node.source.length); out.push(node); }
    else if (node.kind === 'bound') {
      const value = resolve(node.expr, env);
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) fail('Text binding is not primitive');
      const text = value === null ? '' : String(value); tick(b, 'output', text.length); out.push({ kind: 'literal', text });
    } else if (node.kind === 'each') {
      const array = resolve(node.iterable, env); if (!Array.isArray(array) || array.length > RICH_LIMITS.array) fail('Each requires a bounded literal array');
      const body = protectChildCode(node.children, b);
      array.forEach((item, index) => {
        tick(b, 'iterations');
        const local = Object.assign(Object.create(null), env); local[node.item] = item; if (node.index) local[node.index] = index;
        out.push(...evaluate(body, local, b, depth + 1));
      });
    } else if (node.kind === 'if') { if (compare(node.test, env)) out.push(...evaluate(protectChildCode(node.children, b), env, b, depth + 1)); }
    else if (node.kind === 'element') {
      const attrs = Object.create(null);
      for (const [key, expr] of Object.entries(node.attrs)) {
        attrs[key] = resolve(expr, env);
        // Count expanded attributes too: a loop must not multiply a large chart
        // literal hundreds of times without consuming the shared output budget.
        tick(b, 'output', JSON.stringify(attrs[key]).length);
      }
      validateAttributes(node.tag, attrs);
      if (['Entity', 'Link', 'Cite', 'Chart', 'AsyncImage', 'AsyncImageGroup', 'icon', 'divider'].includes(node.tag) && node.children.some(child => child.kind !== 'markdown' || child.text.trim())) fail('Terminal component has unsupported children');
      out.push({ kind: 'component', tag: node.tag, attrs, children: evaluate(protectChildCode(node.children, b), env, b, depth + 1), source: node.source, inline: INLINE.has(node.tag) });
    }
  }
  return out;
}
export function parseRichSpan(source) {
  const text = String(source), b = budget(); if (text.length > RICH_LIMITS.span) fail('Rich span limit exceeded');
  const parser = new ComponentParser(text, 0, b, markdownProtectedRanges(text));
  const ast = parser.element(); if (parser.pos !== text.length) fail('Trailing content after rich span');
  return evaluate([ast], Object.create(null), b)[0];
}
function legacyNode(payload, raw, b) {
  tick(b);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const keys = Object.keys(payload); if (keys.length !== 1) return null;
  const family = keys[0], data = payload[family];
  if (family === 'chart' || family === 'charts_widget_v2') {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !own(data, 'content')) return null;
    if (Object.keys(data).some(k => !['content', 'language'].includes(k)) || (data.language !== undefined && data.language !== 'recharts-json')) return null;
    return { kind: 'component', tag: 'Chart', attrs: { content: data.content }, family, children: [], source: raw, inline: false };
  }
  if (family === 'citation' || family === 'refs') {
    const attrs = Array.isArray(data) ? { refs: data } : typeof data === 'string' ? { ref: data } : data;
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return null;
    validateAttributes('Cite', attrs); return { kind: 'component', tag: 'Cite', attrs, children: [], source: raw, inline: true };
  }
  if (family === 'suggest_automation' && data && Object.keys(data).length === 1 && typeof data.label === 'string') {
    return { kind: 'passive', family, text: data.label, source: raw, inline: false };
  }
  if (family === 'map_widget' && data && Object.keys(data).length === 1 && Array.isArray(data.points) && data.points.length <= 128) {
    if (data.points.some(p => !p || typeof p !== 'object' || Object.keys(p).some(k => !['ref', 'name', 'category'].includes(k)) || typeof p.name !== 'string' || (p.category !== undefined && typeof p.category !== 'string'))) return null;
    return { kind: 'passive', family, points: data.points, source: raw, inline: false };
  }
  return null;
}
// Marker names and literal payload shapes follow ChatGPT Export Processor GUI
// 1.1.0. Unlike an export conversion, this creates only transient display nodes;
// unknown markers and protected code remain exact source.
function legacyMarkerNode(name, args, raw, b) {
  const component = (tag, attrs, inline = true) => ({ kind: 'component', tag, attrs: validateAttributes(tag, attrs), children: [], source: raw, inline });
  if (name === 'genui') return legacyNode(parseLiteral(args[0] || '', b), raw, b);
  if (['cite', 'memcite', 'filecite'].includes(name)) {
    const refs = args.filter(value => /^turn\d+(?:search|news|image|file|product|view|fetch|open|reddit|business)\d+$/.test(value));
    return refs.length ? component('Cite', { refs }) : null;
  }
  if (['entity', 'entity_metadata', 'product', 'product_entity'].includes(name)) {
    const data = parseLiteral(args[0] || '', b);
    const value = Array.isArray(data) ? data[1] : plainRecord(data) ? data.name || data.title : null;
    const category = Array.isArray(data) && typeof data[0] === 'string' ? data[0] : 'Saved entity';
    if (typeof value !== 'string') return null;
    return component('Entity', { value, category });
  }
  if (['image', 'images', 'imagegroup', 'image_group'].includes(name)) {
    const data = parseLiteral(args[0] || '', b);
    if (!plainRecord(data)) return null;
    const query = typeof data.query === 'string' ? [data.query] : data.query || data.queries;
    if (!Array.isArray(query)) return null;
    return component('AsyncImageGroup', { query }, false);
  }
  if (name === 'url' && args.length === 2) return component('Link', { title: args[0], url: args[1] });
  return null;
}
function failedSpanEnd(source, start, tag) {
  // Recovery never interprets attributes. It only recognizes an exact balanced
  // lexical boundary, including quoted > and nested same-name components.
  let pos = start, depth = 0;
  while (pos < source.length && pos - start <= RICH_LIMITS.span) {
    if (source[pos] !== '<') { pos++; continue; }
    const head = source.slice(pos).match(/^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/);
    if (!head) { pos++; continue; }
    const closing = !!head[1], current = head[2]; pos += head[0].length;
    let quote = '', braces = 0;
    let previous = '', complete = false;
    while (pos < source.length && pos - start <= RICH_LIMITS.span) {
      const c = source[pos++];
      if (quote) { if (c === '\\') pos++; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '{') braces++;
      else if (c === '}') braces = Math.max(0, braces - 1);
      else if (c === '>' && braces === 0) { complete = true; break; }
      previous = c;
    }
    if (!complete) return source.length;
    if (current === tag) {
      if (closing) depth--; else if (previous !== '/') depth++;
      if (depth <= 0) return pos;
    }
  }
  // An unclosed component has no reliable nested/sibling boundary. Preserve its
  // complete remainder, instead of making a valid-looking widget out of a child.
  return source.length;
}
function opaqueMarker() {
  if (!globalThis.crypto?.getRandomValues) fail('Secure placeholder randomness unavailable');
  const bytes = new Uint32Array(4); globalThis.crypto.getRandomValues(bytes);
  return `TSRICH${Array.from(bytes, b => b.toString(16).padStart(8, '0')).join('')}END`;
}
/** Call before math protection so literal attribute values are never rewritten.
 * The bounded grammar excludes mathematics outside attributes. Placeholders contain 128 random
 * bits and are checked for absence from source; records never come from text. */
export function prepareRichMarkdown(content) {
  const source = String(content ?? ''), records = new Map(), b = budget();
  if (!lexicalPreflight(source)) return { content: source, records, stats: b, literalOnly: true };
  let ranges; try { ranges = markdownProtectedRanges(source); } catch { return { content: source, records, stats: b, literalOnly: true }; }
  let output = '', last = 0, pos = 0, rangeIndex = 0;
  while (pos < source.length && records.size < RICH_LIMITS.fragments) {
    const mathEnd = protectedMathEnd(source, pos); if (mathEnd > pos) { pos = mathEnd; continue; }
    while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= pos) rangeIndex++;
    if (ranges[rangeIndex] && ranges[rangeIndex][0] <= pos) { pos = ranges[rangeIndex][1]; continue; }
    if (Date.now() - b.started > RICH_LIMITS.milliseconds) break;
    const tag = !escaped(source, pos) && richTagAt(source, pos);
    let node = null, end = pos;
    if (tag) {
      const parser = new ComponentParser(source, pos, b, ranges);
      try { const ast = parser.element(); end = parser.pos; node = evaluate([ast], Object.create(null), b)[0]; }
      catch {
        // A failed coherent component remains exact, inert source; later siblings
        // are still considered. Never partially interpret its nested children.
        if (end > pos) { pos = end; continue; }
        end = failedSpanEnd(source, pos, tag);
        pos = Math.max(pos + 1, end); continue;
      }
    } else if (source[pos] === '\ue200') {
      const stop = source.indexOf('\ue201', pos + 1);
      if (stop >= 0 && stop - pos <= RICH_LIMITS.span) {
        end = stop + 1; const raw = source.slice(pos, end);
        const [name, ...args] = source.slice(pos + 1, stop).split(/[\ue202\ue205]/);
        try { node = legacyMarkerNode(name.trim().toLowerCase(), args, raw, b); if (node) tick(b, 'output', raw.length); } catch { /* preserve the original marker */ }
        if (!node) { pos = end; continue; }
      }
    }
    if (node) {
      let marker; try { marker = opaqueMarker(); while (source.includes(marker) || records.has(marker)) marker = opaqueMarker(); } catch { break; }
      b.fragments++; records.set(marker, node); output += source.slice(last, pos) + (node.inline ? marker : `\n\n${marker}\n\n`);
      last = end; pos = end;
    } else pos++;
  }
  return { content: output + source.slice(last), records, stats: b };
}
