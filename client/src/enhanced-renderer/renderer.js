// Rendering pipeline adapted from ThreadShelf Local Reader by davoda1 (MIT).
// See ATTRIBUTION.md. Source messages are never rewritten by these adapters.
import { marked } from 'marked';
import { highlighter, normalizeCodeLanguage, getCodeLanguageLabel } from './highlight.js';
import { tr } from './locale.js';
import { prepareRichMarkdown } from './rich-parser.js';
import { renderRichHtml } from './rich-renderer.js';
import { referencesFor } from './rich-context.js';
import { mountChartInteractions } from './rich-chart-interactions.js';
import { buildMermaidRepairCandidates } from './mermaid-repair.js';
import { discardMathRecords, protectMathInMarkdown, restoreMathPlaceholders, renderMathPlaceholders } from './math.js';
import { createImageSlot, safeImageUrl, mountImages } from './images.js';
marked.setOptions({
  breaks: true,
  gfm: true,
});

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractLanguageFromClassName(className = '') {
  const match = String(className).match(/(?:^|\s)(?:language|lang)-([^\s]+)/i);
  return match ? match[1] : '';
}

function createMarkedRenderer() {
  const renderer = new marked.Renderer();
  const defaultLink = renderer.link.bind(renderer);

  renderer.code = function code(token) {
    const text = typeof token === 'string' ? token : token?.text || '';
    const lang = typeof token === 'object' ? token?.lang || '' : '';
    const language = normalizeCodeLanguage(lang);
    return `<pre class="language-${language}" data-language="${escapeHtml(getCodeLanguageLabel(language, lang))}"><code class="language-${language}" data-language="${language}">${escapeHtml(text)}</code></pre>\n`;
  };

  renderer.link = function link(token) {
    const html = defaultLink(token);
    return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');
  };

  renderer.image = function image(token) {
    const url = safeImageUrl(token.href) || '';
    return `<span class="archived-image-source" data-image-url="${escapeHtml(url)}" data-image-source="${escapeHtml(token.href || '')}" data-image-label="${escapeHtml(token.text || '')}"></span>`;
  };

  // Raw HTML from archived messages is displayed literally rather than injected.
  // Math placeholders are restored from opaque text after sanitization.
  renderer.html = function html(token) {
    const raw = typeof token === 'string' ? token : token?.raw || token?.text || '';
    return escapeHtml(raw);
  };

  return renderer;
}

const markedRenderer = createMarkedRenderer();

function markCodeBlockLanguage(block, language) {
  const pre = block.closest('pre');
  const className = `language-${language}`;

  block.className = Array.from(block.classList)
    .filter((name) => !/^(?:language|lang)-/i.test(name) && name !== 'hljs')
    .join(' ');
  block.classList.add(className);
  block.dataset.language = language;

  if (pre) {
    pre.classList.remove(...Array.from(pre.classList).filter((name) => /^(?:language|lang)-/i.test(name)));
    pre.classList.add(className);
    if (!pre.dataset.language) pre.dataset.language = getCodeLanguageLabel(language);
  }
}

function highlightCodeBlock(block) {
  const hljs = highlighter;
  // data-language is already canonical. Reinterpreting it as a fence alias would
  // turn the canonical Shell Session grammar into the generic shell/Bash alias.
  const language = block.dataset.language && hljs.getLanguage(block.dataset.language)
    ? block.dataset.language : normalizeCodeLanguage(extractLanguageFromClassName(block.className));
  const rawCode = block.textContent || '';
  block.dataset.originalCode = rawCode;

  markCodeBlockLanguage(block, language);

  // Mermaid fences are rendered as diagrams after the sanitized Markdown is
  // inserted into the document. Preserve their source verbatim here.
  if (language === 'mermaid') return;

  if (hljs && typeof hljs.highlightElement === 'function') {
    try {
      delete block.dataset.highlighted;
      block.removeAttribute('data-highlighted');
      hljs.highlightElement(block);
      block.dataset.highlighted = 'true';
      return;
    } catch (error) {
      console.warn(`Syntax highlighting failed for ${language}; using plain text.`, error);
    }
  }

  block.textContent = rawCode;
  block.classList.add('hljs');
  block.dataset.highlighted = 'true';
}

function sanitizeRenderedHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html;

  const allowedTags = new Set([
    'P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S',
    'CODE', 'PRE', 'A', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
    'SPAN', 'DIV', 'SUP', 'SUB', 'KBD', 'INPUT',
  ]);
  const globalAttrs = new Set(['class', 'title']);
  const perTagAttrs = {
    A: new Set(['href', 'target', 'rel']),
    PRE: new Set(['data-language']),
    CODE: new Set(['data-language', 'data-highlighted', 'data-original-code']),
    SPAN: new Set(['data-chatgpt-math-id', 'data-image-url', 'data-image-source', 'data-image-label']),
    DIV: new Set(['data-chatgpt-math-id']),
    TH: new Set(['align', 'colspan', 'rowspan']),
    TD: new Set(['align', 'colspan', 'rowspan']),
    OL: new Set(['start']),
    INPUT: new Set(['type', 'checked', 'disabled']),
  };

  for (const element of [...template.content.querySelectorAll('*')]) {
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(document.createTextNode(element.textContent || ''));
      continue;
    }

    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      const allowed = globalAttrs.has(name) || perTagAttrs[element.tagName]?.has(name);
      if (!allowed || name.startsWith('on') || name === 'style') {
        element.removeAttribute(attr.name);
      }
    }

    if (element.tagName === 'A') {
      const href = element.getAttribute('href') || '';
      const safe = /^(?:https?:\/\/|mailto:|#)/i.test(href);
      if (!safe) element.removeAttribute('href');
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
    if (element.tagName === 'INPUT') {
      element.setAttribute('type', 'checkbox');
      element.setAttribute('disabled', '');
    }
  }

  template.content.querySelectorAll('pre code').forEach((block) => highlightCodeBlock(block));
  return template.innerHTML;
}

function addCodeBlockControls(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.classList.contains('has-code-controls')) return;
    const code = Array.from(pre.children).find((child) => child.tagName?.toLowerCase() === 'code') || pre.querySelector('code');
    if (!code) return;

    const languageLabel = pre.dataset.language || getCodeLanguageLabel(
      normalizeCodeLanguage(code.dataset.language || extractLanguageFromClassName(code.className)),
    );

    const titlebar = document.createElement('span');
    titlebar.className = 'code-block-titlebar';

    const label = document.createElement('span');
    label.className = 'code-block-language';
    label.textContent = languageLabel;

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'code-copy-button';
    copyButton.textContent = tr('Copy');
    copyButton.setAttribute('aria-label', tr('Copy code block to clipboard'));

    titlebar.append(label, copyButton);
    pre.insertBefore(titlebar, pre.firstChild);
    pre.classList.add('has-code-controls');
  });
}

