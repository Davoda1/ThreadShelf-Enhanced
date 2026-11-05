// Adapted from ThreadShelf Local Reader 4.0.0 R11 (MIT). See ATTRIBUTION.md.
// Dependency-free validation. The result must only be assigned to an inert img.src.
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MAX_BYTES = 2 * 1024 * 1024;
const XML_SPACE = /^[\t\n\r ]*$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function skipPrefix(text) {
  let offset = 0;
  while (offset < text.length) {
    while (offset < text.length && /[\t\n\r ]/.test(text[offset])) offset++;
    if (text.slice(offset, offset + 4) !== '<!--') return offset;
    const end = text.indexOf('-->', offset + 4);
    if (end < 0) return -1;
    offset = end + 3;
  }
  return offset;
}

// Reject declarations before XML parsing. Comments and CDATA remain literal.
function forbiddenMarkup(text) {
  for (let offset = text.indexOf('<'); offset >= 0; offset = text.indexOf('<', offset + 1)) {
    if (text.slice(offset, offset + 4) === '<!--') {
      const end = text.indexOf('-->', offset + 4);
      if (end < 0) return true;
      offset = end + 2;
    } else if (text.slice(offset, offset + 9) === '<![CDATA[') {
      const end = text.indexOf(']]>', offset + 9);
      if (end < 0) return true;
      offset = end + 2;
    } else if (/^<\?|^<!(?:DOCTYPE|ENTITY)\b/i.test(text.slice(offset, offset + 12))) {
      return true;
    } else if (!/[/!?]/.test(text[offset + 1] || '')) {
      // Chromium's XML parser can silently accept repeated xmlns attributes.
      // Check raw attribute-name uniqueness, respecting quoted values; leave
      // XML names, nesting and namespace semantics to DOMParser below.
      let cursor = offset + 1;
      while (cursor < text.length && !/[\t\n\r />]/.test(text[cursor])) cursor++;
      const names = new Set();
      while (cursor < text.length) {
        while (cursor < text.length && /[\t\n\r ]/.test(text[cursor])) cursor++;
        if (text[cursor] === '>' || (text[cursor] === '/' && text[cursor + 1] === '>')) break;
        const start = cursor;
        while (cursor < text.length && !/[\t\n\r =/>]/.test(text[cursor])) cursor++;
        const name = text.slice(start, cursor);
        if (!name || names.has(name)) return true;
        names.add(name);
        while (cursor < text.length && /[\t\n\r ]/.test(text[cursor])) cursor++;
        if (text[cursor++] !== '=') return true;
        while (cursor < text.length && /[\t\n\r ]/.test(text[cursor])) cursor++;
        const quote = text[cursor++];
        if (quote !== '"' && quote !== "'") return true;
        const end = text.indexOf(quote, cursor);
        if (end < 0) return true;
        cursor = end + 1;
      }
      if (cursor >= text.length) return true;
      offset = cursor;
    }
  }
  return false;
}

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 16384));
  }
  return globalThis.btoa(binary);
}

/** Return an inert SVG image data URI, or null. Never change the caller's source. */
export function parseSvgPreview(source, rawFence) {
  if (typeof source !== 'string' || !source || source.length > MAX_BYTES) return null;
  if (rawFence != null && typeof rawFence !== 'string') return null;
  const language = String(rawFence || '').trim().toLowerCase();
  if (language && language !== 'svg' && language !== 'xml') return null;
  try {
    let svg = source.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
    if (!svg.startsWith('<')) {
      const uri = /^data:image\/svg\+xml;base64,([\s\S]*)$/i.exec(svg);
      const encoded = (uri ? uri[1] : svg).replace(/[\t\n\r ]/g, '');
      if (!encoded || encoded.length % 4 !== 0 || !BASE64.test(encoded)) return null;
      const binary = globalThis.atob(encoded);
      // atob alone accepts noncanonical padding bits in some engines.
      if (globalThis.btoa(binary) !== encoded || binary.length > MAX_BYTES) return null;
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      svg = new globalThis.TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    }
    const bytes = new globalThis.TextEncoder().encode(svg);
    if (!bytes.length || bytes.length > MAX_BYTES || forbiddenMarkup(svg)) return null;
    const prefix = skipPrefix(svg);
    if (prefix < 0 || !/^<svg(?=[\t\n\r />])/.test(svg.slice(prefix))) return null;
    const parsed = new globalThis.DOMParser().parseFromString(svg, 'image/svg+xml');
    const element = parsed.documentElement;
    // Error-node namespaces differ between XML engines. Conservatively keep
    // any parsererror sentinel in code view, including literal foreign ones.
    if (!element || element.tagName !== 'svg' || parsed.doctype || parsed.getElementsByTagName('parsererror').length) return null;
    if (element.namespaceURI && element.namespaceURI !== SVG_NAMESPACE) return null;
    for (const node of parsed.childNodes) {
      if (node === element || node.nodeType === 8) continue;
      if (node.nodeType === 3 && XML_SPACE.test(node.nodeValue || '')) continue;
      return null;
    }
    // Chat fragments often omit xmlns. Add it to the preview only, after validation.
    if (!element.namespaceURI) {
      if (element.hasAttribute('xmlns')) return null;
      svg = svg.slice(0, prefix + 4) + ' xmlns="' + SVG_NAMESPACE + '"' + svg.slice(prefix + 4);
    }
    return 'data:image/svg+xml;base64,' + encodeBase64(new globalThis.TextEncoder().encode(svg));
  } catch {
    return null;
  }
}

export const SVG_PREVIEW_MAX_BYTES = MAX_BYTES;
