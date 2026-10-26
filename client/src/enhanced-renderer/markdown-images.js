// Image controllers and six placeholder designs adapted from ThreadShelf Local Reader 4.0.0 R5 (MIT).
// See ATTRIBUTION.md. Network loads are routed through the local server in this port.
import { createMissingImagePlaceholder } from './rich-renderer.js';

const RASTER_DATA = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i;
const isDataSource = value => /^data:/i.test(value);
// Backend cache fetches are bounded at 16 MiB of decoded bytes. Archived data
// retains its existing smaller limit in safeMarkdownImageSource.
function safeResolvedImageSource(value) {
  if (typeof value === 'string' && value.startsWith('/api/image-cache/resource?') && value.length <= 20_000) return value;
  if (typeof value !== 'string' || value.length > Math.ceil(16 * 1024 * 1024 / 3) * 4 + 128 || !RASTER_DATA.test(value)) return null;
  const payload = value.slice(value.indexOf(',') + 1);
  const bytes = payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
  return payload.length % 4 === 0 && bytes <= 16 * 1024 * 1024 ? value : null;
}

// Markdown images are explicit image sources, not inferred from link suffixes.
// Keep file URLs, executable schemes, credentials and untrusted SVG data out.
export function safeMarkdownImageSource(value) {
  if (typeof value !== 'string' || !value || value.length > 8 * 1024 * 1024) return null;
  if (RASTER_DATA.test(value)) return value;
  // eslint-disable-next-line no-control-regex -- Refuse controls and backslashes in archived URLs.
  if (value.length > 16384 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  if (/^\/(?!\/)/.test(value)) return value;
  try {
    const url = new URL(value);
    return /^https?:\/\//i.test(value) && ['https:', 'http:'].includes(url.protocol)
      && url.hostname && !url.username && !url.password ? value : null;
  } catch { return null; }
}

export function wrapMarkdownImage(image, t = value => value) {
  const document = image.ownerDocument;
  const source = safeMarkdownImageSource(image.dataset.imageSource || image.getAttribute('src'));
  const alt = image.getAttribute('alt') || '';
  const wrapper = document.createElement('span');
  wrapper.className = 'reader-markdown-image';
  wrapper.dataset.imageState = source ? 'deferred' : 'missing';
  wrapper.dataset.imageAlt = alt;
  const fallback = document.createElement('span');
  fallback.className = 'reader-image-fallback';
  fallback.setAttribute('role', 'img');
  fallback.setAttribute('aria-label', [t('Image unavailable'), alt].filter(Boolean).join(' · '));
  const copy = document.createElement('span');
  copy.className = 'reader-image-failure-copy';
  const unavailable = document.createElement('span');
  unavailable.className = 'reader-image-failure-label';
  unavailable.textContent = t('Image unavailable');
  const detail = document.createElement('span');
  detail.className = 'reader-image-failure-detail';
  detail.textContent = t('The image could not be loaded.');
  copy.append(unavailable, detail); fallback.append(copy);
  fallback.hidden = Boolean(source);
  if (source) {
    // Remote sources stay inert throughout every HTML serialization pass. Only
    // the mounted controller can assign src, after applying the user's policy.
    image.removeAttribute('src');
    image.dataset.imageSource = source;
    image.setAttribute('alt', alt);
    image.setAttribute('referrerpolicy', 'no-referrer');
    image.setAttribute('decoding', 'async');
    image.className = 'reader-markdown-image-content';
    image.hidden = true;
    wrapper.append(image);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reader-image-load';
    button.setAttribute('aria-label', [t('Load image'), alt].filter(Boolean).join(' · '));
    const label = document.createElement('span');
    label.className = 'reader-image-load-label';
    label.textContent = t('Load image');
    button.append(label);
    if (alt) {
      const description = document.createElement('span');
      description.className = 'reader-image-load-description';
      description.textContent = alt;
      button.append(description);
    }
    wrapper.append(button);
    const loading = document.createElement('span');
    loading.className = 'reader-image-loading';
    loading.textContent = t('Loading image…');
    loading.setAttribute('role', 'status');
    loading.hidden = true;
    wrapper.append(loading);
  }
  wrapper.append(fallback);
  return wrapper;
}

// Split linked Markdown images out of their anchors, preserving neighboring
// linked text and its formatting. An image must never be an external-browser
// action, including when its archived Markdown nests it inside a link.
export function unlinkMarkdownImages(container) {
  const split = node => {
    if (node.nodeType === 1 && node.classList.contains('reader-markdown-image')) return [{ node, image: true }];
    if (node.nodeType !== 1 || !node.querySelector('.reader-markdown-image')) return [{ node: node.cloneNode(true), image: false }];
    return [...node.childNodes].flatMap(split).map(part => {
      if (part.image) return part;
      const parent = node.cloneNode(false);
      parent.append(part.node);
      return { node: parent, image: false };
    });
  };
  for (const anchor of [...container.querySelectorAll('a')]) {
    if (!anchor.querySelector('.reader-markdown-image')) continue;
    const fragment = anchor.ownerDocument.createDocumentFragment();
    let textLink = null;
    for (const part of [...anchor.childNodes].flatMap(split)) {
      if (part.image) { fragment.append(part.node); textLink = null; }
      else {
        if (!textLink) { textLink = anchor.cloneNode(false); fragment.append(textLink); }
        textLink.append(part.node);
      }
    }
    anchor.replaceWith(fragment);
  }
}

function svgArt(document, className, viewBox, parts) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add(className);
  for (const [tag, attrs] of parts) {
    const part = document.createElementNS(svg.namespaceURI, tag);
    for (const [name, value] of Object.entries(attrs)) part.setAttribute(name, value);
    svg.append(part);
  }
  return svg;
}

