import { renderChart } from './rich-charts.js';
import { safeRichUrl, markdownProtectedRanges } from './rich-parser.js';
import { createImageSlot, safeImageUrl } from './images.js';

const SVG = 'http://www.w3.org/2000/svg';
// App-owned, simple line icons. Exported names never become markup or URLs.
const ICONS = Object.freeze({
  'arrow-right': ['M4 12h16', 'm13 5 7 7-7 7'],
  'arrow-down-up': ['M7 3v18', 'm3 17 4 4 4-4', 'M17 21V3', 'm13 7 4-4 4 4'],
  'check-circle': ['M22 11v1a10 10 0 1 1-5.9-9.1', 'm8 11 3 3L22 3'],
  'alert-circle': ['M12 8v5', 'M12 16h.01', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 17v4h16v-4'],
  'file-text': ['M14 2H5v20h14V7z', 'M14 2v6h5', 'M8 12h8', 'M8 16h8'],
  'file-code': ['M14 2H5v20h14V7z', 'M14 2v6h5', 'm10 12-3 3 3 3', 'm14 12 3 3-3 3'],
  server: ['M3 3h18v7H3z', 'M3 14h18v7H3z', 'M6 6h.01', 'M6 17h.01'],
  database: ['M20 6a8 3 0 1 1-16 0 8 3 0 1 1 16 0', 'M4 6v12c0 4 16 4 16 0V6', 'M4 12c0 4 16 4 16 0'],
  sparkles: ['m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z', 'M20 2v4', 'M18 4h4'],
  archive: ['M3 3h18v5H3z', 'M5 8v13h14V8', 'M9 12h6'],
  'badge-check': ['m12 2 3 2 3.5.5.5 3.5 3 4-3 4-.5 3.5-3.5.5-3 2-3-2-3.5-.5L5 16l-3-4 3-4 .5-3.5L9 4z', 'm8 12 3 3 5-6'],
  'file-search': ['M14 2H4v20h12', 'M14 2v6h6v4', 'M20 8l-6-6', 'M20 16a4 4 0 1 1-8 0 4 4 0 1 1 8 0', 'm19 19 3 3'],
  'layout-dashboard': ['M3 3h7v10H3z', 'M14 3h7v6h-7z', 'M3 17h7v4H3z', 'M14 13h7v8h-7z'],
  'panels-top-left': ['M3 3h18v18H3z', 'M3 8h18', 'M9 8v13', 'M6 5.5h.01', 'M9 5.5h.01'],
  type: ['M4 6V3h16v3', 'M12 3v18', 'M8 21h8'],
});
function el(document, tag, className, text) {
  const e = document.createElement(tag); if (className) e.className = className;
  if (text !== undefined) e.textContent = text; return e;
}
function dedent(source) {
  const lines = source.replace(/^\n/, '').split('\n');
  const amounts = lines.filter(line => line.trim()).map(line => line.match(/^ */)[0].length);
  const indent = amounts.length ? Math.min(...amounts) : 0;
  return lines.map(line => line.slice(Math.min(indent, line.match(/^ */)[0].length))).join('\n');
}
function randomMarker() {
  const words = new Uint32Array(4); globalThis.crypto.getRandomValues(words);
  return `TSRICHCHILD${Array.from(words, x => x.toString(16).padStart(8, '0')).join('')}END`;
}
function iconNode(name, options) {
  const { document } = options;
  if (!Object.hasOwn(ICONS, name)) return el(document, 'span', 'rich-icon-fallback', '◇');
  const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 24 24');
  svg.classList.add('rich-icon'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', d);
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); svg.append(path);
  }
  return svg;
}
function applyProperties(element, tag, a) {
  if (a.border) element.classList.add('rich-border');
  if (a.clip) element.classList.add('rich-clip');
  if (a.tabularNums) element.classList.add('rich-tabular');
  if (a.inline) element.classList.add('rich-inline');
  if (a.gap !== undefined) element.style.gap = `${a.gap * .25}rem`;
  if (a.padding !== undefined) element.style.padding = `${a.padding * .25}rem`;
  for (const key of ['width', 'height', 'minWidth', 'maxWidth']) if (a[key] !== undefined) element.style[key] = key === 'minWidth' ? `min(${a[key]}, 100%)` : a[key];
  if (tag === 'box' && a.size) { element.style.width = a.size; element.style.height = a.size; }
  if (a.flex !== undefined) { element.style.flex = `${Number(a.flex)} 1 0px`; element.classList.add('rich-flex-item'); }
  if (a.radius) element.classList.add(`rich-radius-${a.radius}`);
  if (a.direction) element.classList.add(`rich-direction-${a.direction}`);
  if (a.align) element.classList.add(`rich-align-${a.align}`);
  if (a.justify) element.classList.add(`rich-justify-${a.justify}`);
  if (a.textAlign) element.style.textAlign = a.textAlign;
  if (a.wrap) element.style.flexWrap = a.wrap;
  if (a.weight) element.classList.add(`rich-weight-${a.weight}`);
  if (a.color) element.classList.add(`rich-color-${a.color}`);
  if (a.size && tag !== 'box') element.classList.add(`rich-size-${a.size}`);
  if (a.background) {
    if (a.background[0] === '#') { element.style.backgroundColor = a.background; element.classList.add('rich-explicit-color'); }
    else element.classList.add(`rich-${a.background}`);
  }
  if (a.columns) element.style.setProperty('--rich-columns', String(a.columns));
}
function staticSvgNode(node, options) {
  const { document, t } = options;
  const element = document.createElementNS(SVG, node.tag);
  const names = { strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap', strokeLinejoin: 'stroke-linejoin', fillOpacity: 'fill-opacity', strokeOpacity: 'stroke-opacity' };
  for (const [key, value] of Object.entries(node.attrs)) element.setAttribute(names[key] || key, value);
  if (node.tag === 'svg') {
    element.classList.add('rich-static-svg'); element.setAttribute('role', 'img');
    element.setAttribute('aria-label', t('Archived illustration')); element.setAttribute('focusable', 'false');
  }
  for (const child of node.children) element.append(staticSvgNode(child, options));
  return element;
}
function markProgressFill(element, node) {
  // Recognize the bounded, empty percentage-fill pattern from saved layouts.
  // Card surfaces are otherwise left untouched, including explicit swatches.
  const a = node.attrs, meaningful = node.children.filter(c => c.kind !== 'markdown' || c.text.trim());
  // A saved allocation bar uses positive flex weights instead of percentages.
  // Keep its children out of the responsive card minimum-width rule, which
  // otherwise enlarges a small segment and changes the represented ratio.
  if (node.tag === 'box' && a.direction === 'row' && /^\d+(?:\.\d+)?px$/.test(a.height || '') && parseFloat(a.height) > 0 && parseFloat(a.height) <= 32 && a.clip && a.radius === 'full' && /^surface-(?:secondary|tertiary)$/.test(a.background || '') && !a.gap && !a.padding && meaningful.length === 2 && meaningful.every(child => child.tag === 'box' && Number(child.attrs?.flex) > 0 && child.attrs.background && Object.keys(child.attrs).every(key => ['flex', 'background'].includes(key)) && !child.children.some(c => c.kind !== 'markdown' || c.text.trim()))) {
    const segments = [...element.querySelectorAll(':scope > .rich-box')];
    if (segments.length === meaningful.length) {
      element.classList.add('rich-allocation-track');
      segments.forEach((segment, i) => {
        segment.classList.add('rich-allocation-segment');
        const paint = meaningful[i].attrs.background;
        if (paint[0] === '#') segment.style.setProperty('--rich-allocation-paint', paint);
      });
    }
    return;
  }
  if (node.tag !== 'box' || a.width !== '100%' || !/^\d+(?:\.\d+)?px$/.test(a.height || '') || parseFloat(a.height) > 32 || !a.clip || a.radius !== 'full' || !/^surface-(?:secondary|tertiary)$/.test(a.background || '') || meaningful.length !== 1) return;
  const child = meaningful[0], fill = child.attrs;
  if (child.tag !== 'box' || !/^\d+(?:\.\d+)?%$/.test(fill?.width || '') || ![a.height, '100%'].includes(fill.height) || child.children.some(c => c.kind !== 'markdown' || c.text.trim())) return;
  const fillElement = element.querySelector(':scope > .rich-box'); if (!fillElement) return;
  element.classList.add('rich-progress-track'); fillElement.classList.add('rich-progress-fill');
  if (/^surface-(?:secondary|tertiary)$/.test(fill.background || '')) fillElement.classList.add('rich-progress-neutral-fill');
}
function referenceNode(attrs, options) {
  const { document, context, t } = options;
  const span = el(document, 'span', 'rich-citation'); const ids = attrs.refs || [attrs.ref];
  const references = context.references, missingIds = [];
  ids.forEach(id => {
    const record = references instanceof Map ? references.get(id)
      : references && Object.hasOwn(references, id) ? references[id] : null;
    const url = record && safeRichUrl(record.url);
    if (url) {
      // A short host label keeps references from taking over the paragraph.
      // The complete archived title and identity remain available to assistive
      // technology and in the tooltip. No remote favicon request is made.
      const host = new URL(url).hostname.replace(/^www\./, '');
      const a = el(document, 'a', 'rich-citation-link', host || record.title || id); a.href = url;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.title = `${record.title || url}\n${id}`; a.setAttribute('aria-label', `${record.title || url} (${id})`); span.append(a);
    } else missingIds.push(id);
  });
  if (missingIds.length) {
    // List-only search results have no reference binding. Never guess a source
    // from an entry's order/title. Preserve all exact IDs without displaying
    // a long, implementation-specific identifier in the reading paragraph.
    const label = t('Source unavailable');
    const missing = el(document, 'span', 'rich-citation-unresolved', label + (missingIds.length > 1 ? ` +${missingIds.length - 1}` : ''));
    missing.title = `${label}: ${missingIds.join(', ')}`; missing.setAttribute('aria-label', missing.title); span.append(missing);
  }
  return span;
}
function imagePlaceholderDesign(attrs, ancestors = []) {
  // Source-sized thumbnails stay compact even if a row wraps on a narrow
  // screen. An explicit full-width slot remains a landscape at every size.
  // A cap takes precedence over width="100%"; no query text is classified.
  const compact = value => value?.endsWith('px') && parseFloat(value) <= 320;
  if (compact(attrs.width) || compact(attrs.maxWidth)) return 'corner-aperture';
  if (attrs.width === '100%') return 'soft-horizon';
  return ancestors.some(node => node.tag === 'row' || node.attrs?.direction === 'row') ? 'corner-aperture' : 'soft-horizon';
}
function placeholderSvg(document, className, viewBox, parts) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.classList.add(className); svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of parts) {
    const part = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) part.setAttribute(key, value);
    svg.append(part);
  }
  return svg;
}
function unavailableImageNode(tag, attrs, options) {
  const { document, t } = options;
  const area = el(document, 'div', 'rich-image-unavailable');
  const label = t('Image unavailable offline');
  const queries = tag === 'AsyncImageGroup' ? attrs.query || [] : attrs.query ? [attrs.query] : [];
  const description = queries.join(' · ');
  const width = attrs.width || attrs.maxWidth;
  // The export stores a query, not the selected image or its URL. Keep its
  // declared slot beside the accompanying prose, including full-width images;
  // never execute the query or substitute an unrelated photograph.
  if (tag === 'AsyncImage') {
    const design = imagePlaceholderDesign(attrs, options.imageAncestors);
    const wide = design === 'soft-horizon';
    const slotWidth = width || (wide ? undefined : '172px');
    const slotRatio = attrs.aspectRatio || (wide ? undefined : '5:4');
    area.classList.add('rich-image-placeholder', `rich-image-${design}`);
    area.dataset.placeholderDesign = design;
    if (slotWidth) area.style.width = `min(${slotWidth}, 100%)`;
    if (attrs.maxWidth) area.style.maxWidth = `min(${attrs.maxWidth}, 100%)`;
    if (slotRatio) area.style.aspectRatio = slotRatio.replace(':', ' / ');
    // Without both dimensions, retain in-flow content for intrinsic sizing.
    // Absolutely positioned artwork alone would collapse a ratio-only row.
    if (!slotRatio || !slotWidth) area.classList.add('rich-image-natural');
    area.setAttribute('role', 'img'); area.setAttribute('aria-label', [label, description].filter(Boolean).join(': '));
    area.title = [label, description].filter(Boolean).join(': ');
    if (wide) {
      // Terrain stretches with the archived slot; its glyph, sun and caption
      // keep their intended pixel size. These app-owned paths contain no URLs.
      const terrain = placeholderSvg(document, 'rich-image-horizon', '0 0 100 100', [
        ['path', { class: 'rich-image-horizon-back', d: 'M0 80 Q24 45 48 81 T100 70 V100H0Z' }],
        ['path', { class: 'rich-image-horizon-front', d: 'M0 94 Q28 69 53 91 T100 86 V100H0Z' }],
      ]);
      terrain.setAttribute('preserveAspectRatio', 'none'); area.append(terrain);
      area.append(placeholderSvg(document, 'rich-image-horizon-sun', '0 0 24 24', [['circle', { cx: '12', cy: '12', r: '12' }]]));
      area.append(placeholderSvg(document, 'rich-image-placeholder-icon', '0 0 32 32', [
        ['rect', { x: '3.5', y: '4.5', width: '25', height: '23', rx: '3' }],
        ['circle', { cx: '11', cy: '12', r: '2' }],
        ['path', { d: 'm4 23 7-7 5 5 5-7 7 8' }],
      ]));
    } else {
      area.append(placeholderSvg(document, 'rich-image-placeholder-icon', '0 0 50 41', [
        ['path', { class: 'rich-image-aperture-corners', d: 'M11 2H3v8M39 2h8v8M3 31v8h8M47 31v8h-8' }],
        ['path', { d: 'm11 30 10-13 8 10 5-6 6 9' }],
        ['circle', { cx: '35', cy: '12', r: '3' }],
      ]));
    }
  }
  area.append(el(document, 'span', 'rich-offline-label', tag === 'AsyncImage' ? t('Image unavailable') : label));
  if (description) area.append(el(document, 'span', 'rich-image-description', description));
  // Only bind an explicit URL or an exact, caller-provided source identity.
  // A search query by itself is never resolved or sent to a remote service.
  const asset = options.context?.assets?.find(item => item.source === attrs.query && safeImageUrl(item.url));
  if (tag === 'AsyncImage' && (attrs.src || attrs.url || asset)) return createImageSlot(document, {
    url: attrs.src || attrs.url || asset?.url, label: asset?.label || description, placeholder: area,
  });
  return area;
}
// Exact missing-source geometry from Local Reader 4.0.0 R5, reused for regular
// Markdown images as well as rich AsyncImage nodes. Never executes image queries.
export function createMissingImagePlaceholder(document, { compact = false, alt = '', t = value => value } = {}) {
  return unavailableImageNode('AsyncImage', {
    query: alt, width: compact ? '172px' : '100%', aspectRatio: compact ? '5:4' : '16:9',
  }, { document, t });
}
function replaceMarkers(root, records, options) {
  const { document } = options;
  const walker = document.createTreeWalker(root, 4); const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const textNode of texts) {
    const codeContext = Boolean(textNode.parentElement?.closest('pre,code'));
    const text = textNode.nodeValue || '';
    const found = [];
    for (const [marker, record] of records) { let at = text.indexOf(marker); while (at >= 0) { found.push({ at, marker, record }); at = text.indexOf(marker, at + marker.length); } }
    if (!found.length) continue;
    found.sort((a, b) => a.at - b.at); const fragment = document.createDocumentFragment(); let last = 0;
    for (const item of found) {
      fragment.append(document.createTextNode(text.slice(last, item.at)));
      let node;
      try { node = codeContext ? document.createTextNode(item.record.source ?? item.record.text ?? '') : renderRichNode(item.record, options); }
      catch { node = el(document, item.record.inline ? 'span' : 'pre', 'rich-original-source', item.record.source || ''); }
      fragment.append(node); last = item.at + item.marker.length;
    }
    fragment.append(document.createTextNode(text.slice(last)));
    const parent = textNode.parentElement;
    if (parent?.tagName === 'P' && parent.childNodes.length === 1 && found.length === 1 && !found[0].record.inline && text.trim() === found[0].marker) parent.replaceWith(fragment);
    else textNode.replaceWith(fragment);
    if (codeContext) {
      const code = parent?.closest('code');
      if (code) code.dataset.originalCode = code.textContent || '';
    }
  }
}
function renderChildren(element, children, options) {
  const { document, renderMarkdown } = options;
  let source = ''; const records = new Map();
  const allText = children.filter(c => c.kind === 'markdown' || c.kind === 'literal').map(c => c.text).join('');
  for (const child of children) {
    if (child.kind === 'markdown') source += child.text;
    else {
      let marker = randomMarker(); while (allText.includes(marker) || records.has(marker)) marker = randomMarker();
      records.set(marker, child); source += marker;
    }
  }
  // Dedent the original component body before adding Markdown block boundaries.
  // Otherwise a block placeholder at column zero changes the common indent,
  // making later structural prose/icons appear to be indented Markdown code.
  source = dedent(source);
  const protectedRanges = markdownProtectedRanges(source);
  let separated = '', last = 0, protectedIndex = 0;
  for (const match of source.matchAll(/TSRICHCHILD[a-f0-9]{32}END/g)) {
    const child = records.get(match[0]);
    while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex][1] <= match.index) protectedIndex++;
    const insideCode = protectedRanges[protectedIndex] && protectedRanges[protectedIndex][0] <= match.index;
    if (child && !child.inline && child.kind !== 'literal' && !insideCode) {
      separated += source.slice(last, match.index) + `\n\n${match[0]}\n\n`;
      last = match.index + match[0].length;
    }
  }
  source = separated + source.slice(last);
  const template = document.createElement('template'); template.innerHTML = renderMarkdown(source);
  replaceMarkers(template.content, records, options);
  // Layout containers may hold inline Markdown paragraphs as flex/grid items;
  // unwrap only a sole paragraph for text-like elements, preserving GFM blocks.
  if (['text', 'title', 'caption'].includes(element.dataset.richTag) && template.content.childElementCount === 1 && template.content.firstElementChild?.tagName === 'P') {
    template.content.firstElementChild.replaceWith(...template.content.firstElementChild.childNodes);
  }
  element.append(template.content);
}
export function renderRichNode(node, options) {
  const { document, t } = options;
  if (node.kind === 'literal') return document.createTextNode(node.text);
  if (node.kind === 'static-svg') return staticSvgNode(node, options);
  if (node.kind === 'passive') {
    const figure = el(document, 'aside', 'rich-passive');
    if (node.family === 'suggest_automation') {
      figure.append(el(document, 'span', 'rich-passive-label', `${t('Archived suggestion')}: `), document.createTextNode(node.text));
    } else {
      figure.append(el(document, 'div', 'rich-passive-label', t('Archived map locations')));
      const list = el(document, 'ul'); for (const point of node.points) list.append(el(document, 'li', '', point.category ? `${point.name} — ${point.category}` : point.name)); figure.append(list);
    }
    return figure;
  }
  const { tag, attrs: a } = node;
  if (tag === 'Chart') return renderChart(a.content, { document, t, family: node.family || 'Chart' });
  if (tag === 'Entity') {
    const entity = el(document, 'span', 'rich-entity', a.value);
    entity.title = [a.category, a.disambig].filter(Boolean).join(' — '); return entity;
  }
  if (tag === 'Link') {
    const link = el(document, 'a', 'rich-link', a.title || a.url); link.href = a.url;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  }
  if (tag === 'Cite') return referenceNode(a, options);
  if (tag === 'AsyncImage' || tag === 'AsyncImageGroup') {
    return unavailableImageNode(tag, a, options);
  }
  if (tag === 'icon') {
    const span = el(document, 'span', 'rich-icon-wrap'); span.setAttribute('aria-hidden', 'true');
    applyProperties(span, tag, a); span.append(iconNode(a.name || '', options)); return span;
  }
  const htmlTag = tag === 'divider' ? 'hr' : 'div';
  const element = el(document, htmlTag, `rich-component rich-${tag}`); element.dataset.richTag = tag;
  if (tag === 'title') { element.setAttribute('role', 'heading'); element.setAttribute('aria-level', '4'); }
  applyProperties(element, tag, a);
  if (tag !== 'divider') renderChildren(element, node.children, { ...options, imageAncestors: [...(options.imageAncestors || []), node] });
  markProgressFill(element, node);
  return element;
}
/** All exported HTML was already sanitized. Only app-created DOM is inserted;
 * opaque marker lookup is restricted to records generated for this message. */
export function renderRichHtml(html, records, { renderMarkdown, document = globalThis.document, t = k => k, context = {} } = {}) {
  if (!records?.size) return html;
  const template = document.createElement('template'); template.innerHTML = html;
  const options = { document, renderMarkdown, t, context };
  replaceMarkers(template.content, records, options);
  return template.innerHTML;
}
