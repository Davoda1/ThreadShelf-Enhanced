// Adapted from the ThreadShelf Local Reader JSON display adapter.
// Display-only JSON handling. Never round-trip through JSON.parse/stringify:
// doing so would lose duplicate keys, large integer digits and number spelling.
const MAX_SOURCE_LENGTH = 1024 * 1024;
const MAX_OUTPUT_LENGTH = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const numberToken = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const whitespace = (character) =>
  character === ' ' || character === '\t' || character === '\r' || character === '\n';

function jsonEnvelopeOnly(text) {
  // Objects need a quoted member name; arrays need a JSON value. In particular,
  // Markdown links/images/reference labels must not become JSON code blocks.
  if (text[0] === '{') {
    if (!/^\{\s*(?:}|"(?:[^"\\]|\\[\s\S])*"\s*:)/.test(text)) return false;
  } else if (text[0] === '[') {
    if (
      !/^\[\s*(?:[[\]{}]|"(?:[^"\\]|\\[\s\S])*"\s*(?:[,\]]|$)|(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(?:[,\]]|$))/.test(
        text,
      )
    )
      return false;
  } else return false;

  let depth = 0,
    quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '\\') index++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') {
      if (--depth <= 0) return !text.slice(index + 1).trim();
    }
  }
  // A clearly JSON-shaped, truncated response remains readable, but its missing
  // text/values are never guessed. The formatter below will retain it verbatim.
  return depth > 0;
}

function formatTokens(text) {
  let index = 0,
    outputLength = 0;
  const output = [];
  const fail = () => {
    throw new Error('JSON response requires a speculative repair');
  };
  const emit = (value) => {
    outputLength += value.length;
    if (outputLength > MAX_OUTPUT_LENGTH) fail();
    output.push(value);
  };
  const skip = () => {
    while (whitespace(text[index])) index++;
  };
  const line = (depth) => emit('\n' + '  '.repeat(depth));
  const string = () => {
    if (text[index] !== '"') fail();
    const pieces = ['"'];
    index++;
    let start = index;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        pieces.push(text.slice(start, ++index));
        return pieces.join('');
      }
      if (character === '\\') {
        const escape = text[++index];
        if (escape === 'u') {
          if (!/^[\da-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) fail();
          index += 5;
        } else if (escape && '"\\/bfnrt'.includes(escape)) index++;
        else fail();
      } else if (character.charCodeAt(0) < 0x20) {
        pieces.push(text.slice(start, index), JSON.stringify(character).slice(1, -1));
        start = ++index;
      } else index++;
    }
    fail();
  };
  const value = (depth) => {
    if (depth > MAX_DEPTH) fail();
    skip();
    const character = text[index];
    if (character === '"') {
      emit(string());
      return;
    }
    if (character === '{' || character === '[') {
      const object = character === '{',
        close = object ? '}' : ']';
      emit(character);
      index++;
      skip();
      if (text[index] === close) {
        emit(close);
        index++;
        return;
      }
      while (index < text.length) {
        line(depth + 1);
        if (object) {
          emit(string());
          skip();
          if (text[index++] !== ':') fail();
          emit(': ');
        }
        value(depth + 1);
        skip();
        if (text[index] === close) {
          index++;
          line(depth);
          emit(close);
          return;
        }
        if (text[index++] !== ',') fail();
        skip();
        // Removing a trailing comma after a complete value does not invent or
        // discard a key/value. Other syntax errors fall back to original text.
        if (text[index] === close) {
          index++;
          line(depth);
          emit(close);
          return;
        }
        emit(',');
      }
      fail();
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) {
        emit(literal);
        index += literal.length;
        return;
      }
    }
    numberToken.lastIndex = index;
    const number = numberToken.exec(text);
    if (!number) fail();
    emit(number[0]);
    index = numberToken.lastIndex;
  };
  value(0);
  skip();
  if (index !== text.length) fail();
  return output.join('');
}

/** Return JSON code text for a raw AI-only response, or null for normal Markdown.
 * Formatting and conservative repairs affect only the returned display string.
 * Callers keep the original message for copy-message, bookmarks and all storage.
 */