function upgradeMermaidBlocks(container) {
  const blocks = [];

  container.querySelectorAll('pre.language-mermaid').forEach((pre) => {
    const code = pre.querySelector('code');
    if (!code) return;

    const figure = document.createElement('figure');
    figure.className = 'mermaid-block';
    figure.dataset.mermaidState = 'pending';
    figure.mermaidSource = code.textContent || '';
    figure.mermaidRepairSource = '';
    figure.mermaidRenderSource = figure.mermaidSource;
    figure.mermaidDisplayMode = 'original';
    figure.mermaidOriginalError = null;

    const titlebar = document.createElement('figcaption');
    titlebar.className = 'code-block-titlebar mermaid-titlebar';

    const label = document.createElement('span');
    label.className = 'code-block-language';
    label.textContent = 'Mermaid';

    const rightControls = document.createElement('span');
    rightControls.className = 'mermaid-titlebar-right';

    const versionToggle = document.createElement('button');
    versionToggle.type = 'button';
    versionToggle.className = 'code-copy-button mermaid-copy-button mermaid-version-toggle';
    versionToggle.dataset.toggleMermaidVersion = '1';
    versionToggle.textContent = tr('Repaired');
    versionToggle.hidden = true;
    versionToggle.setAttribute('aria-pressed', 'true');
    versionToggle.setAttribute('aria-label', tr('Showing repaired Mermaid; click to show original'));
    versionToggle.title = tr('Showing repaired version; click to show original');

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'code-copy-button mermaid-copy-button';
    copyButton.dataset.copyMermaid = '1';
    copyButton.dataset.defaultLabel = tr('Copy');
    copyButton.textContent = tr('Copy');
    copyButton.setAttribute('aria-label', tr('Copy displayed Mermaid source to clipboard'));

    const diagram = document.createElement('div');
    diagram.className = 'mermaid-diagram';
    diagram.setAttribute('aria-busy', 'true');
    diagram.setAttribute('aria-label', tr('Mermaid diagram'));

    const loading = document.createElement('span');
    loading.className = 'mermaid-loading';
    loading.textContent = tr('Rendering diagram…');

    rightControls.append(versionToggle, copyButton);
    titlebar.append(label, rightControls);
    diagram.appendChild(loading);
    figure.append(titlebar, diagram);
    pre.replaceWith(figure);
    blocks.push(figure);
  });

  return blocks;
}

function effectiveMermaidTheme() {
  if (document.documentElement.classList.contains('high-contrast') || document.documentElement.dataset.contrast === 'high') return 'dark';
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark' || explicit === 'light') return explicit;
  return 'dark';
}

function configureMermaid() {
  const mermaid = window.mermaid;
  if (!mermaid || typeof mermaid.initialize !== 'function' || typeof mermaid.render !== 'function') {
    return null;
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: effectiveMermaidTheme() === 'dark' ? 'dark' : 'default',
    htmlLabels: false,
    maxTextSize: 50000,
    maxEdges: 500,
    flowchart: { htmlLabels: false },
    secure: [
      'secure',
      'securityLevel',
      'startOnLoad',
      'suppressErrorRendering',
      'theme',
      'themeVariables',
      'themeCSS',
      'fontFamily',
      'htmlLabels',
      'maxTextSize',
      'maxEdges',
    ],
  });
  return mermaid;
}

function mermaidErrorMessage(error) {
  const text = error instanceof Error ? error.message : String(error || 'Unknown Mermaid error');
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function currentMermaidSource(block) {
  if (block?.mermaidDisplayMode === 'repaired' && block.mermaidRepairSource) {
    return block.mermaidRepairSource;
  }
  return block?.mermaidSource || '';
}

function updateMermaidVersionToggle(block, visible = Boolean(block?.mermaidRepairSource)) {
  const button = block?.querySelector('[data-toggle-mermaid-version]');
  if (!button) return;

  button.hidden = !visible;
  if (!visible) return;

  const repaired = block.mermaidDisplayMode === 'repaired';
  button.textContent = repaired ? tr('Repaired') : tr('Original');
  button.setAttribute('aria-pressed', String(repaired));
  button.setAttribute(
    'aria-label',
    repaired
      ? tr('Showing repaired Mermaid; click to show original')
      : tr('Showing original Mermaid; click to show repaired'),
  );
  button.title = repaired
    ? tr('Showing repaired version; click to show original')
    : tr('Showing original version; click to show repaired');
}

function showMermaidSvg(block, svg, mode) {
  const diagram = block.querySelector('.mermaid-diagram');
  if (!diagram) return;
  diagram.innerHTML = svg;
  diagram.removeAttribute('aria-busy');
  block.mermaidDisplayMode = mode;
  block.mermaidRenderSource = mode === 'repaired'
    ? block.mermaidRepairSource || block.mermaidSource || ''
    : block.mermaidSource || '';
  block.dataset.mermaidState = mode === 'repaired' ? 'repaired' : 'rendered';
  updateMermaidVersionToggle(block, Boolean(block.mermaidRepairSource));
}

function showMermaidError(block, error, source = block?.mermaidSource || '', { repairAvailable = false } = {}) {
  const diagram = block.querySelector('.mermaid-diagram');
  if (!diagram) return;

  const message = document.createElement('p');
  message.className = 'mermaid-error-message';
  message.textContent = `${tr('Could not render this Mermaid diagram')}: ${mermaidErrorMessage(error)}`;

  const sourceElement = document.createElement('pre');
  sourceElement.className = 'mermaid-error-source';
  sourceElement.dataset.language = tr('Mermaid source');

  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;

  sourceElement.appendChild(code);
  diagram.replaceChildren(message, sourceElement);
  diagram.removeAttribute('aria-busy');
  block.dataset.mermaidState = repairAvailable ? 'original-error' : 'error';
  block.mermaidDisplayMode = 'original';
  block.mermaidRenderSource = block.mermaidSource || '';
  updateMermaidVersionToggle(block, repairAvailable);
}

function copyTextFallback(text) {
  const previousFocus = document.activeElement;
  const selection = document.getSelection();
  const previousRanges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Copy command rejected');
  } finally {
    textarea.remove();
    previousFocus?.focus?.({ preventScroll: true });
    if (selection && previousRanges.length) {
      selection.removeAllRanges();
      previousRanges.forEach(range => selection.addRange(range));
    }
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Offline previews may deny the async API while still allowing a user-initiated copy command.
    }
  }
  copyTextFallback(text);
}

