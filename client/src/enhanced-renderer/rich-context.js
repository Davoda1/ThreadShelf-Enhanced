import {createGrokContextResolver, collectGrokCards} from './grok-renderer.js';
// Transient, message-scoped citation bindings. Never changes archived turns/raw.
// Bind only explicit saved identities; never infer references from array order.
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value, key) => {
  if (!plain(value) || ['__proto__', 'prototype', 'constructor'].includes(key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
// Metadata arrays must be dense own data properties. Never invoke imported
// accessors or an overridden iterator, even when a future caller supplies JS.
function dataArray(value, max) {
  if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) return null;
  const values = [];
  for (let index = 0; index < length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !Object.hasOwn(item, 'value')) return null;
    values.push(item.value);
  }
  return values;
}
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const empty = Object.freeze({ references: Object.freeze(Object.create(null)) });
function safeUrl(value) {
  // eslint-disable-next-line no-control-regex -- Reject control characters in archive URLs.
  if (!bounded(value, 4096) || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}
function chatgptReferencesFor(message) {
  const metadata = own(message, 'metadata');
  const records = dataArray(own(metadata, 'content_references'), 1024);
  if (!records) return empty;
  const references = Object.create(null), conflicts = new Set();
  let budget = 4096;
  function put(id, value) {
    if (--budget < 0) throw new RangeError('Citation metadata budget');
    // eslint-disable-next-line no-control-regex -- Reference IDs are inert bounded text.
    if (!bounded(id, 256) || /[\s\u0000-\u001f]/.test(id) || ['__proto__','prototype','constructor'].includes(id) || conflicts.has(id)) return;
    const previous = references[id];
    if (previous && (previous.url !== value.url || previous.filename !== value.filename)) { delete references[id]; conflicts.add(id); return; }
    references[id] = Object.freeze(value);
  }
  function add(item, file = false) {
    const url = safeUrl(own(item, 'url'));
    const filenameValue = own(item, 'filename') ?? own(item, 'file_name');
    const filename = bounded(filenameValue, 2048) ? filenameValue : undefined;
    if (!url && !(file && filename)) return;
    const titleValue = own(item, 'title'), title = bounded(titleValue, 2048) ? titleValue : filename || url;
    const value = {url, title, ...(filename ? {filename} : {})};
    // Direct identities are accepted only when present in saved metadata.
    const direct = own(item, 'ref_id'); if (direct !== undefined) put(direct, value);
    const refs = dataArray(own(item, 'refs'), 256);
    if (!refs) return;
    for (const ref of refs) {
      if (--budget < 0) throw new RangeError('Citation metadata budget');
      if (typeof ref === 'string') { put(ref, value); continue; }
      const turn = own(ref, 'turn_index'), index = own(ref, 'ref_index'), type = own(ref, 'ref_type');
      if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(index) || index < 0 || !['search', 'news', 'image', 'file', 'product', 'view', 'fetch', 'open', 'reddit', 'business'].includes(type)) continue;
      put(`turn${turn}${type}${index}`, value);
    }
  }
  try {
    for (const record of records) {
      const type = own(record, 'type');
      if (type === 'grouped_webpages' || type === 'grouped_files') {
        const items = dataArray(own(record, 'items'), 256);
        if (!items) continue;
        for (const item of items) { if (--budget < 0) return empty; add(item, type === 'grouped_files'); }
      } else if (['webpage', 'webpage_extended', 'file', 'file_citation'].includes(type)) add(record, type === 'file' || type === 'file_citation');
    }
  } catch { return empty; }
  return Object.keys(references).length ? Object.freeze({references: Object.freeze(references)}) : empty;
}
export function referencesFor(message) {
  const context = chatgptReferencesFor(message), grokCards = collectGrokCards(message);
  return Object.keys(grokCards).length ? Object.freeze({...context, grokCards}) : context;
}

function createChatGPTContextResolver(thread) {
  const mapping = own(own(thread, 'raw'), 'mapping');
  if (!plain(mapping)) return () => empty;
  const ids = Object.keys(mapping);
  if (ids.length > 20000) return () => empty;
  const messages = new Map(), duplicates = new Set(), cache = new WeakMap();
  for (const id of ids) {
    const message = own(own(mapping, id), 'message'), messageId = own(message, 'id');
    if (!bounded(messageId, 256)) continue;
    if (messages.has(messageId)) duplicates.add(messageId);
    else messages.set(messageId, message);
  }
  return turn => {
    const messageId = own(turn, 'source_message_id'), nodeId = own(turn, 'source_node_id');
    if (!bounded(messageId, 256)) return empty;
    let message;
    if (bounded(nodeId, 256)) {
      message = own(own(mapping, nodeId), 'message');
      if (own(message, 'id') !== messageId) return empty;
    } else {
      if (duplicates.has(messageId)) return empty;
      message = messages.get(messageId);
    }
    if (!plain(message)) return empty;
    if (!cache.has(message)) cache.set(message, referencesFor(message));
    return cache.get(message);
  };
}

export function createRichContextResolver(thread) {
  const chatgpt=createChatGPTContextResolver(thread),grok=createGrokContextResolver(thread);
  return turn => {
    const context=chatgpt(turn),extra=grok(turn);
    return Object.keys(extra.grokCards || {}).length ? Object.freeze({...context,...extra}) : context;
  };
}