export function formatJsonResponse(content, role) {
  if (
    !['ai', 'assistant', 'thinking'].includes(role) ||
    typeof content !== 'string' ||
    content.length > MAX_SOURCE_LENGTH
  )
    return null;
  const firstLine = content.match(/^[^\S\r\n]*\S[^\r\n]*/m)?.[0] || '';
  if (/^(?: {4}| {0,3}\t)/.test(firstLine)) return null;
  const text = content.trim();
  if (!jsonEnvelopeOnly(text)) return null;
  try {
    return formatTokens(text);
  } catch {
    return text;
  }
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const thoughtsKeys = new Set(['content_type', 'source_analysis_msg_id', 'thoughts']);
const thoughtKeys = new Set(['chunks', 'content', 'finished', 'summary']);

// JSON.parse would silently discard earlier duplicate members. Scan the valid
// source first, including equivalent escaped key spellings, so ambiguous data
// never qualifies for automatic hiding. The scan does not change the source.
function hasAmbiguousKeys(text) {
  const stack = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '{' || character === '[') {
      stack.push(character === '{' ? new Set() : null);
      if (stack.length > MAX_DEPTH) return true;
    } else if (character === '}' || character === ']') stack.pop();
    else if (character === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === '\\') index += 2;
        else if (text[index] === '"') break;
        else index++;
      }
      let next = index + 1;
      while (whitespace(text[next])) next++;
      if (text[next] !== ':') continue;
      const keys = stack[stack.length - 1];
      if (!keys) return true;
      const key = JSON.parse(text.slice(start, index + 1));
      if (keys.has(key)) return true;
      keys.add(key);
    }
  }
  return false;
}

/** Only the Reader's known empty thoughts/search-status export envelope hides
 * automatically. Empty arrays/objects, false, zero, errors and unknown fields
 * remain visible. Parsing is used only for classification, never for display.
 */
export function isEmptyThoughtsResponse(content, role) {
  if (
    !['ai', 'assistant', 'thinking'].includes(role) ||
    typeof content !== 'string' ||
    content.length > MAX_SOURCE_LENGTH ||
    !content.includes('"content_type"') ||
    !content.includes('"source_analysis_msg_id"')
  )
    return false;
  const firstLine = content.match(/^[^\S\r\n]*\S[^\r\n]*/m)?.[0] || '';
  if (/^(?: {4}| {0,3}\t)/.test(firstLine)) return false;
  const text = content.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return false;
  let data;
  try {
    data = JSON.parse(text);
    if (hasAmbiguousKeys(text)) return false;
  } catch {
    return false;
  }
  if (
    !record(data) ||
    data.content_type !== 'thoughts' ||
    !Array.isArray(data.thoughts) ||
    Object.keys(data).some((key) => !thoughtsKeys.has(key)) ||
    typeof data.source_analysis_msg_id !== 'string' ||
    !data.source_analysis_msg_id.trim()
  )
    return false;
  return data.thoughts.every(
    (thought) =>
      record(thought) &&
      Object.keys(thought).every((key) => thoughtKeys.has(key)) &&
      (thought.content == null ||
        (typeof thought.content === 'string' && !thought.content.trim())) &&
      (thought.chunks === undefined ||
        (Array.isArray(thought.chunks) && thought.chunks.length === 0)) &&
      (thought.summary == null || typeof thought.summary === 'string') &&
      (thought.finished === undefined || typeof thought.finished === 'boolean'),
  );
}

/** View policy only: callers keep original turns, indexes and export payloads. */
export function shouldHideJsonResponse(content, role, visibility) {
  if (visibility === 'show-all') return false;
  if (visibility === 'hide-empty') return isEmptyThoughtsResponse(content, role);
  return visibility === 'hide-all' && formatJsonResponse(content, role) !== null;
}

/** A fence longer than any backtick run cannot be closed by JSON string data. */
export function jsonResponseMarkdown(content, role) {
  const formatted = formatJsonResponse(content, role);
  if (formatted === null) return null;
  let fenceLength = 3;
  for (const match of formatted.matchAll(/`+/g))
    fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  return `${fence}json\n${formatted}\n${fence}`;
}