function showCopyButtonStatus(button, statusText) {
  window.clearTimeout(button.copyStatusTimer);
  button.textContent = statusText;
  button.copyStatusTimer = window.setTimeout(() => {
    button.textContent = button.dataset.defaultLabel || tr('Copy');
  }, 1400);
}


let renderQueue = Promise.resolve();
let renderSequence = 0;

class MermaidRenderer {
  constructor() { this.renderGeneration = ++renderSequence; this.mermaidSequence = 0; }
  async renderMermaidBlocks(blocks, generation) {
    if (generation !== this.renderGeneration) return;
    const mermaid = configureMermaid();
    if (!mermaid) {
      blocks.forEach((block) => {
        block.mermaidRepairSource = '';
        block.mermaidOriginalError = 'The bundled Mermaid renderer did not load.';
        showMermaidError(block, block.mermaidOriginalError);
      });
      return;
    }

    for (const block of blocks) {
      if (generation !== this.renderGeneration || !block.isConnected) return;
      const diagram = block.querySelector('.mermaid-diagram');
      if (!diagram) continue;

      // Respect an explicit Original selection across theme/high-contrast rerenders.
      if (block.mermaidRepairSource && block.mermaidDisplayMode === 'original') {
        showMermaidError(
          block,
          block.mermaidOriginalError || 'The original Mermaid source did not render.',
          block.mermaidSource || '',
          { repairAvailable: true },
        );
        continue;
      }

      // A previously proven repair can be rerendered directly for a theme change.
      if (block.mermaidRepairSource && block.mermaidDisplayMode === 'repaired') {
        const id = `threadshelf-mermaid-repaired-${generation}-${++this.mermaidSequence}`;
        try {
          const { svg } = await mermaid.render(id, block.mermaidRepairSource);
          if (generation !== this.renderGeneration || !block.isConnected) continue;
          showMermaidSvg(block, svg, 'repaired');
        } catch (error) {
          if (generation !== this.renderGeneration || !block.isConnected) continue;
          console.warn('Previously repaired Mermaid failed during rerender; showing original.', error);
          block.mermaidDisplayMode = 'original';
          showMermaidError(
            block,
            block.mermaidOriginalError || error,
            block.mermaidSource || '',
            { repairAvailable: true },
          );
        }
        continue;
      }

      const originalSource = block.mermaidSource || '';
      if (originalSource.length > 50000 || /%%\s*\{|^\s*---|@import|url\s*\(|<\s*(?:script|iframe|object|embed|img|image|foreignObject)\b/i.test(originalSource)) {
        showMermaidError(block, 'Archived configuration or external content is displayed as source.');
        continue;
      }
      const originalId = `threadshelf-mermaid-${generation}-${++this.mermaidSequence}`;
      try {
        const { svg } = await mermaid.render(originalId, originalSource);
        if (generation !== this.renderGeneration || !block.isConnected) continue;
        block.mermaidRepairSource = '';
        block.mermaidOriginalError = null;
        showMermaidSvg(block, svg, 'original');
        updateMermaidVersionToggle(block, false);
        continue;
      } catch (originalError) {
        if (generation !== this.renderGeneration || !block.isConnected) continue;
        block.mermaidOriginalError = originalError;

        const candidates = buildMermaidRepairCandidates(originalSource);
        let repaired = false;
        for (const candidate of candidates) {
          const repairId = `threadshelf-mermaid-auto-repair-${generation}-${++this.mermaidSequence}`;
          try {
            const { svg } = await mermaid.render(repairId, candidate);
            if (generation !== this.renderGeneration || !block.isConnected) return;
            block.mermaidRepairSource = candidate;
            block.mermaidDisplayMode = 'repaired';
            showMermaidSvg(block, svg, 'repaired');
            repaired = true;
            break;
          } catch (repairError) {
            console.debug('Mermaid repair candidate did not render.', repairError);
          }
        }

        if (!repaired) {
          console.warn('Mermaid rendering failed; no deterministic repair succeeded.', originalError);
          block.mermaidRepairSource = '';
          showMermaidError(block, originalError, originalSource, { repairAvailable: false });
        }
      }
    }
  }

  async toggleMermaidVersion(block) {
    if (!block?.mermaidRepairSource) return;

    if (block.mermaidDisplayMode === 'repaired') {
      block.mermaidDisplayMode = 'original';
      showMermaidError(
        block,
        block.mermaidOriginalError || 'The original Mermaid source did not render.',
        block.mermaidSource || '',
        { repairAvailable: true },
      );
      return;
    }

    const mermaid = configureMermaid();
    if (!mermaid) return;
    const diagram = block.querySelector('.mermaid-diagram');
    if (!diagram) return;

    diagram.setAttribute('aria-busy', 'true');
    const id = `threadshelf-mermaid-toggle-repair-${++this.mermaidSequence}`;
    try {
      const { svg } = await mermaid.render(id, block.mermaidRepairSource);
      if (!block.isConnected) return;
      block.mermaidDisplayMode = 'repaired';
      showMermaidSvg(block, svg, 'repaired');
    } catch (error) {
      if (!block.isConnected) return;
      console.warn('Stored Mermaid repair failed to rerender.', error);
      block.mermaidDisplayMode = 'original';
      showMermaidError(
        block,
        block.mermaidOriginalError || error,
        block.mermaidSource || '',
        { repairAvailable: true },
      );
    }
  }

}

let assetsReady;
function loadScript(name) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `/renderer/${name}`;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Bundled renderer asset could not load: ${name}`));
    document.head.append(script);
  });
}
function loadAssets() {
  if (!assetsReady) assetsReady = (async () => {
    window.MathJax = {
      options: { enableMenu: false },
      startup: { typeset: false },
      svg: { fontCache: 'local' },
      // These packages are already bundled. Archived TeX cannot download
      // extensions or run HTML/link commands.
      tex: { packages: ['base', 'ams', 'newcommand', 'noundefined', 'configmacros'] },
    };
    await Promise.all([loadScript('mathjax-tex-svg.js'), loadScript('mermaid.min.js')]);
    await window.MathJax?.startup?.promise;
  })();
  return assetsReady;
}

export function mountMarkdown(container, text, { metadata, assets = [] } = {}) {
  let active = true;
  const mathIds = [];
  const plainMarkdown = value => {
    const math = protectMathInMarkdown(value);
    mathIds.push(...math.ids);
    return restoreMathPlaceholders(sanitizeRenderedHtml(marked.parse(math.content, { renderer: markedRenderer })), math.ids);
  };
  const context = { ...referencesFor({ metadata }), assets };
  try {
    const rich = prepareRichMarkdown(text);
    container.innerHTML = rich.literalOnly
      ? `<pre class="rich-original-source">${escapeHtml(text)}</pre>`
      : renderRichHtml(plainMarkdown(rich.content), rich.records, { renderMarkdown: plainMarkdown, t: tr, context });
  } catch {
    discardMathRecords(mathIds);
    container.textContent = text;
  }
  for (const marker of container.querySelectorAll('.archived-image-source')) {
    const asset = assets.find(item => item.source === marker.dataset.imageSource && safeImageUrl(item.url));
    marker.replaceWith(createImageSlot(document, { url: asset?.url || marker.dataset.imageUrl, label: marker.dataset.imageLabel || asset?.label }));
  }
  const referencedUrls = new Set([...container.querySelectorAll('[data-image-url]')].map(node => node.dataset.imageUrl));
  const attachments = document.createElement('div');
  attachments.className = 'archived-image-attachments';
  attachments.setAttribute('aria-label', 'Saved image attachments');
  for (const asset of assets.slice(0, 256)) {
    const url = safeImageUrl(asset.url);
    if (!url || referencedUrls.has(url)) continue;
    referencedUrls.add(url);
    attachments.append(createImageSlot(document, { url, label: asset.label || asset.source || 'Saved attachment' }));
  }
  if (attachments.childNodes.length) container.append(attachments);
  for (const table of container.querySelectorAll('table')) {
    if (table.closest('.rich-chart')) continue;
    const viewport = document.createElement('div');
    viewport.className = 'markdown-table-scroll'; viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'Scrollable table');
    table.replaceWith(viewport); viewport.append(table);
  }
  const blocks = upgradeMermaidBlocks(container);
  addCodeBlockControls(container);
  const renderer = new MermaidRenderer();
  const disposeCharts = mountChartInteractions(container);
  const disposeImages = mountImages(container);
  const controller = new AbortController();
  container.addEventListener('click', async event => {
    const button = event.target.closest?.('.code-copy-button');
    if (!button || !container.contains(button)) return;
    const diagram = button.closest('.mermaid-block');
    if (button.hasAttribute('data-toggle-mermaid-version')) {
      renderQueue = renderQueue.catch(() => {}).then(() => active && renderer.toggleMermaidVersion(diagram));
      return;
    }
    const code = button.closest('pre')?.querySelector('code');
    const source = diagram ? currentMermaidSource(diagram) : code?.dataset.originalCode ?? code?.textContent ?? '';
    try { await copyTextToClipboard(source); if (active) showCopyButtonStatus(button, 'Copied'); }
    catch { if (active) showCopyButtonStatus(button, 'Copy failed'); }
  }, { signal: controller.signal });

  const renderAsync = (math = false) => {
    const generation = renderer.renderGeneration;
    renderQueue = renderQueue.catch(() => {}).then(async () => {
      if (!active || generation !== renderer.renderGeneration) return;
      try { await loadAssets(); } catch { /* Individual renderers preserve source on failure. */ }
      if (!active || generation !== renderer.renderGeneration) return;
      if (math) await renderMathPlaceholders(container);
      if (active) await renderer.renderMermaidBlocks(blocks, generation);
    });
  };
  if (mathIds.length || blocks.length) renderAsync(true);
  const themeObserver = new MutationObserver(() => {
    if (!blocks.length) return;
    renderer.renderGeneration = ++renderSequence;
    renderAsync();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    active = false; renderer.renderGeneration = -1;
    controller.abort(); themeObserver.disconnect(); disposeCharts(); disposeImages();
    discardMathRecords(mathIds);
    container.querySelectorAll('.code-copy-button').forEach(button => window.clearTimeout(button.copyStatusTimer));
  };
}
