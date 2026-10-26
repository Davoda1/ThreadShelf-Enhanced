// Reader image lifecycle adapted from ThreadShelf Local Reader 4.0.0 R5 (MIT).
import { tr } from './locale.js';
import { wrapMarkdownImage, mountMarkdownImages, destroyMarkdownImages } from './markdown-images.js';

/** Only explicit image URLs are eligible; queries/asset identifiers are never URLs. */
export function safeImageUrl(value) {
  // eslint-disable-next-line no-control-regex -- Reject control characters in archive URLs.
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+=*$/.test(value)) return value.length <= 7_000_000 ? value : null;
  if (value.length > 4096) return null;
  if (/^\/(?!\/)/.test(value)) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}


export function createImageSlot(document, { url, label = '', placeholder } = {}) {
  const image = document.createElement('img');
  const safe = safeImageUrl(url);
  if (safe) image.dataset.imageSource = safe;
  image.setAttribute('alt', label);
  const wrapper = wrapMarkdownImage(image, tr);
  wrapper.classList.add('archived-image');
  if (safe) wrapper.dataset.imageUrl = safe;
  if (placeholder) {
    wrapper.dataset.declaredImageDesign = placeholder.dataset.placeholderDesign === 'corner-aperture' ? 'compact' : 'wide';
    for (const property of ['width', 'maxWidth', 'aspectRatio']) {
      if (placeholder.style[property]) wrapper.style[property] = placeholder.style[property];
    }
  }
  return wrapper;
}

export function imageResourceUrl(source, { collection } = {}) {
  const safe = safeImageUrl(source);
  if (!safe) return null;
  if (!/^https?:/i.test(safe)) return safe;
  const query = new globalThis.URLSearchParams({ url: safe });
  if (collection && !['all', '__all__'].includes(collection)) query.set('collection', collection);
  return `/api/image-cache/resource?${query}`;
}

export function configureImages(container, { mode = 'click', collection } = {}) {
  mountMarkdownImages(container, { mode, resolveImage: imageResourceUrl, context: { collection }, t: tr });
}

export function mountImages(container, options = {}) {
  configureImages(container, options);
  return () => destroyMarkdownImages(container);
}
