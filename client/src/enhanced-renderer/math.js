import { tr } from './locale.js';
const pendingMath = new Map();

const DISPLAY_ENVIRONMENTS = Object.freeze([
  'equation',
  'equation*',
  'align',
  'align*',
  'aligned',
  'gather',
  'gather*',
  'gathered',
  'multline',
  'multline*',
  'split',
  'cases',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix'
]);

function createMathId() {
  const randomPart = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `chatgpt-math-${randomPart}`;
}

function isEscaped(text, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isLineStart(text, index) {
  return index === 0 || text[index - 1] === '\n';
}

function getLineEnd(text, index) {
  const newline = text.indexOf('\n', index);
  return newline === -1 ? text.length : newline;
}

function findFenceEnd(text, start, marker, markerLength) {
  let cursor = getLineEnd(text, start);
  if (cursor < text.length) cursor += 1;

  const closingPattern = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${markerLength},}\\s*$`);

  while (cursor < text.length) {
    const lineEnd = getLineEnd(text, cursor);
    const line = text.slice(cursor, lineEnd).replace(/\r$/, '');
    if (closingPattern.test(line)) {
      return lineEnd < text.length ? lineEnd + 1 : lineEnd;
    }
    cursor = lineEnd < text.length ? lineEnd + 1 : lineEnd;
  }

  return text.length;
}

function findInlineCodeEnd(text, start, markerLength) {
  const marker = '`'.repeat(markerLength);
  const end = text.indexOf(marker, start + markerLength);
  return end === -1 ? text.length : end + markerLength;
}

function findHtmlCodeEnd(text, start, tagName) {
  const closingTag = `</${tagName}>`;
  const end = text.toLowerCase().indexOf(closingTag, start);
  return end === -1 ? text.length : end + closingTag.length;
}

function looksLikeTex(expression) {
  const value = String(expression).trim();
  if (!value) return false;

  return /\\[a-zA-Z]+/.test(value)
    || /[_^](?:\{|[a-zA-Z0-9])/.test(value)
    || /\\begin\s*\{[^}]+\}/.test(value)
    || /(?:^|\s)(?:=|\\approx|\\leq|\\geq|\\times|\\cdot)(?:\s|$)/.test(value);
}

function registerMath(raw, tex, displayMode) {
  const id = createMathId();
  // Plain opaque text survives both inline and block Markdown parsing. The
  // trusted element is created only after archived HTML has been escaped.
  const marker = `TSMATH${id.replace(/[^A-Za-z0-9]/g, '')}END`;
  pendingMath.set(id, {
    raw,
    tex: String(tex).trim(),
    displayMode,
    marker
  });

  return displayMode ? `\n\n${marker}\n\n` : marker;
}

function findClosingDelimiter(text, fromIndex, delimiter) {
  let cursor = fromIndex;
  while (cursor < text.length) {
    const found = text.indexOf(delimiter, cursor);
    if (found === -1) return -1;
    if (!isEscaped(text, found)) return found;
    cursor = found + delimiter.length;
  }
  return -1;
}

function matchDelimitedMath(text, index, opening, closing, displayMode) {
  if (!text.startsWith(opening, index) || isEscaped(text, index)) return null;

  const contentStart = index + opening.length;
  const closeIndex = findClosingDelimiter(text, contentStart, closing);
  if (closeIndex === -1) return null;

  const end = closeIndex + closing.length;
  const raw = text.slice(index, end);
  const tex = text.slice(contentStart, closeIndex);

  if (!tex.trim()) return null;

  return {
    end,
    replacement: registerMath(raw, tex, displayMode)
  };
}

function matchDollarDisplayMath(text, index) {
  if (!text.startsWith('$$', index) || isEscaped(text, index)) return null;

  const contentStart = index + 2;
  let closeIndex = contentStart;

  while (closeIndex < text.length) {
    closeIndex = text.indexOf('$$', closeIndex);
    if (closeIndex === -1) return null;
    if (!isEscaped(text, closeIndex)) break;
    closeIndex += 2;
  }

  const tex = text.slice(contentStart, closeIndex);
  if (!tex.trim()) return null;

  const end = closeIndex + 2;
  return {
    end,
    replacement: registerMath(text.slice(index, end), tex, true)
  };
}

