// Transient, message-scoped citation bindings. Never changes archived turns/raw.
// Only the observed grouped_webpages.items[].refs tuple contract is recognized.
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value, key) => {
  if (!plain(value) || ['__proto__', 'prototype', 'constructor'].includes(key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
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
export function referencesFor(message) {
  const records = own(own(message, 'metadata'), 'content_references');
  if (!Array.isArray(records) || records.length > 1024) return empty;
  const references = Object.create(null), conflicts = new Set();
  let budget = 4096;
  for (const record of records) {
    if (own(record, 'type') !== 'grouped_webpages') continue;
    const items = own(record, 'items');
    if (!Array.isArray(items) || items.length > 256) continue;
    for (const item of items) {
      if (--budget < 0) return empty;
      const url = safeUrl(own(item, 'url')), refs = own(item, 'refs');
      if (!url || !Array.isArray(refs) || refs.length > 256) continue;
      const titleValue = own(item, 'title');
      const title = bounded(titleValue, 2048) ? titleValue : url;
      for (const ref of refs) {
        if (--budget < 0) return empty;
        const turn = own(ref, 'turn_index'), index = own(ref, 'ref_index'), type = own(ref, 'ref_type');
        if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(index) || index < 0 || !['search', 'news', 'image', 'file', 'product', 'view', 'fetch', 'open', 'reddit', 'business'].includes(type)) continue;
        const id = `turn${turn}${type}${index}`;
        if (conflicts.has(id)) continue;
        if (references[id] && references[id].url !== url) { delete references[id]; conflicts.add(id); continue; }
        references[id] = Object.freeze({url, title});
      }
    }
  }
  return Object.keys(references).length ? Object.freeze({references: Object.freeze(references)}) : empty;
}
export function createRichContextResolver(thread) {
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
