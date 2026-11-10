// Archived HTML is a small formatting language, never application markup.
// Reconstruct validated tokens without parsing untrusted source into a live DOM.
// The final renderer sanitizer repeats attribute/style validation defensively.
export const SAFE_HTML_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
  'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 'ins', 'del', 's',
  'code', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'sup', 'sub', 'kbd', 'mark', 'span', 'div', 'small', 'abbr', 'time',
  'details', 'summary', 'dl', 'dt', 'dd', 'samp', 'var', 'wbr',
  'a',
]);
const VOID_TAGS = new Set(['br', 'hr', 'wbr']);
const MAX_TAG_LENGTH = 8192;
const MAX_STYLE_LENGTH = 1024;
const COLOR_NAMES = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor').split(' '));

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeText(value) {
  // Character references remain text when the reconstructed HTML is parsed.
  // Escaped tags therefore stay literal rather than becoming HTML a second time.
  return escapeHtml(value).replace(/&amp;((?:#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, '&$1');
}

function hasControls(value, includeSpace = false) {
  return [...value].some(char => char.codePointAt(0) <= (includeSpace ? 32 : 31) || char.codePointAt(0) === 127);
}

function boundedNumber(value, max, percent = false) {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(value)) return false;
  if (value.endsWith('%')) return percent && Number(value.slice(0, -1)) <= 100;
  return Number(value) <= max;
}

function safeColor(value) {
  if (COLOR_NAMES.has(value) || /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(value)) return true;
  const match = /^(rgb|rgba|hsl|hsla)\(([^()]*)\)$/.exec(value);
  if (!match) return false;
  const body = match[2].trim();
  const comma = body.includes(',');
  let channels, alpha;
  if (comma) {
    if (body.includes('/')) return false;
    const pieces = body.split(',').map(part => part.trim());
    if (pieces.length !== 3 && pieces.length !== 4) return false;
    channels = pieces.slice(0, 3);
    alpha = pieces[3];
  } else {
    const pieces = body.split('/').map(part => part.trim());
    if (pieces.length > 2) return false;
    channels = pieces[0].split(/\s+/);
    alpha = pieces[1];
  }
  if (channels.length !== 3 || (alpha !== undefined && !boundedNumber(alpha, 1, true))) return false;
  if (match[1].startsWith('rgb')) return channels.every(channel => boundedNumber(channel, 255, true));
  const hue = channels[0].replace(/deg$/, '');
  return boundedNumber(hue, 360) && channels.slice(1).every(channel => channel.endsWith('%') && boundedNumber(channel, 100, true));
}

/** Return canonical safe CSS, or null if ANY declaration is unsupported. */
export function sanitizeInlineStyle(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_STYLE_LENGTH) return null;
  // Reject escapes, comments, entity tricks, variables, functions other than
  // our numeric color grammar, and all control characters before CSS parsing.
  if (hasControls(raw) || /[\\<>&@!]/.test(raw) || /\/\*|\*\//.test(raw)) return null;
  const declarations = raw.split(';').map(part => part.trim()).filter(Boolean);
  if (declarations.length > 12) return null;
  const seen = new Set();
  const output = [];
  for (const declaration of declarations) {
    const match = /^([a-z-]+)\s*:\s*(.+)$/i.exec(declaration);
    if (!match) return null;
    const property = match[1].toLowerCase();
    const value = match[2].trim().toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(property)) return null;
    seen.add(property);
    let safe;
    switch (property) {
      case 'color': case 'background-color': safe = safeColor(value); break;
      case 'font-weight': safe = /^(?:normal|bold|bolder|lighter|[1-9]00)$/.test(value); break;
      case 'font-style': safe = /^(?:normal|italic|oblique)$/.test(value); break;
      case 'text-decoration': case 'text-decoration-line':
        safe = /^(?:none|underline|line-through|overline|underline line-through|line-through underline)$/.test(value); break;
      case 'text-align': safe = /^(?:left|right|center|justify|start|end)$/.test(value); break;
      case 'vertical-align': safe = /^(?:baseline|sub|super|middle|text-top|text-bottom|top|bottom)$/.test(value); break;
      default: return null;
    }
    if (!safe) return null;
    output.push(`${property}:${value}`);
  }
  return output.join(';');
}

function safeLink(value) {
  if (!value || value.length > 4096 || hasControls(value, true) || /[\\<>]/.test(value)) return null;
  if (/^#[A-Za-z0-9_.:-]+$/.test(value)) return value;
  if (/^mailto:[^?\s]+(?:\?[^\s]*)?$/i.test(value)) return value;
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password || !url.hostname ? null : value;
  } catch { return null; }
}

/** Validate an archived attribute. null rejects it; '' is a valid empty value. */
export function safeHtmlAttribute(tag, name, value) {
  tag = String(tag).toLowerCase();
  name = String(name).toLowerCase();
  if (!SAFE_HTML_TAGS.has(tag) || typeof value !== 'string') return null;
  if (name === 'style') return sanitizeInlineStyle(value);
  if (name === 'title') return value.length <= 1024 && !hasControls(value) ? value : null;
  if (name === 'lang') return /^[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,4}$/i.test(value) ? value : null;
  if (name === 'dir') return /^(?:ltr|rtl|auto)$/i.test(value) ? value.toLowerCase() : null;
  if (tag === 'a' && name === 'href') return safeLink(value);
  if ((tag === 'th' || tag === 'td') && (name === 'colspan' || name === 'rowspan'))
    return /^(?:[1-9]\d?|100)$/.test(value) ? value : null;
  if ((tag === 'th' || tag === 'td') && name === 'align')
    return /^(?:left|right|center)$/i.test(value) ? value.toLowerCase() : null;
  if (tag === 'th' && name === 'scope') return /^(?:row|col|rowgroup|colgroup)$/.test(value) ? value : null;
  if ((tag === 'ol' && name === 'start') || (tag === 'li' && name === 'value'))
    return /^-?\d{1,7}$/.test(value) && Math.abs(Number(value)) <= 1_000_000 ? String(Number(value)) : null;
  if (tag === 'time' && name === 'datetime')
    return /^[0-9TZW:+. -]{1,64}$/.test(value) ? value : null;
  if (tag === 'details' && name === 'open') return value === '' || value.toLowerCase() === 'open' ? '' : null;
  return null;
}

function renderTag(raw) {
  if (raw.length > MAX_TAG_LENGTH) return escapeHtml(raw);
  const match = /^<(\/?)([a-z][a-z0-9]*)([\s\S]*?)>$/i.exec(raw);
  if (!match) return escapeHtml(raw);
  const closing = !!match[1];
  const tag = match[2].toLowerCase();
  if (!SAFE_HTML_TAGS.has(tag)) return escapeHtml(raw);
  let rest = match[3];
  if (closing) return /^\s*$/.test(rest) && !VOID_TAGS.has(tag) ? `</${tag}>` : escapeHtml(raw);
  if (/\/\s*$/.test(rest)) {
    if (!VOID_TAGS.has(tag)) return escapeHtml(raw);
    rest = rest.replace(/\/\s*$/, '');
  }
  const attributes = [];
  const seen = new Set();
  while (rest.trim()) {
    // Require whitespace separators and a complete quoted/unquoted value.
    const attr = /^\s+([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/i.exec(rest);
    if (!attr) return escapeHtml(raw);
    const name = attr[1].toLowerCase();
    if (seen.has(name)) return escapeHtml(raw);
    seen.add(name);
    const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
    const safe = safeHtmlAttribute(tag, name, value);
    if (safe === null) return escapeHtml(raw);
    if (name !== 'style' || safe) attributes.push(`${name}="${escapeHtml(safe)}"`);
    rest = rest.slice(attr[0].length);
  }
  if (tag === 'a') attributes.push('target="_blank"', 'rel="noopener noreferrer"');
  return `<${tag}${attributes.length ? ' ' + attributes.join(' ') : ''}>`;
}

/** Marked's html-token hook. Never use this to parse code-fence payloads. */
export function renderSafeHtml(raw) {
  const source = String(raw ?? '');
  const output = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) { output.push(escapeText(source.slice(cursor))); break; }
    output.push(escapeText(source.slice(cursor, start)));
    // Comments/declarations are source too; don't interpret nested tags in them.
    if (source.startsWith('<!--', start)) {
      const close = source.indexOf('-->', start + 4);
      const end = close < 0 ? source.length : close + 3;
      output.push(escapeHtml(source.slice(start, end)));
      cursor = end;
      continue;
    }
    let quote = '', end = start + 1;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === source.length) { output.push(escapeHtml(source.slice(start))); break; }
    output.push(renderTag(source.slice(start, end + 1)));
    cursor = end + 1;
  }
  return output.join('');
}
