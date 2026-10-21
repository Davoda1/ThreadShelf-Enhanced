/** Trusted, transient chart inspection. No exported code or callbacks execute.
 * The serialized geometry is produced by rich-charts after bounded validation.
 * Root delegation survives the Reader's normal render-to-HTML pipeline.
 */
const roots = new WeakMap(), charts = new WeakMap(), activeByDocument = new WeakMap(), handled = new WeakSet();
let tooltipSequence = 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
function chartState(figure) {
  if (charts.has(figure)) return charts.get(figure);
  let items;
  try {
    const data = figure.dataset.chartInteraction;
    if (!data || data.length > 8_000_000) return null;
    items = JSON.parse(data);
    if (!Array.isArray(items) || !items.length || items.length > 1000 || items.some(item => !finite(item.x) || !finite(item.y) || typeof item.heading !== 'string' || !Array.isArray(item.rows) || item.rows.length > 10 || item.rows.some(row => typeof row.label !== 'string' || typeof row.value !== 'string' || !Number.isInteger(row.color) || row.color < 0 || row.color > 7))) return null;
  } catch { return null; }
  const state = {figure, items, svg: figure.querySelector('svg'), viewport: figure.querySelector('.rich-chart-viewport'), suppressed: -1, index: 0};
  state.nodes = items.map((_, i) => figure.querySelector(`.rich-chart-hit[data-chart-item="${i}"]`) || figure.querySelector(`[data-chart-item="${i}"]`));
  if (!state.svg || !state.viewport || state.nodes.some(node => !node)) return null;
  charts.set(figure, state); return state;
}
function screenPoint(state, item) {
  const m = state.svg.getScreenCTM?.();
  return m ? {x: m.a * item.x + m.c * item.y + m.e, y: m.b * item.x + m.d * item.y + m.f} : null;
}
function visiblePoint(state, point) {
  const doc = state.figure.ownerDocument, win = doc.defaultView;
  if (!state.figure.isConnected || !state.figure.getClientRects().length || !point) return false;
  if (point.x < 0 || point.y < 0 || point.x > win.innerWidth || point.y > win.innerHeight) return false;
  for (let node = state.viewport; node && node !== doc.body; node = node.parentElement) {
    const css = win.getComputedStyle(node);
    if (css.display === 'none' || css.visibility === 'hidden') return false;
    const box = node.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(css.overflowX) && (point.x < box.left - 1 || point.x > box.right + 1)) return false;
    if (/(auto|scroll|hidden|clip)/.test(css.overflowY) && (point.y < box.top - 1 || point.y > box.bottom + 1)) return false;
  }
  return true;
}
function visibleAnchor(state, item, index) {
  let point = screenPoint(state, item);
  if (state.figure.dataset.chartType === 'scatter') return visiblePoint(state, point) ? point : null;
  const doc = state.figure.ownerDocument, win = doc.defaultView;
  if (!state.figure.isConnected || !state.figure.getClientRects().length || !point) return null;
  const target = state.nodes[index].getBoundingClientRect();
  const inPlot = state.viewport.contains(state.nodes[index]);
  if (!inPlot) point = {x: (target.left + target.right) / 2, y: (target.top + target.bottom) / 2};
  let left = Math.max(0, target.left), right = Math.min(win.innerWidth, target.right), top = Math.max(0, target.top), bottom = Math.min(win.innerHeight, target.bottom);
  for (let node = inPlot ? state.viewport : state.nodes[index].parentElement; node && node !== doc.body; node = node.parentElement) {
    const css = win.getComputedStyle(node), box = node.getBoundingClientRect();
    if (css.display === 'none' || css.visibility === 'hidden') return null;
    if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
    if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
  }
  if (right <= left || bottom <= top) return null;
  // Shared categories retain their true X/crosshair position even when only a
  // strip of the category target is visible. Bars anchor in the visible part.
  if (item.guide && (point.x < left || point.x > right)) return null;
  return {x: Math.max(left, Math.min(point.x, right)), y: Math.max(top, Math.min(point.y, bottom))};
}
function clearHighlight(state) {
  state.figure.classList.remove('has-chart-active');
  state.figure.querySelectorAll('.is-active').forEach(node => node.classList.remove('is-active'));
  const guide = state.figure.querySelector('.rich-chart-crosshair');
  if (guide) guide.setAttribute('visibility', 'hidden');
  state.figure.querySelectorAll('[aria-describedby]').forEach(node => { if (node.getAttribute('aria-describedby')?.startsWith('threadshelf-chart-tooltip-')) node.removeAttribute('aria-describedby'); });
}
export function dismissChartInteractions(root) {
  const doc = root?.ownerDocument || root;
  const active = activeByDocument.get(doc);
  if (active && (root === doc || root === active.state.figure || root.contains?.(active.state.figure))) active.hide();
}
function show(state, index, origin) {
  if (!state.items[index] || state.suppressed === index) return;
  const doc = state.figure.ownerDocument, win = doc.defaultView, previous = activeByDocument.get(doc);
  if (previous?.state === state && previous.index === index) { previous.origin = origin; return; }
  previous?.hide();
  const item = state.items[index], point = visibleAnchor(state, item, index);
  if (!point) return;
  const panel = doc.createElement('div'); panel.className = 'rich-chart-tooltip'; panel.id = `threadshelf-chart-tooltip-${++tooltipSequence}`; panel.setAttribute('role', 'tooltip');
  const heading = doc.createElement('div'); heading.className = 'rich-chart-tooltip-heading'; heading.textContent = item.heading; panel.append(heading);
  for (const row of item.rows) {
    const line = doc.createElement('div'); line.className = 'rich-chart-tooltip-row';
    const swatch = doc.createElement('span'); swatch.className = `rich-chart-swatch rich-chart-color-${row.color}`; swatch.setAttribute('aria-hidden', 'true');
    const label = doc.createElement('span'); label.className = 'rich-chart-tooltip-label'; label.textContent = row.label;
    const value = doc.createElement('strong'); value.className = 'rich-chart-tooltip-value'; value.textContent = row.value;
    line.append(swatch, label, value); panel.append(line);
  }
  // The portal is outside overflow containers. Carry the active Reader theme,
  // including its independent high-contrast override, across that boundary.
  const css = win.getComputedStyle(state.figure);
  for (const name of ['--text-primary', '--text-secondary', '--bg-primary', '--bg-secondary', '--border-color', '--text-accent', '--accent-color', '--accent', '--danger', '--warning', '--muted', '--text', '--surface', '--border']) {
    const value = css.getPropertyValue(name); if (value) panel.style.setProperty(name, value);
  }
  panel.style.fontFamily = css.fontFamily; panel.style.fontSize = css.fontSize;
  if (state.figure.closest('.reader-high-contrast')) panel.classList.add('rich-chart-tooltip-high-contrast');
  doc.body.append(panel);
  state.figure.classList.add('has-chart-active');
  state.figure.querySelectorAll(`[data-chart-active="${index}"],.rich-chart-legend [data-chart-item="${index}"]`).forEach(node => node.classList.add('is-active'));
  const guide = state.figure.querySelector('.rich-chart-crosshair');
  if (guide && item.guide) { guide.setAttribute('x1', String(item.x)); guide.setAttribute('x2', String(item.x)); guide.setAttribute('visibility', 'visible'); }
  state.nodes[index].setAttribute('aria-describedby', panel.id);
  if (doc.activeElement === state.viewport || (state.figure.contains(doc.activeElement) && doc.activeElement?.dataset.chartItem === String(index))) doc.activeElement.setAttribute('aria-describedby', panel.id);
  state.index = index;
  let frame = 0, closed = false;
  const active = {state, index, origin, hide};
  const listeners = [];
  function listen(target, name, fn, options) { target.addEventListener(name, fn, options); listeners.push(() => target.removeEventListener(name, fn, options)); }
  function hide() {
    if (closed) return; closed = true;
    if (frame) win.cancelAnimationFrame(frame);
    listeners.forEach(remove => remove()); removal?.disconnect(); ancestors?.disconnect(); resize?.disconnect();
    panel.remove(); clearHighlight(state);
    if (activeByDocument.get(doc) === active) activeByDocument.delete(doc);
  }
  function position() {
    frame = 0;
    const anchor = visibleAnchor(state, item, index);
    if (!anchor) { hide(); return; }
    const reader = state.figure.closest('.reader-view')?.getBoundingClientRect();
    const vv = win.visualViewport;
    const bounds = {left: Math.max(8, reader?.left + 8 || 8, (vv?.offsetLeft || 0) + 8), top: Math.max(8, reader?.top + 8 || 8, (vv?.offsetTop || 0) + 8), right: Math.min(win.innerWidth - 8, reader?.right - 8 || Infinity, (vv?.offsetLeft || 0) + (vv?.width || win.innerWidth) - 8), bottom: Math.min(win.innerHeight - 8, reader?.bottom - 8 || Infinity, (vv?.offsetTop || 0) + (vv?.height || win.innerHeight) - 8)};
    // Measure the portal's screen-to-CSS scale: CSS zoom on any ancestor and
    // normal Chromium page/display scaling need not share SVG user units.
    panel.style.left = '0px'; panel.style.top = '0px';
    const origin = panel.getBoundingClientRect();
    panel.style.left = '100px'; panel.style.top = '100px';
    const probe = panel.getBoundingClientRect();
    const sx = (probe.left - origin.left) / 100 || 1, sy = (probe.top - origin.top) / 100 || 1;
    panel.style.maxWidth = `${Math.max(40, bounds.right - bounds.left) / sx}px`;
    panel.style.maxHeight = `${Math.max(40, bounds.bottom - bounds.top) / sy}px`;
    panel.classList.remove('rich-chart-tooltip-compact');
    if (panel.scrollHeight * sy > bounds.bottom - bounds.top) panel.classList.add('rich-chart-tooltip-compact');
    const box = panel.getBoundingClientRect();
    let x = anchor.x + 16, y = anchor.y - 12;
    if (x + box.width > bounds.right) x = anchor.x - box.width - 16;
    x = Math.max(bounds.left, Math.min(x, bounds.right - box.width));
    y = Math.max(bounds.top, Math.min(y, bounds.bottom - box.height));
    panel.style.left = `${(x - origin.left) / sx}px`; panel.style.top = `${(y - origin.top) / sy}px`;
  }
  function schedule() { if (!frame && !closed) frame = win.requestAnimationFrame(position); }
  function escape(event) { if (event.key === 'Escape') { state.suppressed = index; hide(); event.preventDefault(); } }
  const removal = win.MutationObserver ? new win.MutationObserver(schedule) : null;
  removal?.observe(doc.body, {childList: true, subtree: true});
  const ancestors = win.MutationObserver ? new win.MutationObserver(hide) : null;
  for (let node = state.figure.parentElement; node; node = node.parentElement) ancestors?.observe(node, {attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']});
  const resize = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
  resize?.observe(state.figure); resize?.observe(state.viewport);
  listen(doc, 'scroll', schedule, true); listen(win, 'resize', schedule); listen(doc, 'keydown', escape, true);
  listen(doc, 'pointerdown', event => { if (!state.figure.contains(event.target)) hide(); }, true);
  if (win.visualViewport) { listen(win.visualViewport, 'resize', schedule); listen(win.visualViewport, 'scroll', schedule); }
  activeByDocument.set(doc, active); position();
}
function pointerIndex(state, event) {
  if (state.figure.dataset.chartType === 'scatter' && state.svg.contains(event.target)) {
    // CSS-pixel hit radius remains stable under SVG resize/zoom. Equal-distance
    // overlaps choose source series order then source point order; arrows reach all.
    const m = state.svg.getScreenCTM?.(); if (!m) return -1;
    const doc = state.figure.ownerDocument, win = doc.defaultView;
    const bounds = {left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight};
    for (let node = state.viewport; node && node !== doc.body; node = node.parentElement) {
      const css = win.getComputedStyle(node), box = node.getBoundingClientRect();
      if (css.display === 'none' || css.visibility === 'hidden') return -1;
      if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) { bounds.left = Math.max(bounds.left, box.left); bounds.right = Math.min(bounds.right, box.right); }
      if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) { bounds.top = Math.max(bounds.top, box.top); bounds.bottom = Math.min(bounds.bottom, box.bottom); }
    }
    let best = -1, distance = 18 * 18;
    state.items.forEach((item, i) => {
      const x = m.a * item.x + m.c * item.y + m.e, y = m.b * item.x + m.d * item.y + m.f;
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
      const dx = x - event.clientX, dy = y - event.clientY, d = dx * dx + dy * dy;
      if (d < distance - 1e-7 || (best === -1 && d <= distance)) { best = i; distance = d; }
    });
    return best;
  }
  const target = event.target.closest?.('[data-chart-item]');
  return target?.closest('.rich-chart') === state.figure ? Number(target.dataset.chartItem) : -1;
}
/** Returns an idempotent disposer; each mounted root owns only five delegates. */
export function mountChartInteractions(root) {
  if (roots.has(root)) return roots.get(root);
  function eventState(event) {
    const figure = event.target.closest?.('.rich-chart[data-chart-interaction]');
    return figure && (figure === root || root.contains(figure)) ? chartState(figure) : null;
  }
  function pointer(event) {
    if (handled.has(event)) return; const state = eventState(event); if (!state) return; handled.add(event);
    const index = pointerIndex(state, event);
    if (index < 0) { state.suppressed = -1; dismissChartInteractions(state.figure); return; }
    if (index !== state.suppressed) state.suppressed = -1;
    show(state, index, 'pointer');
  }
  function out(event) {
    const state = eventState(event); if (!state || state.figure.contains(event.relatedTarget)) return;
    state.suppressed = -1;
    const active = activeByDocument.get(state.figure.ownerDocument);
    if (active?.state === state && active.origin !== 'focus') active.hide();
  }
  function focus(event) {
    if (handled.has(event)) return; const state = eventState(event); if (!state) return; handled.add(event);
    const node = event.target.closest('[data-chart-item]');
    if (event.target !== state.viewport && !node) { dismissChartInteractions(state.figure); return; }
    const index = node ? Number(node.dataset.chartItem) : state.index;
    if (index !== state.suppressed) state.suppressed = -1;
    show(state, index, 'focus');
  }
  function blur(event) {
    const state = eventState(event); if (!state || state.figure.contains(event.relatedTarget)) return;
    state.suppressed = -1; dismissChartInteractions(state.figure);
  }
  function key(event) {
    if (handled.has(event)) return; const state = eventState(event); if (!state || (!event.target.closest('[data-chart-item]') && event.target !== state.viewport)) return;
    let index = Number(event.target.closest('[data-chart-item]')?.dataset.chartItem ?? state.index);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') index = Math.min(state.items.length - 1, index + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') index = Math.max(0, index - 1);
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = state.items.length - 1;
    else return;
    handled.add(event); event.preventDefault(); state.suppressed = -1;
    state.nodes[index].focus({preventScroll: true});
    state.nodes[index].scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'instant'});
    show(state, index, 'focus');
  }
  const events = [['pointermove', pointer], ['pointerout', out], ['focusin', focus], ['focusout', blur], ['keydown', key]];
  events.forEach(([name, fn]) => root.addEventListener(name, fn));
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; dismissChartInteractions(root); events.forEach(([name, fn]) => root.removeEventListener(name, fn)); roots.delete(root); };
  roots.set(root, dispose); return dispose;
}
