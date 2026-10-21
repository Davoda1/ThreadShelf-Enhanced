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
  const area = placeholder || document.createElement('span');
  area.classList.add('archived-image');
  area.dataset.imageLabel = label;
  const safe = safeImageUrl(url);
  if (!safe) {
    if (!placeholder) {
      area.classList.add('rich-image-placeholder', 'rich-image-natural', 'rich-image-soft-horizon');
      area.dataset.placeholderDesign = 'soft-horizon';
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.classList.add('rich-image-placeholder-icon'); icon.setAttribute('viewBox', '0 0 32 32'); icon.setAttribute('aria-hidden', 'true');
      for (const [tag, attrs] of [
        ['rect', { x: '3.5', y: '4.5', width: '25', height: '23', rx: '3' }],
        ['circle', { cx: '11', cy: '12', r: '2' }],
        ['path', { d: 'm4 23 7-7 5 5 5-7 7 8' }],
      ]) {
        const child = document.createElementNS(icon.namespaceURI, tag);
        for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, value);
        icon.append(child);
      }
      const caption = document.createElement('span');
      caption.className = 'rich-offline-label';
      caption.textContent = `Image unavailable${label ? `: ${label}` : ''}`;
      area.append(icon, caption);
    }
    return area;
  }
  area.dataset.imageUrl = safe;
  area.classList.add('archived-image-loadable');
  area.classList.remove('rich-image-natural');
  area.removeAttribute('role');
  area.removeAttribute('aria-label');
  area.replaceChildren();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'archived-image-load';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 32 32'); icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(icon.namespaceURI, 'path');
  path.setAttribute('d', 'M16 4v16m-6-6 6 6 6-6M5 22v6h22v-6');
  icon.append(path);
  const caption = document.createElement('span');
  const remote = /^https?:/i.test(safe);
  caption.textContent = remote ? 'Load external image' : 'Load image';
  button.append(icon, caption);
  if (label) { const description = document.createElement('span'); description.className = 'archived-image-label'; description.textContent = label; button.append(description); }
  button.title = remote ? 'Loads the saved image URL directly from its host. Your browser will contact that host.' : 'Load the saved image';
  area.append(button);
  return area;
}

export function mountImages(container) {
  const controller = new AbortController();
  container.addEventListener('click', event => {
    const button = event.target.closest?.('.archived-image-load');
    if (!button || !container.contains(button)) return;
    const slot = button.closest('.archived-image');
    const url = safeImageUrl(slot?.dataset.imageUrl);
    if (!url) return;
    button.disabled = true;
    const image = document.createElement('img');
    image.alt = slot.dataset.imageLabel || 'Archived image';
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    image.addEventListener('load', () => {
      if (!controller.signal.aborted) { slot.replaceChildren(image); slot.classList.add('archived-image-loaded'); }
    }, { once: true });
    image.addEventListener('error', () => {
      if (controller.signal.aborted) return;
      button.disabled = false;
      button.querySelector('span').textContent = 'Image unavailable — retry';
      slot.dataset.imageState = 'error';
    }, { once: true });
    image.src = url;
  }, { signal: controller.signal });
  return () => controller.abort();
}