// Support common single-dollar inline math without mistaking currency for TeX.
function matchDollarInlineMath(text, index) {
  if (text[index] !== '$' || text[index + 1] === '$' || isEscaped(text, index)) return null;
  const end = findClosingDelimiter(text, index + 1, '$');
  if (end < 0 || text[end + 1] === '$') return null;
  const tex = text.slice(index + 1, end);
  if (!tex || /\n/.test(tex) || /^\s|\s$/.test(tex) || (!looksLikeTex(tex) && !/^[A-Za-z]$/.test(tex))) return null;
  return { end: end + 1, replacement: registerMath(text.slice(index, end + 1), tex, false) };
}

function matchTexEnvironment(text, index) {
  if (!text.startsWith('\\begin{', index) || isEscaped(text, index)) return null;

  const nameEnd = text.indexOf('}', index + 7);
  if (nameEnd === -1) return null;

  const environment = text.slice(index + 7, nameEnd);
  if (!DISPLAY_ENVIRONMENTS.includes(environment)) return null;

  const closing = `\\end{${environment}}`;
  const closeIndex = text.indexOf(closing, nameEnd + 1);
  if (closeIndex === -1) return null;

  const end = closeIndex + closing.length;
  const raw = text.slice(index, end);

  return {
    end,
    replacement: registerMath(raw, raw, true)
  };
}

function matchPlainBracketDisplayMath(text, index) {
  if (!isLineStart(text, index)) return null;

  const openingLineEnd = getLineEnd(text, index);
  const openingLine = text.slice(index, openingLineEnd).replace(/\r$/, '');
  if (!/^\s*\[\s*$/.test(openingLine)) return null;

  let cursor = openingLineEnd < text.length ? openingLineEnd + 1 : openingLineEnd;

  while (cursor < text.length) {
    const lineEnd = getLineEnd(text, cursor);
    const line = text.slice(cursor, lineEnd).replace(/\r$/, '');

    if (/^\s*\]\s*$/.test(line)) {
      const contentStart = openingLineEnd < text.length ? openingLineEnd + 1 : openingLineEnd;
      const tex = text.slice(contentStart, cursor).replace(/\n$/, '');
      if (!looksLikeTex(tex)) return null;

      const end = lineEnd;
      return {
        end,
        replacement: registerMath(text.slice(index, end), tex, true)
      };
    }

    cursor = lineEnd < text.length ? lineEnd + 1 : lineEnd;
  }

  return null;
}

function matchCodeFence(text, index) {
  if (!isLineStart(text, index)) return null;

  const lineEnd = getLineEnd(text, index);
  const line = text.slice(index, lineEnd).replace(/\r$/, '');
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!match) return null;

  const marker = match[1][0];
  return {
    end: findFenceEnd(text, index, marker, match[1].length)
  };
}

export function clearPendingMath() {
  pendingMath.clear();
}

export function discardMathRecords(ids = []) {
  ids.forEach((id) => pendingMath.delete(id));
}

export function protectMathInMarkdown(content = '') {
  const text = String(content);
  let output = '';
  let index = 0;
  const ids = [];

  while (index < text.length) {
    const fence = matchCodeFence(text, index);
    if (fence) {
      output += text.slice(index, fence.end);
      index = fence.end;
      continue;
    }

    if (text[index] === '`') {
      let markerLength = 1;
      while (text[index + markerLength] === '`') markerLength += 1;
      const end = findInlineCodeEnd(text, index, markerLength);
      output += text.slice(index, end);
      index = end;
      continue;
    }

    if (text[index] === '<') {
      const tagMatch = text.slice(index).match(/^<(pre|code)(?:\s|>)/i);
      if (tagMatch) {
        const end = findHtmlCodeEnd(text, index, tagMatch[1].toLowerCase());
        output += text.slice(index, end);
        index = end;
        continue;
      }
    }

    const beforeCount = pendingMath.size;
    const match = matchPlainBracketDisplayMath(text, index)
      || matchDelimitedMath(text, index, '\\[', '\\]', true)
      || matchDollarDisplayMath(text, index)
      || matchDelimitedMath(text, index, '\\(', '\\)', false)
      || matchDollarInlineMath(text, index)
      || matchTexEnvironment(text, index);

    if (match) {
      output += match.replacement;
      index = match.end;
      if (pendingMath.size > beforeCount) {
        const latestId = Array.from(pendingMath.keys()).at(-1);
        if (latestId) ids.push(latestId);
      }
      continue;
    }

    output += text[index];
    index += 1;
  }

  return { content: output, ids };
}

