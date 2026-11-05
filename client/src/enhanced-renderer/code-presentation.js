// Keep syntax-highlighted source separate from presentation-only line numbers.
// Splitting a multiline token clones its element ancestry rather than flattening
// HTML or re-highlighting lines independently (which loses multiline grammars).
import { tr } from './locale.js';

export const MAX_NUMBERED_CODE_LINES = 10_000;

function exceedsLineLimit(source) {
  let lines = 1;
  let offset = source.indexOf('\n');
  while (offset !== -1) {
    if (++lines > MAX_NUMBERED_CODE_LINES) return true;
    offset = source.indexOf('\n', offset + 1);
  }
  return false;
}

function highlightedLines(code) {
  const doc = code.ownerDocument;
  const lines = [doc.createDocumentFragment()];
  const ancestors = [];
  let copies = [];
  const parent = () => copies.at(-1) || lines.at(-1);
  const nextLine = () => {
    lines.push(doc.createDocumentFragment());
    copies = [];
    for (const ancestor of ancestors) {
      const clone = ancestor.cloneNode(false);
      parent().append(clone);
      copies.push(clone);
    }
  };
  const visit = node => {
    if (node.nodeType === 3) {
      const pieces = (node.nodeValue || '').split('\n');
      pieces.forEach((piece, index) => {
        if (index) nextLine();
        if (piece) parent().append(doc.createTextNode(piece));
      });
    } else if (node.nodeType === 1) {
      const clone = node.cloneNode(false);
      parent().append(clone);
      ancestors.push(node);
      copies.push(clone);
      for (const child of node.childNodes) visit(child);
      ancestors.pop();
      copies.pop();
    }
  };
  for (const child of code.childNodes) visit(child);
  return lines;
}

export function applyCodeBlockPresentation(pre, { codeWrap = false, codeLineNumbers = false } = {}) {
  pre.classList.toggle('code-wrap', codeWrap);
  const code = pre.querySelector('code');
  if (!code || !codeLineNumbers || pre.classList.contains('code-line-numbers')) return;
  // Do not turn a generated file with hundreds of thousands of lines into
  // hundreds of thousands of extra DOM elements. Source remains complete.
  if (exceedsLineLimit(code.dataset.originalCode ?? code.textContent ?? '')) {
    const note = code.ownerDocument.createElement('span');
    note.className = 'code-block-note';
    note.textContent = tr('Line numbers unavailable for this large block');
    const titlebar = pre.querySelector('.code-block-titlebar');
    if (titlebar) titlebar.querySelector('.code-block-language')?.after(note);
    else pre.prepend(note);
    pre.dataset.lineNumbersLimited = 'true';
    return;
  }
  const lines = highlightedLines(code);
  const fragment = code.ownerDocument.createDocumentFragment();
  lines.forEach((content, index) => {
    const line = code.ownerDocument.createElement('span');
    line.className = 'code-line';
    const number = code.ownerDocument.createElement('span');
    number.className = 'code-line-number';
    number.setAttribute('aria-hidden', 'true');
    number.setAttribute('role', 'presentation');
    // The numeral is CSS generated content on an empty, unselectable element.
    // It cannot enter textContent, clipboard source, or conversation exports.
    number.dataset.lineNumber = String(index + 1);
    const source = code.ownerDocument.createElement('span');
    source.className = 'code-line-source';
    source.append(content);
    // A visually empty block is omitted by native browser text selection. An
    // explicit break retains an internal empty source line without adding text
    // (or a placeholder character) to the canonical code. The final empty row
    // already represents the preceding newline and must not add a second one.
    if (!source.textContent && index < lines.length - 1) {
      source.append(code.ownerDocument.createElement('br'));
    }
    line.append(number, source);
    fragment.append(line);
    if (index < lines.length - 1) fragment.append(code.ownerDocument.createTextNode('\n'));
  });
  code.replaceChildren(fragment);
  pre.classList.add('code-line-numbers');
  pre.style.setProperty('--code-line-digits', String(String(lines.length).length));
}