const pathPart = (className, d, extra = {}) => ['path', { class: className, d, ...extra }];
function deferredImageArt(document, compact) {
  if (compact) return [svgArt(document, 'reader-image-load-art', '0 0 64 56', [
    pathPart('reader-image-load-frame', 'M16 4H6v10M48 4h10v10M6 42v10h10M58 42v10H48'),
    pathPart('reader-image-load-landscape', 'M17 18h30v22H17ZM18 35l9-9 7 7 5-5 8 8M39 23h.01'),
    pathPart('reader-image-load-arrow', 'M32 7v13m-5-5 5 5 5-5'),
  ])];
  const terrain = svgArt(document, 'reader-image-load-background', '0 0 160 88', [
    pathPart('reader-image-load-terrain', 'M0 64Q25 31 59 59T115 52T160 66V88H0Z'),
    pathPart('reader-image-load-horizon', 'M0 76Q34 52 70 75T160 69'),
  ]);
  terrain.setAttribute('preserveAspectRatio', 'none');
  return [terrain, svgArt(document, 'reader-image-load-art', '58 11 44 46', [
    pathPart('reader-image-load-frame', 'M61 14h38v40H61Z'),
    pathPart('reader-image-load-arrow', 'M80 23v18m-7-7 7 7 7-7M70 46h20'),
  ])];
}

function failedImageArt(document, compact) {
  if (compact) return svgArt(document, 'reader-image-failure-art', '0 0 80 68', [
    pathPart('reader-image-accent', 'M23 7H10v13M57 7h13v13M10 48v13h13M70 48v13H57'),
    pathPart('', 'm21 47 12-15 10 12 6-7 10 10M27 18h.01'),
    pathPart('reader-image-cut-under', 'm20 55 41-42'),
    pathPart('reader-image-accent reader-image-cut', 'm20 55 41-42'),
  ]);
  const svg = svgArt(document, 'reader-image-failure-art', '204 34 224 50', [
    ['rect', { x: '208', y: '38', width: '51', height: '42', rx: '6' }],
    ['circle', { cx: '223', cy: '50', r: '3' }],
    pathPart('', 'm1 34 14-12 11 10 10-13 14 18', { transform: 'translate(208 38)' }),
    pathPart('reader-image-connection', 'M269 59h29m46 0h29'),
    pathPart('reader-image-accent', 'm8 4-6 6a8 8 0 0 0 11 11l3-3M18 22l6-6A8 8 0 0 0 13 5l-2 2', { transform: 'translate(309 45)' }),
    pathPart('reader-image-cut-under', 'm0 27 25-28', { transform: 'translate(309 45)' }),
    pathPart('reader-image-accent', 'm0 4-4-4m29 25 4 4', { transform: 'translate(309 45)' }),
    ['rect', { class: 'reader-image-endpoint', x: '382', y: '42', width: '42', height: '34', rx: '5' }],
    ['circle', { class: 'reader-image-accent-dot', cx: '403', cy: '59', r: '3' }],
  ]);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return svg;
}