export function restoreMathPlaceholders(html, ids) {
  if (!ids.length) return html;
  const records = new Map();
  for (const id of ids) {
    const record = pendingMath.get(id);
    if (record) records.set(record.marker, { id, ...record });
  }
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const markerPattern = /TSMATH[A-Za-z0-9]+END/g;
  for (const node of nodes) {
    if (node.parentElement?.closest('code, pre')) continue;
    const value = node.textContent || '';
    markerPattern.lastIndex = 0;
    let last = 0;
    let changed = false;
    const fragment = document.createDocumentFragment();
    for (const match of value.matchAll(markerPattern)) {
      const record = records.get(match[0]);
      if (!record) continue;
      changed = true;
      fragment.append(document.createTextNode(value.slice(last, match.index)));
      const placeholder = document.createElement(record.displayMode ? 'div' : 'span');
      placeholder.className = `chatgpt-math-placeholder chatgpt-math-${record.displayMode ? 'display' : 'inline'}`;
      placeholder.dataset.chatgptMathId = record.id;
      placeholder.textContent = record.raw;
      fragment.append(placeholder);
      last = match.index + match[0].length;
    }
    if (changed) {
      fragment.append(document.createTextNode(value.slice(last)));
      node.replaceWith(fragment);
    }
  }
  return template.innerHTML;
}

function showMathSource(placeholder, record, error) {
  placeholder.classList.add('chatgpt-math-source');
  placeholder.textContent = record?.raw || placeholder.textContent;
  if (error) {
    placeholder.title = `${tr('Equation rendering failed')}: ${error.message || error}`;
  }
}

async function getMathJax() {
  const mathJax = window.MathJax;
  if (!mathJax) {
    throw new Error('The local MathJax bundle is not available.');
  }

  if (mathJax.startup?.promise) {
    await mathJax.startup.promise;
  }

  if (typeof mathJax.tex2svgPromise !== 'function' && typeof mathJax.tex2svg !== 'function') {
    throw new Error('The local MathJax TeX-to-SVG renderer did not initialize.');
  }

  return mathJax;
}

export async function renderMathPlaceholders(container) {
  const placeholders = Array.from(container.querySelectorAll('[data-chatgpt-math-id]'));
  if (placeholders.length === 0) return;

  let mathJax;
  try {
    mathJax = await getMathJax();
    mathJax.texReset?.();
  } catch (error) {
    console.warn('Equation rendering is unavailable; preserving the original source.', error);
    placeholders.forEach((placeholder) => {
      const id = placeholder.dataset.chatgptMathId;
      const record = pendingMath.get(id);
      showMathSource(placeholder, record, error);
      pendingMath.delete(id);
    });
    return;
  }

  for (const placeholder of placeholders) {
    const id = placeholder.dataset.chatgptMathId;
    const record = pendingMath.get(id);
    if (!record) continue;

    try {
      const rendered = typeof mathJax.tex2svgPromise === 'function'
        ? await mathJax.tex2svgPromise(record.tex, { display: record.displayMode })
        : mathJax.tex2svg(record.tex, { display: record.displayMode });

      // With startup.typeset=false, conversion alone does not install MathJax's
      // document stylesheet. It includes the accessible MathML clipping rules;
      // without it both the SVG and its assistive MathML appear visibly.
      mathJax.startup?.document?.updateDocument?.();
      placeholder.replaceChildren(rendered);
      placeholder.classList.remove('chatgpt-math-placeholder');
      placeholder.removeAttribute('data-chatgpt-math-id');
    } catch (error) {
      console.warn('Equation rendering failed; preserving the original source.', error);
      showMathSource(placeholder, record, error);
    } finally {
      pendingMath.delete(id);
    }
  }
}
