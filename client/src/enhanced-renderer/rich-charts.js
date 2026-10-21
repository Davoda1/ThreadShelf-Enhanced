import { mountChartInteractions } from './rich-chart-interactions.js';
/** Safe, render-only chart adapters. See docs/rich-chart-support.md.
 * All input is literal data. No exported DOM, CSS, callbacks, or resources run.
 */
export const CHART_LIMITS = Object.freeze({ rows: 200, series: 8, points: 1000, depth: 12, nodes: 12000, text: 200000, string: 4096, magnitude: 1e15 });
const OWN_SCHEMA = 'threadshelf-chart';
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TYPES = new Set(['bar', 'line', 'area', 'pie', 'doughnut', 'scatter']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const LABELS = Object.freeze({ richChart: 'Chart', richChartData: 'Exact values', richChartCategory: 'Category', richChartSeries: 'Series', richChartValue: 'Value', richChartUnavailable: 'Chart shown as saved data', richChartSource: 'Saved chart data', richChartLimit: 'Chart exceeds display limits', richChartX: 'X', richChartY: 'Y' });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (reason) => { throw new Error(reason); };
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function keys(value, allowed) { if (!plain(value)) fail('schema'); for (const k of Object.keys(value)) if (!allowed.includes(k)) fail('unsupported'); }
function text(value, optional = true) { if (value === undefined && optional) return undefined; if (typeof value !== 'string' || value.length > CHART_LIMITS.string) fail('data'); return value; }
function num(value) { if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > CHART_LIMITS.magnitude) fail('data'); return value; }
function list(value, max, min = 1) { if (!Array.isArray(value) || value.length < min || value.length > max) fail('limit'); return value; }
// Inspect descriptors before reading properties: even a non-literal object passed
// by a future caller cannot trigger a getter while validating or falling back.
function snapshot(input) {
  let nodes = 0, chars = 0;
  const seen = new Set();
  function copy(v, depth) {
    if (++nodes > CHART_LIMITS.nodes || depth > CHART_LIMITS.depth) fail('limit');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('data'); return v; }
    if (typeof v === 'string') { chars += v.length; if (v.length > CHART_LIMITS.string || chars > CHART_LIMITS.text) fail('limit'); return v; }
    if (typeof v !== 'object' || (!Array.isArray(v) && !plain(v)) || seen.has(v)) fail('schema');
    seen.add(v);
    const result = Array.isArray(v) ? [] : Object.create(null);
    const desc = Object.getOwnPropertyDescriptors(v);
    if (Object.getOwnPropertySymbols(desc).length) fail('schema');
    const names = Object.keys(desc);
    if (names.length > CHART_LIMITS.points + 1) fail('limit');
    for (const k of names) {
      if (Array.isArray(v) && k === 'length') continue;
      if (BAD_KEYS.has(k) || k.length > 128 || !own(desc[k], 'value')) fail('schema');
      if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(k)) fail('schema');
      chars += k.length;
      if (chars > CHART_LIMITS.text) fail('limit');
      result[k] = copy(desc[k].value, depth + 1);
    }
    if (Array.isArray(v) && (result.length !== v.length || Object.keys(result).length !== v.length)) fail('data');
    seen.delete(v);
    return result;
  }
  return copy(input, 0);
}
function seriesInfo(s, allowed) {
  keys(s, allowed);
  const out = {};
  for (const k of ['label', 'valueSuffix', 'unit']) if (own(s, k)) out[k] = text(s[k], false);
  if (own(s, 'valueFormat')) { if (!['raw', 'integer'].includes(s.valueFormat)) fail('unsupported'); out.valueFormat = s.valueFormat; }
  if (out.valueSuffix && out.unit) fail('unsupported');
  return out;
}
function axis(a) {
  if (a === undefined) return {};
  keys(a, ['min', 'max', 'label', 'unit']);
  const out = {};
  for (const k of ['min', 'max']) if (own(a, k)) out[k] = num(a[k]);
  for (const k of ['label', 'unit']) if (own(a, k)) out[k] = text(a[k], false);
  if (out.min !== undefined && out.max !== undefined && out.min >= out.max) fail('data');
  return out;
}
function exported(input, family) {
  if (!['Chart', 'chart', 'charts_widget_v2'].includes(family)) fail('unsupported');
  // The native Chart component and both GenUI envelopes preserve the same
  // literal data contract. Do not reject supported charts because a converter
  // retained the component rather than a charts_widget_v2 wrapper.
  if (!['bar', 'line', 'pie', 'scatter'].includes(input.chartType)) fail('unsupported');
  const pie = input.chartType === 'pie', scatter = input.chartType === 'scatter';
  // In this evidenced bar contract vertically arranged categories mean
  // horizontally extending bars; other layout values remain unsupported.
  const allowed = ['chartType', 'meta', 'series', 'data', 'valueSuffix', ...(pie ? ['nameKey', 'valueKey'] : ['xKey', 'yAxisMin', 'yAxisMax'])];
  if (input.chartType === 'bar') allowed.push('layout');
  keys(input, allowed);
  if (own(input, 'layout') && input.layout !== 'vertical') fail('unsupported');
  const out = {schema: OWN_SCHEMA, version: 1, type: input.chartType, series: [], yAxis: {}, xAxis: {}};
  if (!scatter) out.categories = [];
  if (input.meta !== undefined) { keys(input.meta, ['title', 'description', 'footer']); for (const k of ['title', 'description', 'footer']) if (own(input.meta, k)) out[k] = text(input.meta[k], false); }
  const inheritedSuffix = own(input, 'valueSuffix') ? text(input.valueSuffix, false) : undefined;
  const categoryKey = text(pie ? input.nameKey : input.xKey, false);
  if (!categoryKey || BAD_KEYS.has(categoryKey)) fail('data');
  if (scatter) out.xAxis.label = categoryKey;
  else out.categoryLabel = categoryKey;
  const allSeries = list(input.series, pie ? 1 : CHART_LIMITS.series);
  out.series = allSeries.map(s => {
    const normalized = {...seriesInfo(s, ['dataKey', 'label', 'valueFormat', 'valueSuffix', 'unit']), dataKey: text(s.dataKey, false), ...(scatter ? {points: []} : {values: []})};
    // An explicit empty suffix/unit is deliberate and must not be overwritten.
    if (inheritedSuffix !== undefined && !own(normalized, 'valueSuffix') && !own(normalized, 'unit')) normalized.valueSuffix = inheritedSuffix;
    return normalized;
  });
  const seenKeys = new Set();
  for (const s of out.series) { if (!s.dataKey || BAD_KEYS.has(s.dataKey) || s.dataKey === categoryKey || seenKeys.has(s.dataKey)) fail('data'); seenKeys.add(s.dataKey); }
  if (pie && (text(input.valueKey, false) !== out.series[0].dataKey)) fail('unsupported');
  const rows = list(input.data, CHART_LIMITS.rows);
  if (rows.length * out.series.length > CHART_LIMITS.points) fail('limit');
  for (const row of rows) {
    // Unrecognized columns may encode errors/stacking. Preserve them in fallback.
    keys(row, [categoryKey, ...seenKeys]);
    if (scatter) {
      const x = num(row[categoryKey]);
      for (const s of out.series) s.points.push({x, y: num(row[s.dataKey])});
    } else {
      out.categories.push(text(row[categoryKey], false));
      for (const s of out.series) s.values.push(num(row[s.dataKey]));
    }
  }
  if (own(input, 'yAxisMin')) out.yAxis.min = num(input.yAxisMin);
  if (own(input, 'yAxisMax')) out.yAxis.max = num(input.yAxisMax);
  out.orientation = own(input, 'layout') ? 'horizontal' : 'vertical';
  // The same native pie contract uses a ring across its supported wrappers.
  // This is local presentation, not an inferred radius or changed chartType.
  if (pie) out.circularPresentation = 'ring';
  return out;
}
function readerOwned(input) {
  keys(input, ['schema', 'version', 'type', 'orientation', 'title', 'description', 'footer', 'categoryLabel', 'categories', 'series', 'xAxis', 'yAxis']);
  if (input.schema !== OWN_SCHEMA || input.version !== 1 || !TYPES.has(input.type)) fail('unsupported');
  const out = {schema: OWN_SCHEMA, version: 1, type: input.type, xAxis: axis(input.xAxis), yAxis: axis(input.yAxis)};
  for (const k of ['title', 'description', 'footer', 'categoryLabel']) if (own(input, k)) out[k] = text(input[k], false);
  if (input.orientation !== undefined && (input.type !== 'bar' || !['vertical', 'horizontal'].includes(input.orientation))) fail('unsupported');
  out.orientation = input.orientation || 'vertical';
  if (input.type === 'scatter') {
    if (input.categories !== undefined || input.categoryLabel !== undefined) fail('unsupported');
    out.series = list(input.series, CHART_LIMITS.series).map(s => ({...seriesInfo(s, ['label', 'points', 'valueSuffix', 'unit', 'valueFormat']), points: list(s.points, CHART_LIMITS.points).map(p => { keys(p, ['x', 'y', 'label']); return {x: num(p.x), y: num(p.y), ...(own(p, 'label') ? {label: text(p.label, false)} : {})}; })}));
    if (out.series.reduce((n, s) => n + s.points.length, 0) > CHART_LIMITS.points) fail('limit');
  } else {
    out.categories = list(input.categories, CHART_LIMITS.rows).map(v => text(v, false));
    out.series = list(input.series, ['pie', 'doughnut'].includes(input.type) ? 1 : CHART_LIMITS.series).map(s => ({...seriesInfo(s, ['label', 'values', 'valueSuffix', 'unit', 'valueFormat']), values: list(s.values, CHART_LIMITS.rows).map(num)}));
    if (out.series.some(s => s.values.length !== out.categories.length)) fail('data');
    if (out.series.length * out.categories.length > CHART_LIMITS.points) fail('limit');
    if (Object.keys(out.xAxis).some(k => k === 'min' || k === 'max')) fail('unsupported');
    if (['pie', 'doughnut'].includes(out.type) && (Object.keys(out.xAxis).length || Object.keys(out.yAxis).length)) fail('unsupported');
  }
  return out;
}
export function chartDomain(values, requested = {}, zero = false) {
  let min = Math.min(...values), max = Math.max(...values);
  if (zero) { min = Math.min(0, min); max = Math.max(0, max); }
  if (requested.min !== undefined) { if (requested.min > min) fail('bounds'); min = requested.min; }
  if (requested.max !== undefined) { if (requested.max < max) fail('bounds'); max = requested.max; }
  if (min === max) { if (requested.min !== undefined && requested.max !== undefined) fail('bounds'); if (requested.max === undefined) max = min + (Math.abs(min) || 1); else min = max - (Math.abs(max) || 1); }
  if (!(max > min) || !Number.isFinite(max - min)) fail('bounds');
  return {min, max};
}
function validateDomains(c) {
  const suffixes = c.series.map(s => exactChartValue(0, s, c.yAxis).slice(1));
  // A common axis must not borrow one series' suffix when units differ.
  // Keep the original axis and series metadata intact for exact-value lookup.
  c.numericAxisSuffix = suffixes.every(s => s === suffixes[0]) ? suffixes[0] : '';
  if (['pie', 'doughnut'].includes(c.type)) {
    if (c.series[0].values.some(v => v < 0) || !c.series[0].values.some(v => v > 0)) fail('data');
    return;
  }
  const values = c.series.flatMap(s => c.type === 'scatter' ? s.points.map(p => p.y) : s.values);
  c.yDomain = chartDomain(values, c.yAxis, ['bar', 'area'].includes(c.type));
  if (c.type === 'scatter') c.xDomain = chartDomain(c.series.flatMap(s => s.points.map(p => p.x)), c.xAxis);
}
/** Never mutates input. Unknown schemas return a passive data snapshot. */
export function normalizeChart(input, {family = 'Chart'} = {}) {
  let saved;
  try {
    saved = snapshot(input);
    const chart = saved.schema === OWN_SCHEMA ? readerOwned(saved) : exported(saved, family);
    validateDomains(chart);
    return {ok: true, chart};
  } catch (error) {
    return {ok: false, reason: error.message, payload: saved, title: typeof saved?.meta?.title === 'string' ? saved.meta.title : typeof saved?.title === 'string' ? saved.title : undefined};
  }
}
export function exactChartValue(value, series = {}, axis = {}) {
  const numeric = Object.is(value, -0) ? '-0' : String(value);
  // Only an explicitly supplied axis unit may fill an absent series unit.
  // Preserve an explicit empty suffix/unit as well as the original series.
  const unit = own(series, 'unit') ? series.unit : axis.unit;
  const suffix = own(series, 'valueSuffix') ? series.valueSuffix : (unit ? ' ' + unit : '');
  return numeric + suffix;
}
function tr(t, key) { const value = typeof t === 'function' ? t(LABELS[key] || key) : undefined; return typeof value === 'string' && value ? value : (LABELS[key] || key); }
function el(doc, tag, cls, value) { const n = doc.createElement(tag); if (cls) n.className = cls; if (value !== undefined) n.textContent = value; return n; }
function svgEl(doc, tag, attrs, value) { const n = doc.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v)); if (value !== undefined) n.textContent = value; return n; }
function short(value, max = 28) { const a = Array.from(value); return a.length > max ? a.slice(0, max - 1).join('') + '…' : value; }
const coord = n => Math.round(n * 1000) / 1000;
function label(doc, svg, x, y, value, anchor = 'middle', cls = '') {
  const node = svgEl(doc, 'text', {x: coord(x), y: coord(y), 'text-anchor': anchor, class: 'rich-chart-label ' + cls, 'aria-label': value}, short(value));
  svg.append(node); return node;
}
function pointShape(doc, svg, tag, attrs, description, seriesIndex) {
  const node = svgEl(doc, tag, {...attrs, class: `rich-chart-mark rich-chart-color-${seriesIndex % 8}`, role: 'img', tabindex: '-1', 'aria-label': description});
  svg.append(node); return node;
}
function ticks(domain) { return Array.from({length: 5}, (_, i) => domain.min + (domain.max - domain.min) * (i / 4)); }
function tickText(n, a) { const display = Object.is(n, -0) ? '0' : String(Number(n.toPrecision(6))); return display + (own(a, 'valueSuffix') ? a.valueSuffix : a.unit ? ' ' + a.unit : ''); }
function seriesName(s, index, t) { return s.label ?? s.dataKey ?? `${tr(t, 'richChartSeries')} ${index + 1}`; }
function table(doc, c, t) {
  const details = el(doc, 'details', 'rich-chart-data');
  details.append(el(doc, 'summary', '', tr(t, 'richChartData')));
  const holder = el(doc, 'div', 'rich-chart-table-scroll'); holder.tabIndex = 0;
  holder.setAttribute('role', 'region'); holder.setAttribute('aria-label', tr(t, 'richChartData'));
  const tableNode = el(doc, 'table');
  tableNode.append(el(doc, 'caption', '', c.title || tr(t, 'richChartData')));
  const thead = el(doc, 'thead'), head = el(doc, 'tr');
  const headers = c.type === 'scatter' ? [tr(t, 'richChartSeries'), c.xAxis.label || tr(t, 'richChartX'), c.yAxis.label || tr(t, 'richChartY'), tr(t, 'richChartCategory')] : [c.categoryLabel || c.xAxis.label || tr(t, 'richChartCategory'), ...c.series.map((s, i) => seriesName(s, i, t))];
  for (const value of headers) { const th = el(doc, 'th', '', value); th.scope = 'col'; head.append(th); }
  thead.append(head); tableNode.append(thead); const body = el(doc, 'tbody');
  const rows = c.type === 'scatter' ? c.series.flatMap((s, i) => s.points.map(p => [seriesName(s, i, t), exactChartValue(p.x, {unit: c.xAxis.unit}), exactChartValue(p.y, s, c.yAxis), p.label || ''])) : c.categories.map((name, i) => [name, ...c.series.map(s => exactChartValue(s.values[i], s, c.yAxis))]);
  for (const row of rows) { const r = el(doc, 'tr'); row.forEach((v, i) => { const cell = el(doc, i === 0 ? 'th' : 'td', '', v); if (i === 0) cell.scope = 'row'; r.append(cell); }); body.append(r); }
  tableNode.append(body); holder.append(tableNode); details.append(holder); return details;
}
function chartSvg(doc, c, t, width, height) {
  const svg = svgEl(doc, 'svg', {viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': c.title || tr(t, 'richChart')});
  svg.append(svgEl(doc, 'desc', {}, tr(t, 'Use arrow keys to inspect values; Escape dismisses. Exact values are available below.')));
  return svg;
}
function row(c, s, si, value, t) { return {label: seriesName(s, si, t), value: exactChartValue(value, s, c.yAxis), color: si % 8}; }
function registerItem(items, node, marks, item) {
  const i = items.length;
  node?.setAttribute('data-chart-item', String(i));
  node?.setAttribute('tabindex', '-1');
  node?.setAttribute('role', 'img');
  node?.setAttribute('aria-label', [item.heading, ...item.rows.map(r => `${r.label}: ${r.value}`)].join(' — '));
  for (const mark of marks) { mark.setAttribute('data-chart-active', String(i)); mark.setAttribute('data-chart-item', String(i)); }
  items.push(item);
  return i;
}
function cartesian(doc, c, t) {
  const horizontal = c.type === 'bar' && c.orientation === 'horizontal';
  const count = c.categories?.length || 0;
  const width = horizontal ? 680 : Math.max(640, Math.min(12000, count * Math.max(112, c.series.length * 38)));
  const height = horizontal ? Math.max(320, 92 + count * Math.max(40, c.series.length * 23)) : 370;
  const valueWidth = horizontal ? Math.min(220, Math.max(90, ...c.series.flatMap(s => s.values.map(v => exactChartValue(v, s, c.yAxis).length * 7 + 22)))) : 42;
  const left = horizontal ? 220 : 88, right = valueWidth, top = 32, bottom = horizontal ? 56 : 90;
  const pw = width - left - right, ph = height - top - bottom;
  const svg = chartSvg(doc, c, t, width, height), items = [];
  const d = c.yDomain, scale = v => (v - d.min) / (d.max - d.min);
  const y = v => top + ph * (1 - scale(v)), xValue = v => left + pw * scale(v);
  for (const value of ticks(d)) {
    const pos = horizontal ? xValue(value) : y(value);
    svg.append(svgEl(doc, 'line', horizontal ? {x1: coord(pos), x2: coord(pos), y1: top, y2: top + ph, class: 'rich-chart-grid'} : {x1: left, x2: left + pw, y1: coord(pos), y2: coord(pos), class: 'rich-chart-grid'}));
    label(doc, svg, horizontal ? pos : left - 10, horizontal ? top + ph + 22 : pos + 4, tickText(value, {valueSuffix: c.numericAxisSuffix ?? exactChartValue(0, {}, c.yAxis).slice(1)}), horizontal ? 'middle' : 'end');
  }
  if (d.min <= 0 && d.max >= 0) svg.append(svgEl(doc, 'line', horizontal ? {x1: coord(xValue(0)), x2: coord(xValue(0)), y1: top, y2: top + ph, class: 'rich-chart-baseline'} : {x1: left, x2: left + pw, y1: coord(y(0)), y2: coord(y(0)), class: 'rich-chart-baseline'}));
  const slot = (horizontal ? ph : pw) / Math.max(1, count);
  const guide = svgEl(doc, 'line', {class: 'rich-chart-crosshair', y1: top, y2: top + ph, 'aria-hidden': 'true', visibility: 'hidden'});
  svg.append(guide);
  if (c.type === 'scatter') {
    const xd = c.xDomain, xp = v => left + pw * ((v - xd.min) / (xd.max - xd.min));
    for (const v of ticks(xd)) label(doc, svg, xp(v), top + ph + 22, tickText(v, c.xAxis));
    c.series.forEach((s, si) => s.points.forEach((p, pi) => {
      const x = coord(xp(p.x)), py = coord(y(p.y));
      const heading = p.label || seriesName(s, si, t);
      const rows = [{label: c.xAxis.label || tr(t, 'richChartX'), value: exactChartValue(p.x, {unit: c.xAxis.unit}), color: si % 8}, {label: `${seriesName(s, si, t)} · ${c.yAxis.label || tr(t, 'richChartY')}`, value: exactChartValue(p.y, s, c.yAxis), color: si % 8}];
      const mark = pointShape(doc, svg, 'circle', {cx: x, cy: py, r: 5, 'data-series-index': si, 'data-point-index': pi}, `${heading} — ${rows.map(r => `${r.label}: ${r.value}`).join('; ')}`, si);
      registerItem(items, mark, [mark], {heading, rows, x, y: py, guide: true});
    }));
  } else {
    c.categories.forEach((category, i) => label(doc, svg, horizontal ? left - 12 : left + slot * (i + 0.5), horizontal ? top + slot * (i + 0.5) + 4 : top + ph + 24, category, horizontal ? 'end' : 'middle'));
    const categoryMarks = c.categories.map(() => []), hits = [];
    c.series.forEach((s, si) => {
      const points = s.values.map((value, i) => [left + slot * (i + 0.5), y(value)]);
      if (c.type === 'line' || c.type === 'area') {
        if (c.type === 'area') svg.append(svgEl(doc, 'path', {d: `M ${coord(points[0][0])} ${coord(y(0))} L ${points.map(p => p.map(coord).join(' ')).join(' L ')} L ${coord(points.at(-1)[0])} ${coord(y(0))} Z`, class: `rich-chart-area rich-chart-color-${si}`}));
        svg.append(svgEl(doc, 'polyline', {points: points.map(p => p.map(coord).join(',')).join(' '), class: `rich-chart-line rich-chart-color-${si}`}));
      }
      s.values.forEach((value, i) => {
        const description = `${c.categories[i]} — ${seriesName(s, si, t)}: ${exactChartValue(value, s, c.yAxis)}`;
        if (c.type === 'bar') {
          const band = slot * .72 / c.series.length, start = (horizontal ? top : left) + slot * (i + .14) + si * band;
          const a = horizontal ? xValue(0) : y(0), b = horizontal ? xValue(value) : y(value);
          const attrs = horizontal ? {x: coord(Math.min(a, b)), y: coord(start), width: coord(Math.abs(b - a)), height: coord(band * .9)} : {x: coord(start), y: coord(Math.min(a, b)), width: coord(band * .9), height: coord(Math.abs(b - a))};
          const mark = pointShape(doc, svg, 'rect', {...attrs, 'data-category-index': i, 'data-series-index': si}, description, si);
          // The transparent hit target alone grows at zero; the source-value bar keeps its true zero geometry.
          const hit = svgEl(doc, 'rect', {...attrs, x: attrs.x - (horizontal ? Math.max(0, (12 - attrs.width) / 2) : 0), y: attrs.y - (horizontal ? 0 : Math.max(0, (12 - attrs.height) / 2)), width: horizontal ? Math.max(12, attrs.width) : attrs.width, height: horizontal ? attrs.height : Math.max(12, attrs.height), class: 'rich-chart-hit'});
          registerItem(items, hit, [mark], {heading: c.categories[i], rows: [row(c, s, si, value, t)], x: coord(horizontal ? (a + b) / 2 : start + band * .45), y: coord(horizontal ? start + band * .45 : (a + b) / 2)});
          mark.setAttribute('data-chart-item', hit.getAttribute('data-chart-item')); hits.push(hit);
          if (count * c.series.length <= 24) label(doc, svg, horizontal ? left + pw + 12 : start + band * .45, horizontal ? start + band * .65 : b + (value < 0 ? 18 : -7), exactChartValue(value, s, c.yAxis), horizontal ? 'start' : 'middle', 'rich-chart-value');
        } else categoryMarks[i].push(pointShape(doc, svg, 'circle', {cx: coord(points[i][0]), cy: coord(points[i][1]), r: 4, 'data-category-index': i, 'data-series-index': si}, description, si));
      });
    });
    if (c.type === 'line' || c.type === 'area') c.categories.forEach((category, i) => {
      const hit = svgEl(doc, 'rect', {x: coord(left + slot * i), y: top - 6, width: coord(slot), height: ph + 12, class: 'rich-chart-hit'});
      registerItem(items, hit, categoryMarks[i], {heading: category, rows: c.series.map((s, si) => row(c, s, si, s.values[i], t)), x: coord(left + slot * (i + .5)), y: coord(top + ph / 2), guide: true}); hits.push(hit);
    });
    svg.append(...hits);
  }
  if (c.yAxis.label) label(doc, svg, horizontal ? left + pw / 2 : left, horizontal ? height - 6 : 17, c.yAxis.label, horizontal ? 'middle' : 'start');
  if (c.xAxis.label || c.categoryLabel) label(doc, svg, horizontal ? left - 12 : left + pw / 2, horizontal ? 17 : height - 14, c.xAxis.label || c.categoryLabel, horizontal ? 'end' : 'middle');
  return {svg, items};
}
function circular(doc, c, t) {
  const svg = chartSvg(doc, c, t, 640, 300), items = [];
  const s = c.series[0], total = s.values.reduce((a, b) => a + b, 0), cx = 320, cy = 150, r = 120, inner = c.type === 'doughnut' || c.circularPresentation === 'ring' ? 68 : 0;
  let angle = -Math.PI / 2;
  s.values.forEach((value, i) => {
    const part = total > 0 ? value / total : 0, end = angle + Math.PI * 2 * part, middle = angle + Math.PI * part;
    const point = (a, radius) => [coord(cx + Math.cos(a) * radius), coord(cy + Math.sin(a) * radius)].join(' ');
    const rows = [{...row(c, s, 0, value, t), color: i % 8}];
    if (total > 0) rows.push({label: tr(t, 'Share of total (calculated)'), value: `${Number((part * 100).toPrecision(6))}%`, color: i % 8});
    let mark;
    if (value > 0) {
      let path = `M ${point(angle, r)} A ${r} ${r} 0 0 1 ${point(middle, r)} A ${r} ${r} 0 0 1 ${point(end, r)}`;
      path += inner ? ` L ${point(end, inner)} A ${inner} ${inner} 0 0 0 ${point(middle, inner)} A ${inner} ${inner} 0 0 0 ${point(angle, inner)} Z` : ` L ${cx} ${cy} Z`;
      mark = pointShape(doc, svg, 'path', {d: path, 'data-category-index': i}, `${c.categories[i]} — ${rows.map(r => `${r.label}: ${r.value}`).join('; ')}`, i);
    }
    registerItem(items, mark, mark ? [mark] : [], {heading: c.categories[i], rows, x: coord(cx + Math.cos(middle) * (inner + r) / 2), y: coord(cy + Math.sin(middle) * (inner + r) / 2)});
    angle = end;
  });
  return {svg, items};
}
function legend(doc, c, t) {
  const out = el(doc, 'ul', 'rich-chart-legend');
  const circular = ['pie', 'doughnut'].includes(c.type);
  const entries = circular ? c.categories.map((name, i) => `${name}: ${exactChartValue(c.series[0].values[i], c.series[0])}`) : c.series.map((s, i) => seriesName(s, i, t));
  entries.forEach((value, i) => { const item = el(doc, 'li'); const swatch = el(doc, 'span', `rich-chart-swatch rich-chart-color-${i % 8}`); swatch.setAttribute('aria-hidden', 'true'); item.append(swatch, doc.createTextNode(value)); if (circular) { item.dataset.chartItem = String(i); item.tabIndex = -1; item.setAttribute('aria-label', value); } out.append(item); });
  return out;
}
export function renderChart(input, {document: doc = globalThis.document, t, family = 'Chart'} = {}) {
  if (!doc?.createElementNS) throw new TypeError('A DOM document is required');
  const result = normalizeChart(input, {family});
  const figure = el(doc, 'figure', 'rich-chart');
  if (!result.ok) {
    figure.classList.add('rich-chart-fallback');
    figure.append(el(doc, 'figcaption', '', result.title || tr(t, 'richChartUnavailable')));
    if (result.title) figure.append(el(doc, 'p', 'rich-chart-description', tr(t, 'richChartUnavailable')));
    const details = el(doc, 'details'); details.append(el(doc, 'summary', '', tr(t, 'richChartSource')));
    details.append(el(doc, 'pre', 'rich-chart-source', result.payload === undefined ? tr(t, result.reason === 'limit' ? 'richChartLimit' : 'richChartUnavailable') : JSON.stringify(result.payload, null, 2)));
    figure.append(details); return figure;
  }
  const c = result.chart;
  figure.dataset.chartType = c.type;
  if (c.circularPresentation) figure.dataset.chartPresentation = c.circularPresentation;
  if (c.title) figure.append(el(doc, 'figcaption', '', c.title));
  if (c.description) figure.append(el(doc, 'p', 'rich-chart-description', c.description));
  const viewport = el(doc, 'div', 'rich-chart-viewport'); viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', c.title || tr(t, 'richChart'));
  viewport.setAttribute('aria-description', tr(t, 'Use arrow keys to inspect values; Escape dismisses. Exact values are available below.'));
  const drawing = ['pie', 'doughnut'].includes(c.type) ? circular(doc, c, t) : cartesian(doc, c, t);
  // Trusted transient geometry and display strings survive the normal HTML serialization route.
  // They never replace the saved message or create archive/analytics records.
  figure.dataset.chartInteraction = JSON.stringify(drawing.items);
  viewport.append(drawing.svg);
  figure.append(viewport, legend(doc, c, t), table(doc, c, t));
  if (c.footer) figure.append(el(doc, 'p', 'rich-chart-footer', c.footer));
  mountChartInteractions(figure);
  return figure;
}