const controllers = new WeakMap();
function controllerFor(wrapper) {
  if (controllers.has(wrapper)) return controllers.get(wrapper);
  const image = wrapper.querySelector('.reader-markdown-image-content');
  const source = safeMarkdownImageSource(image?.dataset.imageSource);
  const button = wrapper.querySelector('.reader-image-load');
  const loading = wrapper.querySelector('.reader-image-loading');
  const loadLabel = button?.querySelector('.reader-image-load-label');
  const defaultLoadLabel = loadLabel?.textContent;
  const fallback = wrapper.querySelector('.reader-image-fallback');
  const paragraph = wrapper.closest('p');
  const proseBeside = paragraph && [...paragraph.childNodes].some(node => node !== wrapper && (node.nodeType === 3 ? node.textContent.trim() : node.textContent.trim() || node.querySelector?.('.reader-markdown-image')));
  const compact = wrapper.dataset.declaredImageDesign === 'compact' || (wrapper.dataset.declaredImageDesign !== 'wide' && Boolean(wrapper.closest('td,th,.rich-row') || proseBeside));
  wrapper.dataset.imageDesign = compact ? 'compact' : 'wide';
  if (!source) {
    const label = fallback.querySelector('.reader-image-failure-label,.rich-offline-label')?.textContent || fallback.getAttribute('aria-label');
    fallback.replaceChildren(createMissingImagePlaceholder(wrapper.ownerDocument, { compact, alt: wrapper.dataset.imageAlt || '', t: () => label }));
    wrapper.dataset.imageState = 'missing';
    const controller = { configure() {}, destroy() { controllers.delete(wrapper); } };
    controllers.set(wrapper, controller);
    return controller;
  }
  if (!button.querySelector('svg')) button.prepend(...deferredImageArt(wrapper.ownerDocument, compact));
  if (!fallback.querySelector('svg')) fallback.prepend(failedImageArt(wrapper.ownerDocument, compact));
  let optionsTranslate = value => value;
  const state = { status: 'deferred', mode: 'click', manual: false, resolver: null, context: {}, epoch: 0, abort: null, activeSource: null, disposed: false };
  const paint = () => {
    wrapper.dataset.imageState = state.status;
    wrapper.classList.toggle('archived-image-loaded', state.status === 'loaded');
    const actionLabel = state.status === 'failed' ? optionsTranslate('Retry image') : defaultLoadLabel;
    if (loadLabel) loadLabel.textContent = actionLabel;
    button.setAttribute('aria-label', [actionLabel, wrapper.dataset.imageAlt].filter(Boolean).join(' · '));
    image.hidden = !state.activeSource || (state.status !== 'loading' && state.status !== 'loaded');
    button.hidden = !['deferred', 'failed'].includes(state.status);
    button.classList.toggle('reader-image-retry', state.status === 'failed');
    loading.hidden = state.status !== 'loading';
    fallback.hidden = state.status !== 'failed';
    wrapper.setAttribute('aria-busy', String(state.status === 'loading'));
  };
  const settle = () => {
    if (state.disposed || state.status !== 'loading' || !state.activeSource || image.getAttribute('src') !== state.activeSource || !image.complete) return;
    state.status = image.naturalWidth > 0 ? 'loaded' : 'failed';
    paint();
  };
  const cancel = () => {
    ++state.epoch; state.abort?.abort(); state.abort = null; state.activeSource = null;
    image.removeAttribute('src');
  };
  const start = async manual => {
    if (state.disposed) return;
    if (state.status === 'loading' || state.status === 'loaded') return;
    state.manual = manual;
    state.status = 'loading';
    const epoch = ++state.epoch;
    const abort = new AbortController(); state.abort = abort;
    image.loading = manual || isDataSource(source) ? 'eager' : 'lazy';
    paint();
    let resolved = source;
    if (!isDataSource(source) && !/^\/(?!\/)/.test(source) && state.resolver) {
      try {
        // A configured resolver owns network policy. Null, rejection or unsafe
        // output must never bypass it through a direct browser request.
        resolved = await state.resolver(source, { ...state.context, signal: abort.signal });
        resolved = safeResolvedImageSource(resolved);
      } catch { resolved = null; }
    }
    if (state.disposed || epoch !== state.epoch || abort.signal.aborted) return;
    if (!resolved) { state.status = 'failed'; paint(); return; }
    state.activeSource = resolved;
    image.setAttribute('src', resolved);
    paint();
    if (image.complete) settle();
  };
  image.addEventListener('load', settle);
  image.addEventListener('error', settle);
  const activate = event => { event.preventDefault(); event.stopPropagation(); void start(true); };
  button.addEventListener('click', activate);
  // Defense in depth for later app-created rich wrappers and auxiliary clicks.
  const stopNavigation = event => { event.preventDefault(); event.stopPropagation(); };
  wrapper.addEventListener('click', stopNavigation);
  wrapper.addEventListener('auxclick', stopNavigation);
  const controller = {
    configure(options) {
      if (state.disposed) return;
      optionsTranslate = options.t || optionsTranslate;
      const mode = options.mode === 'auto' ? 'auto' : 'click';
      const resolver = Object.hasOwn(options, 'resolveImage') ? (typeof options.resolveImage === 'function' ? options.resolveImage : null) : state.resolver;
      const context = Object.hasOwn(options, 'context')
        ? { ...(state.context.messageId === undefined ? {} : { messageId: state.context.messageId }), ...options.context }
        : state.context;
      const changed = resolver !== state.resolver || Object.keys(context).some(key => context[key] !== state.context[key]);
      const restartManual = changed && state.status === 'loading' && state.manual;
      if (changed && state.status === 'loading') { cancel(); state.status = 'deferred'; }
      state.resolver = resolver; state.context = Object.freeze(context);
      if (isDataSource(source) || /^\/(?!\/)/.test(source)) { state.mode = mode; if (mode === 'auto') void start(false); else paint(); return; }
      if (mode === 'click' && state.mode !== 'click' && state.status === 'loading' && !state.manual) {
        // A lazy or still-pending automatic request is no longer authorized by
        // the current view setting. Already decoded images remain displayed.
        if (image.complete && image.naturalWidth > 0) settle();
        else { cancel(); state.status = 'deferred'; paint(); }
      }
      state.mode = mode;
      if (mode === 'auto' && state.status === 'deferred') void start(false);
      else if (restartManual && state.status === 'deferred') void start(true);
      else paint();
    },
    destroy() {
      state.disposed = true; cancel();
      image.removeEventListener('load', settle); image.removeEventListener('error', settle);
      button.removeEventListener('click', activate);
      wrapper.removeEventListener('click', stopNavigation); wrapper.removeEventListener('auxclick', stopNavigation);
      controllers.delete(wrapper);
    },
  };
  controllers.set(wrapper, controller);
  paint();
  return controller;
}

// Called after sanitized HTML becomes DOM and whenever the setting changes.
// No inline handlers are used, so script-src remains unchanged.
export function mountMarkdownImages(container, options = {}) {
  unlinkMarkdownImages(container);
  for (const wrapper of container.querySelectorAll('.reader-markdown-image')) controllerFor(wrapper)?.configure(options);
}

export function destroyMarkdownImages(container) {
  for (const wrapper of container.querySelectorAll('.reader-markdown-image')) controllers.get(wrapper)?.destroy();
}
