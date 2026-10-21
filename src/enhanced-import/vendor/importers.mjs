/** Adapted from ThreadShelf Local Reader by davoda1. See adjacent licenses and README.
 * Native archive imports read input as inert data; never extract or execute it. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ZipReader, Reader } from '@zip.js/zip.js';
import { detectProvider, getOpenAIConversationPath, stripControlTokens } from './providers/threadshelf-parser.mjs';
import { decodeJSONBytes, convert as convertMeta } from './providers/meta.mjs';
import { prepareExport as prepareGemini, parseDocument, renderChildren, plain } from './providers/gemini.mjs';
import { loadBackup } from './providers/venice.mjs';
import { stringifyJSON } from './providers/common.mjs';
import { jsonEvents } from './stream-json.mjs';

export const IMPORT_LIMITS = Object.freeze({ fileBytes: 512 * 1024 ** 2, htmlBytes: 512 * 1024 ** 2, zipBytes: 1024 ** 4, expandedBytes: 256 * 1024 ** 3, streamBytes: 256 * 1024 ** 3, recordBytes: 512 * 1024 ** 2, streamingThreshold: 8 * 1024 ** 2, metadataBytes: 16 * 1024 ** 2, directoryBytes: 64 * 1024 ** 2, records: 2_000_000, entries: 100000, depth: 64, jsonDepth: 256, nodes: 4_000_000 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
// Avoid stringifying/cloning hundred-megabyte exports that already contain JSON-safe values.
function jsonSafe(value) {
  const queue = [value]; let hasBigInt = false;
  while (queue.length) { const item = queue.pop(); if (typeof item === 'bigint') { hasBigInt = true; break; } if (item && typeof item === 'object') for (const child of Object.values(item)) queue.push(child); }
  return hasBigInt ? JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)) : value;
}
const nonempty = value => typeof value === 'string' && value.trim();
const tick = () => new Promise(resolve => setImmediate(resolve));
function abort(signal) { if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError'); }
function emit(options, data) { options.onProgress?.({ operation: 'import', ...data }); }
const roleName = value => /^(user|human)$/i.test(String(value)) ? 'user' : /^(thinking|reasoning|analysis)$/i.test(String(value)) ? 'thinking' : 'ai';

function safeTree(root, limits) {
  const queue = [[root, 0]]; let count = 0;
  while (queue.length) {
    const [value, depth] = queue.pop();
    if (!value || typeof value !== 'object') continue;
    if (++count > limits.nodes || depth > limits.jsonDepth) throw new Error('JSON exceeds the supported complexity limit.');
    for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push([child, depth + 1]);
  }
}

/** Known text structures retain exact whitespace. Unknown structures stay visible as inert JSON. */
function contentText(value, depth = 0) {
  if (depth > 80 || value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => contentText(v, depth + 1)).filter(nonempty).join('\n\n');
  if (!object(value)) return String(value);
  if (typeof value.text === 'string') return value.text;
  if (typeof value.thinking === 'string') return value.thinking;
  if (typeof value.thinking_trace === 'string') return value.thinking_trace;
  if (typeof value.transcript === 'string') return value.transcript;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.parts)) return contentText(value.parts, depth + 1);
  if (Array.isArray(value.content)) return contentText(value.content, depth + 1);
  if (/image|audio|video/i.test(value.content_type || value.type || '')) {
    const kind = /image/i.test(value.content_type || value.type) ? 'Image' : /audio/i.test(value.content_type || value.type) ? 'Audio' : 'Video';
    return `[${kind} attachment${value.asset_pointer ? ': ' + value.asset_pointer : ''}]`;
  }
  return JSON.stringify(value, null, 2);
}
function date(...values) {
  for (let value of values) {
    if (object(value) && '$date' in value) value = object(value.$date) ? value.$date.$numberLong : value.$date;
    if (value == null || value === '') continue;
    let ms;
    if (typeof value === 'number' || typeof value === 'bigint' || /^\d+(?:\.\d+)?$/.test(String(value))) {
      const n = Number(value); ms = n < 10_000_000_000 ? n * 1000 : n;
    } else ms = Date.parse(value);
    if (Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000) return new Date(ms).toISOString();
  }
}
function timestamp(message, conversation = {}) { return date(message?.createdAtUnixTimestamp, message?.timestamp_ms, message?.create_time, message?.created_at, message?.createdAt, message?.timestamp, message?.time, conversation.created_at, conversation.createdAt, conversation.create_time); }
function titleFor(record, turns, fallback) {
  const value = record.title ?? record.name ?? record.metadata?.title ?? record.label;
  return nonempty(value) ? value.trim() : (turns.find(t => nonempty(t.user))?.user || fallback || 'Untitled conversation').replace(/\s+/g, ' ').slice(0, 160);
}
function sourceKey(provider, record, explicit) {
  const id = explicit ?? record.id ?? record.uuid ?? record.conversation_id ?? record.conversationId;
  const key = id != null && String(id) !== '' ? String(id) : hash(record);
  return key.startsWith(`${provider}:`) ? key : `${provider}:${key}`;
}
function add(turns, kind, value, sourceIndex, message = {}, conversation = {}, extra = {}) {
  const text = contentText(value);
  if (!nonempty(text)) return;
  const model = message.modelName ?? message.model ?? message.model_slug ?? message.modelId ?? message.metadata?.model_slug ?? conversation.default_model_slug ?? conversation.model ?? conversation.runSettings?.model ?? conversation.lastUsedModel?.identifier;
  turns.push({ [kind]: text, turn_index: Number.isSafeInteger(message.turn_index) && message.turn_index >= 0 ? message.turn_index : sourceIndex,
    source_message_id: message.id ?? message.uuid ?? message._id,
    ...(message.author?.role ?? message.role ?? message.sender ? { source_role: String(message.author?.role ?? message.role ?? message.sender) } : {}),
    createdAt: timestamp(message, conversation), ...(typeof model === 'string' && model.trim() ? { model } : {}),
    raw: message, ...(object(message.metadata) ? { metadata: message.metadata } : {}), ...extra });
}
function build(provider, record, turns, sourceFile, explicit, extra = {}) {
  const conversationKey = Array.isArray(record.turns) && (record.conversationKey != null || record.key != null)
    ? String(record.conversationKey ?? record.key) : sourceKey(provider, record, explicit);
  return { provider, sourceFile, conversationKey, collection: provider, title: titleFor(record, turns, path.basename(sourceFile)), turns,
    sourceIdentity: { kind: 'native', provider, conversationKey }, raw: record,
    lastTurnAt: turns.map(t => t.createdAt).filter(Boolean).sort().at(-1), ...extra };
}
function genericMessages(messages, conversation, { content = m => m.content ?? m.text ?? m.message, role = m => m.role ?? m.sender } = {}) {
  const turns = [];
  for (const [index, message] of list(messages).entries()) {
    if (!object(message)) continue;
    const sourceRole = String(role(message) ?? 'assistant'), kind = roleName(sourceRole);
    const thinking = message.reasoningContent ?? message.thinkingContent ?? message.reasoning_content ?? message.thinking ?? message.reasoning;
    if (thinking && kind !== 'user') add(turns, 'thinking', thinking, index, message, conversation);
    add(turns, kind, content(message), index, message, conversation, { source_role: sourceRole, ...(message.parentMessageId ? { parent_message_id: message.parentMessageId } : {}) });
  }
  return turns;
}

/** Normalizes JSON documents synchronously. Used inside the import worker, never in the UI. */
export function normalizeDocument(input, sourceFile = 'export.json', { limits = IMPORT_LIMITS, sourceIndex } = {}) {
  safeTree(input, limits);
  const data = jsonSafe(input), result = [];
  if (Array.isArray(data) && data.length && data.every(t => object(t) && ['user', 'ai', 'thinking'].some(k => typeof t[k] === 'string'))) {
    return normalizeDocument({ provider: 'threadshelf', turns: data }, sourceFile, { limits });
  }
  // Original console export: owners contain every stored conversation/message variant.
  if (data?.format === 'venice-chat-history' || Array.isArray(data?.owners)) {
    if (data.formatVersion != null && Number(data.formatVersion) !== 1) throw new Error('Unsupported Venice console export version.');
    for (const owner of list(data.owners)) for (const conversation of list(owner?.conversations)) {
      if (!Array.isArray(conversation?.messages)) continue;
      result.push(build('venice', conversation, genericMessages(conversation.messages, conversation), sourceFile,
        conversation.id == null ? undefined : `${owner.ownerId ?? ''}:${conversation.id}`, { raw: { ...conversation, _sourceOwner: owner.ownerId, _sourceFormat: data.format, _sourceExportedAt: data.exportedAt } }));
    }
    return result;
  }
  if (Array.isArray(data?.label_values)) {
    const converted = convertMeta(Buffer.from(stringifyJSON(input)), path.basename(sourceFile), false, data.localTitleGenerator?.metaTitles || {});
    for (const conv of converted.conversations) {
      const turns = genericMessages(conv.chat_messages, conv, { role: m => m.sender, content: m => m.text });
      result.push(build('meta', conv, turns, sourceFile, conv.uuid, { raw: { ...conv, source_account_id: data.fbid } }));
    }
    return result;
  }
  if (data?.venice_conversion?.format === 'venice-to-threadshelf-grok') {
    for (const entry of list(data.conversations)) {
      const meta = entry.conversation || {}, original = meta.venice_metadata || {}, unmapped = list(data.venice_unmapped_messages).filter(m => String(m.venice_conversation_id) === String(original.id ?? meta.id));
      const indices = new Set(unmapped.map(m => m.message_index));
      let next = 0;
      const messages = list(entry.responses).map(wrapper => {
        while (indices.has(next)) next++;
        const response = wrapper.response || wrapper;
        return { ...response.venice_metadata, role: response.venice_metadata?.role || (response.sender === 'human' ? 'user' : 'assistant'), content: response.venice_original_content ?? response.message,
          reasoningContent: response.venice_metadata?.reasoningContent ?? response.agent_thinking_traces, turn_index: next++ };
      });
      for (const item of unmapped) messages.push({ ...item.message, turn_index: item.message_index });
      messages.sort((a, b) => a.turn_index - b.turn_index);
      const conv = { ...original, id: original.id ?? meta.id, title: meta.title, messages };
      result.push(build('venice', conv, genericMessages(messages, conv), sourceFile, `${meta.venice_owner_id ?? ''}:${conv.id}`, { raw: { ...entry, venice_unmapped_messages: unmapped } }));
    }
    return result;
  }
  // Fully normalized ThreadShelf/Local Reader JSON and plain converted turns.
  if (Array.isArray(data?.turns) && data.turns.some(t => object(t) && ['user', 'ai', 'thinking'].some(k => typeof t[k] === 'string'))) {
    const turns = [];
    for (const [index, item] of data.turns.entries()) for (const kind of ['user', 'thinking', 'ai']) if (typeof item?.[kind] === 'string') {
      const extra = Object.fromEntries(Object.entries(item).filter(([key]) => !['user', 'ai', 'thinking'].includes(key)));
      add(turns, kind, item[kind], index, item, data, extra);
    }
    const provider = data.provider || 'threadshelf';
    result.push(build(provider, data, turns, sourceFile, data.conversationKey ?? data.key)); return result;
  }
  // Index converter wrappers retain native ChatGPT mapping or rendered message records.
  if (Array.isArray(data?.conversations) && !data.conversations.some(c => c?.responses || c?.chat_messages)) {
    for (const [index, conversation] of data.conversations.entries()) result.push(...normalizeDocument(conversation, sourceFile, { limits, sourceIndex: sourceIndex ?? index }));
    return result;
  }
  const provider = detectProvider(data);
  if (provider === 'openai') {
    for (const [index, conversation] of (Array.isArray(data) ? data : [data]).entries()) {
      const turns = [];
      const nodeIds = new Map(Object.entries(conversation.mapping || {}).map(([id, node]) => [node, id]));
      let nodes = getOpenAIConversationPath(conversation);
      if (!nodes.length && object(conversation.mapping)) {
        const all = Object.entries(conversation.mapping), parents = new Set(all.map(([, node]) => node?.parent));
        let cursor = all.filter(([id]) => !parents.has(id)).at(-1)?.[0];
        const visited = new Set();
        while (cursor && conversation.mapping[cursor] && !visited.has(cursor)) {
          visited.add(cursor); nodes.unshift(conversation.mapping[cursor]); cursor = conversation.mapping[cursor].parent;
        }
        if (!nodes.length) nodes = Object.values(conversation.mapping);
      }
      for (const [index, node] of nodes.entries()) {
        const m = node?.message; if (!m) continue;
        const sourceRole = m.author?.role || 'assistant';
        let kind = roleName(sourceRole);
        if (sourceRole === 'assistant' && /analysis|reasoning|thinking/.test(m.channel ?? m.metadata?.channel ?? '')) kind = 'thinking';
        const text = contentText(m.content);
        const reasoning = m.reasoning ?? m.metadata?.reasoning;
        if (reasoning && kind !== 'user') add(turns, 'thinking', reasoning, index, m, conversation, { source_role: sourceRole, source_node_id: node.id ?? nodeIds.get(node), channel: m.channel ?? m.metadata?.channel });
        add(turns, kind, text, index, m, conversation, { source_role: sourceRole, source_node_id: node.id ?? nodeIds.get(node), channel: m.channel ?? m.metadata?.channel });
      }
      result.push(build('openai', conversation, turns, sourceFile, undefined, { sourceIndex: sourceIndex ?? index }));
    }
    return result;
  }
  if (provider === 'anthropic') {
    const convertedMeta = data?._meta_ai_archive?.format === 'meta-ai-to-threadshelf';
    for (const [index, conv] of (Array.isArray(data) ? data : Array.isArray(data.conversations) ? data.conversations : [data]).entries()) {
      const turns = [];
      for (const [index, m] of list(conv.chat_messages ?? conv.messages).entries()) {
        const kind = roleName(m.sender ?? m.role), content = m.content;
        if (kind === 'user') {
          add(turns, 'user', m.text || content?.content || content, index, m, conv);
        } else {
          const blocks = Array.isArray(content) ? content : list(content?.contentBlocks);
          const thinking = blocks.filter(b => b?.type === 'thinking' || b?.type === 'redacted_thinking').map(b => b.thinking ?? b.text ?? '[Redacted thinking]');
          const answers = blocks.filter(b => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
          add(turns, 'thinking', thinking, index, m, conv);
          add(turns, 'ai', content?.content || (answers.length ? answers : m.text || (typeof content === 'string' ? content : '')), index, m, conv);
        }
      }
      const p = convertedMeta || conv.meta_ai_source ? 'meta' : 'anthropic';
      result.push(build(p, conv, turns, sourceFile, undefined, { sourceIndex: sourceIndex ?? index }));
    }
    return result;
  }
  if (provider === 'google-ai-studio') {
    const turns = [];
    for (const [index, chunk] of list(data.chunkedPrompt?.chunks).entries()) {
      const kind = chunk.isThought ? 'thinking' : roleName(chunk.role);
      add(turns, kind, chunk.text ?? (chunk.driveImage ? '[Image attachment]' : chunk.parts), index, chunk, data);
    }
    for (const [index, entry] of list(data.imagenPrompt?.imagenTurns).entries()) {
      add(turns, 'user', entry.prompt, index, entry, data);
      if (entry.generatedImages?.length) add(turns, 'ai', '[Image attachment]', index, entry, data);
    }
    result.push(build('google-ai-studio', data, turns, sourceFile)); return result;
  }
  if (provider === 'openrouter') {
    result.push(build(provider, data, genericMessages(data.turns, data), sourceFile)); return result;
  }
  if (provider === 'lm-studio') {
    const turns = [];
    for (const [index, m] of data.messages.entries()) {
      const version = m.versions?.[m.currentlySelected] ?? m.versions?.[0]; if (!version) continue;
      const meta = { ...version, createdAt: version.createdAt ?? m.createdAt, model: version.senderInfo?.senderName ?? data.lastUsedModel?.identifier };
      if (Array.isArray(version.steps)) {
        const thoughts = [], answers = [];
        for (const step of version.steps) if (step.type === 'contentBlock') (step.style?.type === 'thinking' ? thoughts : answers).push(contentText(step.content));
        add(turns, 'thinking', stripControlTokens(thoughts.join('\n\n')), index, meta, data);
        add(turns, 'ai', stripControlTokens(answers.join('\n\n')), index, meta, data);
      } else add(turns, roleName(version.role), stripControlTokens(contentText(version.content)), index, meta, data);
    }
    result.push(build(provider, data, turns, sourceFile)); return result;
  }
  if (provider === 'grok') {
    for (const [index, entry] of data.conversations.entries()) {
      const conv = entry.conversation || {}, turns = [];
      for (const [index, wrapper] of list(entry.responses).entries()) {
        const m = wrapper.response || wrapper;
        if (roleName(m.sender) !== 'user') add(turns, 'thinking', m.agent_thinking_traces, index, m, conv);
        add(turns, roleName(m.sender), m.message, index, m, conv, { ...(m.venice_metadata ? { source_role: m.venice_metadata.role, parent_message_id: m.venice_metadata.parentMessageId } : {}) });
      }
      const p = entry.venice_metadata || entry.venice_conversation || entry.responses?.some(r => r.response?.venice_metadata) ? 'venice' : 'grok';
      result.push(build(p, conv, turns, sourceFile, p === 'venice' && conv.venice_owner_id != null ? `${conv.venice_owner_id}:${conv.id ?? conv.conversation_id}` : undefined, { raw: entry, sourceIndex: sourceIndex ?? index }));
    }
    return result;
  }
  // Native Takeout activity JSON. Activity entries with only prompts are retained as prompts.
  const activities = Array.isArray(data) ? data : data?.activity ?? data?.activities;
  if (Array.isArray(activities) && activities.some(a => /gemini/i.test(String(a?.header) + String(a?.titleUrl) + String(a?.products)))) {
    const grouped = new Map();
    for (const [index, activity] of activities.entries()) {
      if (!object(activity) || !/gemini/i.test(String(activity.header) + String(activity.titleUrl) + String(activity.products))) continue;
      const url = String(activity.titleUrl ?? activity.url ?? ''), match = /gemini\.google\.com\/app\/([A-Za-z0-9_-]+)/.exec(url);
      const id = match?.[1] ?? hash(activity), item = grouped.get(id) || { title: '', id, activities: [], turns: [] };
      item.activities.push(activity);
      const prompt = activity.prompt ?? String(activity.title ?? '').replace(/^(?:Prompted|Submitted prompt:|Elküldött lekérdezés:)\s*/i, '');
      add(item.turns, 'user', prompt, index, activity);
      add(item.turns, 'ai', activity.response ?? activity.answer ?? '', index, activity);
      grouped.set(id, item);
    }
    return [...grouped.values()].map(item => build('gemini', item, item.turns, sourceFile, item.id));
  }
  if (Array.isArray(data)) {
    for (const [index, conversation] of data.entries()) {
      if (!object(conversation)) continue;
      try { result.push(...normalizeDocument(conversation, sourceFile, { limits, sourceIndex: sourceIndex ?? index })); } catch (error) { if (error.name === 'AbortError') throw error; /* Non-conversation metadata is retained in the original input. */ }
    }
    if (result.length) return result;
  }
  if (Array.isArray(data?.messages)) {
    const provider = data.provider ?? data.platform ?? 'converted';
    result.push(build(String(provider).toLowerCase(), data, genericMessages(data.messages, data), sourceFile)); return result;
  }
  if (Array.isArray(data?.chat_messages)) return [];
  throw new Error('Unrecognized conversation export. Select a supported native JSON/HTML export, its ZIP archive, or an export folder.');
}

function* tree(node) { if (typeof node !== 'string') { yield node; for (const child of node.children ?? []) yield* tree(child); } }
function htmlConversations(raw, sourceFile, options) {
  const source = raw.toString('utf8');
  if (/outer-cell/.test(source) && /gemini/i.test(source)) {
    const prepared = prepareGemini(raw);
    for (const warning of [...prepared.report.warnings, ...prepared.report.unknownDescriptions]) emit(options, { phase: 'warning', sourceFile, message: warning });
    if (prepared.report.canvas) emit(options, { phase: 'warning', sourceFile, message: `${prepared.report.canvas} unassigned Canvas activities retained as separate records.` });
    const results = prepared.conversations.map(conv => {
      const turns = conv.chunks.map((chunk, index) => ({ [chunk.role === 'user' ? 'user' : 'ai']: chunk.text, createdAt: chunk.createdAt, turn_index: chunk.source_index ?? index }));
      return build('gemini', conv, turns, sourceFile, conv.id, { raw: { ...conv, sourceSHA256: prepared.sourceSHA256 } });
    });
    for (const canvas of prepared.canvas) results.push(build('gemini', { title: 'Unassigned Gemini Canvas', ...canvas }, [{ ai: canvas.content, turn_index: canvas.card, createdAt: canvas.createdAt, source_role: 'canvas' }], sourceFile, `canvas:${hash(canvas)}`));
    return results;
  }
  // Official chat.html and ChatGPT Export Processor -index.html embed a strict JSON
  // array in a jsonData assignment. Parse only that literal, never execute the script.
  const assignment = /(?:var|let|const)\s+jsonData\s*=\s*/.exec(source.slice(0, 16 * 1024 ** 2));
  if (assignment) {
    const start = assignment.index + assignment[0].length;
    if (source[start] !== '[') throw new Error('jsonData is not a JSON array.');
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { if (--depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) throw new Error('Incomplete jsonData array in HTML.');
    return normalizeDocument(decodeJSONBytes(Buffer.from(source.slice(start, end))), sourceFile, options);
  }
  const document = parseDocument(source), nodes = [...tree(document)];
  // Safe JSON-bearing scripts from static exporters are parsed; JavaScript assignments are never evaluated.
  for (const script of nodes.filter(n => n.tag === 'script' && (/json/i.test(n.attrs.type || '') || /^(?:data|conversations|export-data)$/.test(n.attrs.id || '')))) {
    try { return normalizeDocument(JSON.parse(script.children.filter(c => typeof c === 'string').join('')), sourceFile, options); } catch { /* try the visible conversation structure */ }
  }
  const blocks = nodes.filter(n => /(?:^|\s)(?:conversation|conversation-card)(?:\s|$)/.test(n.attrs?.class || '') || n.attrs?.['data-conversation-id']);
  const results = [];
  for (const [index, block] of blocks.entries()) {
    const children = [...tree(block)], turns = [];
    const messages = children.filter(n => /(?:^|\s)(?:message|turn)(?:\s|$)/.test(n.attrs?.class || '') || n.attrs?.['data-message-author-role']);
    for (const [i, message] of messages.entries()) {
      const role = message.attrs['data-message-author-role'] || message.attrs['data-role'] || (/\buser\b/.test(message.attrs.class || '') ? 'user' : /\bthinking\b/.test(message.attrs.class || '') ? 'thinking' : 'assistant');
      add(turns, roleName(role), renderChildren(message.children), i, {}, {}, { source_role: role });
    }
    if (turns.length) {
      const heading = children.find(n => /^h[1-3]$/.test(n.tag));
      const record = { title: heading ? plain(heading).trim() : `Conversation ${index + 1}`, originalMarkup: block };
      results.push(build('converted', record, turns, sourceFile, block.attrs['data-conversation-id']));
    }
  }
  if (!results.length) throw new Error('This HTML has no recognized conversation data. Import the original JSON or Gemini Takeout HTML. HTML and scripts are never executed.');
  return results;
}

const metadataFiles = new Set(['users.json', 'projects.json', 'user.json', 'message_feedback.json', 'shared_conversations.json', 'sora.json', 'applet_access_history.json']);
function candidate(name) { return !metadataFiles.has(path.posix.basename(name).toLowerCase()) && (/\.(?:json|html?|zip)$/i.test(name) || !path.posix.extname(name)); }
class DiskZipReader extends Reader {
  constructor(handle, size, maxRead) { super(); this.handle = handle; this.size = size; this.maxRead = maxRead; }
  async readUint8Array(index, length) {
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(length) || length > this.maxRead || length < 0 || index < 0 || index + length > this.size) throw new Error('Invalid ZIP entry bounds.');
    const data = Buffer.alloc(length); let n = 0;
    while (n < length) { const { bytesRead } = await this.handle.read(data, n, length - n, index + n); if (!bytesRead) throw new Error('Truncated ZIP.'); n += bytesRead; }
    // zip.js expects Uint8Array.slice() copy semantics. Buffer.slice() returns a
    // view and corrupts ZIP64/NTFS extra-field offsets inside this library.
    return new Uint8Array(data);
  }
}
function validateEntries(entries, limits) {
  if (entries.length > limits.entries) throw new Error('ZIP contains too many entries.');
  const names = new Set();
  for (const entry of entries) {
    const name = entry.filename;
    if (![entry.uncompressedSize, entry.compressedSize].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error(`ZIP entry size is not a safe integer (${entry.uncompressedSize}, ${entry.compressedSize}).`);
    if (name.length > 32768) throw new Error('ZIP entry name exceeds the safety limit.');
    const canonical = name.replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/');
    if (names.has(canonical)) throw new Error('ZIP contains duplicate entry names: ' + name);
    names.add(canonical);
    if (name.includes('\0') || /(^[\\/]|^[a-z]:|(?:^|[\\/])\.\.(?:[\\/]|$))/i.test(name)) throw new Error('ZIP contains an unsafe path: ' + name);
  }
}
async function zipBytes(entry, options, maxBytes) {
  if (entry.encrypted) throw new Error('Encrypted ZIP entries require an unencrypted export.');
  if (entry.uncompressedSize > maxBytes) throw new Error(`ZIP member exceeds ${Math.round(maxBytes / 1024 ** 2)} MiB safety limit: ${entry.filename}`);
  const chunks = []; let total = 0;
  await entry.getData(new WritableStream({ write(chunk) { abort(options.signal); total += chunk.byteLength; if (total > maxBytes) throw new Error('Expanded ZIP member exceeded safety limit.'); chunks.push(Buffer.from(chunk)); } }), { checkSignature: true, useWebWorkers: false, signal: options.signal });
  return Buffer.concat(chunks);
}
/** ZIP decompression uses stream backpressure, and remains cancellable when a
 * consumer rejects a record or stops early. CRC is checked by zip.js. */
async function* zipChunks(entry, options, maxBytes) {
  if (entry.encrypted) throw new Error('Encrypted ZIP entries require an unencrypted export.');
  if (entry.uncompressedSize > maxBytes) throw new Error('ZIP member exceeds the configured streaming safety limit.');
  const controller = new AbortController(), cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', cancel, { once: true });
  const stream = new TransformStream(); let failure, total = 0;
  const pump = entry.getData(stream.writable, { checkSignature: true, useWebWorkers: false, signal: controller.signal })
    .catch(async error => { failure = error; try { await stream.writable.abort(error); } catch {} });
  try {
    for await (const chunk of stream.readable) {
      abort(options.signal); total += chunk.byteLength;
      if (total > maxBytes) throw new Error('Expanded ZIP member exceeded the configured streaming safety limit.');
      yield chunk;
    }
    await pump;
    if (failure) throw failure;
    if (total !== entry.uncompressedSize) throw new Error('Expanded ZIP size does not match its directory.');
  } finally {
    controller.abort(); options.signal?.removeEventListener('abort', cancel); await pump;
  }
}

const needsWholeArray = value => object(value) &&
  (['user', 'ai', 'thinking'].some(k => typeof value[k] === 'string') || /gemini/i.test(String(value.header) + String(value.titleUrl) + String(value.products)));

/** First pass validates the entire document (and the ZIP CRC), collecting only
 * bounded wrapper metadata. Never acknowledge conversations from a corrupt ZIP.
 * Second pass frames and normalizes one conversation at a time. */
async function* streamedJSON(factory, size, filename, options) {
  const limits = { ...options.limits, recordBytes: Math.min(options.limits.fileBytes, options.limits.recordBytes) };
  const parseOptions = { ...options, limits }, metadata = Object.create(null);
  let kind, wrapped = false, count = 0, metadataBytes = 0, whole = false, lastProgress = 0;
  const progressSource = async function* (phase) {
    let bytes = 0, last = 0;
    for await (const chunk of factory()) {
      bytes += chunk.byteLength;
      if (bytes - last >= 32 * 1024 ** 2) { last = bytes; emit(options, { phase, sourceFile: filename, bytes, totalBytes: size, message: `${phase === 'validating' ? 'Validating' : 'Reading'} ${Math.round(bytes / 1024 ** 2)} MiB of ${Math.round(size / 1024 ** 2)} MiB.` }); }
      yield chunk;
    }
  };
  emit(options, { phase: 'validating', sourceFile: filename, message: 'Validating JSON and archive integrity before importing.' });
  for await (const event of jsonEvents(progressSource('validating'), parseOptions)) {
    abort(options.signal);
    if (event.type === 'start') kind = event.kind;
    if (event.type === 'container') wrapped = true;
    if (event.type === 'record') {
      if (++count > limits.records) throw new Error('JSON container contains too many conversation records.');
      if (needsWholeArray(event.value)) whole = true;
      safeTree(event.value, limits);
      if (count - lastProgress >= 100) { lastProgress = count; emit(options, { phase: 'validating', sourceFile: filename, current: count, message: `Validated ${count} records.` }); await tick(); }
    }
    if (event.type === 'field') {
      safeTree(event.value, limits);
      metadataBytes += event.bytes;
      if (metadataBytes > limits.fileBytes) throw new Error('JSON wrapper metadata exceeds the whole-document safety limit.');
      metadata[event.name] = event.value;
    }
  }
  // These providers join data across records or apply global conversion metadata.
  whole ||= kind !== 'array' && !wrapped;
  whole ||= metadata.venice_conversion != null || metadata.format === 'venice-chat-history' || Array.isArray(metadata.owners) || Array.isArray(metadata.label_values);
  if (kind === 'object' && !wrapped) {
    for (const record of normalizeDocument(metadata, filename, options)) if (record.turns.length) yield record;
    return;
  }
  if (whole || metadataBytes > limits.metadataBytes) {
    if (size > limits.fileBytes) throw new Error(`This JSON adapter requires whole-document processing and is limited to ${Math.round(limits.fileBytes / 1024 ** 2)} MiB. Export separate conversations or use a supported conversation-array JSON format.`);
    const chunks = []; let total = 0;
    for await (const chunk of factory()) { abort(options.signal); total += chunk.byteLength; if (total > limits.fileBytes) throw new Error('JSON exceeds the whole-document safety limit.'); chunks.push(Buffer.from(chunk)); }
    for (const record of parseBytes(Buffer.concat(chunks), filename, options)) if (record.turns.length) yield record;
    return;
  }
  // Release large non-streaming metadata before opening the second input stream.
  emit(options, { phase: 'parsing', sourceFile: filename, total: count, message: 'Importing validated conversations.' });
  for await (const event of jsonEvents(progressSource('parsing'), parseOptions)) {
    if (event.type !== 'record') continue;
    abort(options.signal);
    let records;
    if (wrapped && (event.value?.responses || event.value?.chat_messages)) records = normalizeDocument({ ...metadata, conversations: [event.value] }, filename, { ...options, sourceIndex: event.index });
    else {
      // Array normalization historically ignores non-conversation metadata records.
      try { records = normalizeDocument(event.value, filename, { ...options, sourceIndex: event.index }); }
      catch (error) { if (kind !== 'array') throw error; emit(options, { phase: 'warning', sourceFile: filename, message: `Skipped non-conversation array record ${event.index + 1}: ${error.message}` }); continue; }
    }
    for (const record of records) if (record.turns.length) yield record;
    await tick();
  }
}

async function* parseSource(factory, size, filename, options, readSmall) {
  if (size <= Math.min(options.limits.streamingThreshold, options.limits.fileBytes)) {
    for (const record of parseBytes(await readSmall(), filename, options)) if (record.turns.length) yield record;
    return;
  }
  let prefix = Buffer.alloc(0);
  for await (const chunk of factory()) { prefix = Buffer.from(chunk.subarray(0, 8192)); break; }
  const head = prefix.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  const utf8 = !prefix.subarray(0, 4).includes(0) && !(prefix[0] === 0xff || prefix[0] === 0xfe);
  if (/\.html?$/i.test(filename) || head.startsWith('<') || !utf8 || (!head && size <= prefix.length) || (head && !/^[\[{]/.test(head))) {
    const limit = /\.html?$/i.test(filename) || head.startsWith('<') ? options.limits.htmlBytes : options.limits.fileBytes;
    if (size > limit) throw new Error(`HTML, non-UTF-8 JSON and unsupported containers retain the ${Math.round(limit / 1024 ** 2)} MiB whole-document safety limit. Use UTF-8 conversation-array JSON for larger exports.`);
    for (const record of parseBytes(await readSmall(), filename, options)) if (record.turns.length) yield record;
  } else yield* streamedJSON(factory, size, filename, options);
}

async function* scan(paths, options, depth = 0, seen = new Set()) {
  for (const input of paths) {
    abort(options.signal);
    const filename = path.resolve(input);
    if (seen.has(filename)) continue;
    seen.add(filename);
    try {
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) { emit(options, { phase: 'skipped', sourceFile: filename, message: 'Symbolic link skipped.' }); continue; }
      if (stat.isDirectory()) {
        if (depth >= options.limits.depth) throw new Error('Folder nesting exceeds import depth limit.');
        const children = await fs.readdir(filename);
        yield* scan(children.sort().map(name => path.join(filename, name)), options, depth + 1, seen);
      } else if (stat.isFile() && (depth === 0 || candidate(path.basename(filename)))) yield { filename, stat };
    } catch (error) { if (error.name === 'AbortError') throw error; yield { error: error.message, sourceFile: filename }; }
  }
}
function parseBytes(raw, filename, options) {
  abort(options.signal);
  const head = raw.subarray(0, 200).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/\.html?$/i.test(filename) || head.startsWith('<!DOCTYPE') || head.startsWith('<html')) {
    if (raw.length > options.limits.htmlBytes) throw new Error('HTML exceeds the configured safety limit.');
    return htmlConversations(raw, filename, options);
  }
  return normalizeDocument(decodeJSONBytes(raw), filename, options);
}

/**
 * Yields conversation records and {error,sourceFile} diagnostics. An unsupported file does
 * not prevent other files importing. AbortError terminates cooperatively. Progress callbacks
 * report scanning/reading/parsing/imported/warning/skipped/error phases.
 */
export async function* importPaths(paths, options = {}) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Select at least one export file or folder.');
  options = { ...options, limits: { ...IMPORT_LIMITS, ...options.limits } };
  const files = [], backups = []; let expanded = 0, current = 0;
  emit(options, { phase: 'scanning', message: 'Scanning selected exports.' });
  for await (const item of scan(paths, options)) { if (item.error) yield item; else files.push(item); if (files.length > options.limits.entries) throw new Error('Too many selected files.'); }
  for (const item of files) {
    abort(options.signal); current++;
    const filename = item.filename;
    emit(options, { phase: 'reading', current, total: files.length, sourceFile: filename, message: path.basename(filename) });
    try {
      if (/\.zip$/i.test(filename)) {
        if (!Number.isSafeInteger(item.stat.size) || item.stat.size > options.limits.zipBytes) throw new Error('ZIP exceeds the configured input safety limit.');
        // Keep a ZIP open only while processing it; entries are never written to disk.
        const handle = await fs.open(filename, 'r');
        const zip = new ZipReader(new DiskZipReader(handle, item.stat.size, options.limits.directoryBytes), { useWebWorkers: false });
        try {
          const entries = [];
          for await (const entry of zip.getEntriesGenerator()) { abort(options.signal); if (entries.length >= options.limits.entries) throw new Error('ZIP contains too many entries.'); entries.push(entry); }
          validateEntries(entries, options.limits);
          const manifest = entries.find(e => e.filename === 'manifest.json');
          if (manifest && manifest.uncompressedSize <= 1024 * 1024) {
            try {
              const manifestData = decodeJSONBytes(await zipBytes(manifest, options, 1024 * 1024));
              if (manifestData.backupVersion === 4) { backups.push(filename); continue; }
            } catch (error) {
              if (error.name === 'AbortError') throw error;
              // An unrelated malformed manifest must not hide valid exports in the same ZIP.
              // The normal per-member pass reports its actual diagnostic below.
            }
          }
          if (entries.some(e => /^db\/chunk-\d+\.json$/.test(e.filename))) { backups.push(filename); continue; }
          for (const entry of entries) {
            abort(options.signal);
            if (entry.directory || !candidate(entry.filename) || /\.zip$/i.test(entry.filename)) continue;
            const sourceFile = filename + '!' + entry.filename;
            try {
              const limit = /\.html?$/i.test(entry.filename) ? options.limits.htmlBytes : options.limits.fileBytes;
              expanded += entry.uncompressedSize;
              if (expanded > options.limits.expandedBytes) throw new Error('Selected archives exceed the configured expanded-data safety limit.');
              let found = false;
              for await (const record of parseSource(() => zipChunks(entry, options, options.limits.streamBytes), entry.uncompressedSize, sourceFile, options, () => zipBytes(entry, options, limit))) { found = true; abort(options.signal); yield record; }
              if (!found) emit(options, { phase: 'skipped', sourceFile, message: 'No readable conversation turns.' });
              await tick();
            } catch (error) { if (error.name === 'AbortError') throw error; emit(options, { phase: 'error', sourceFile, message: error.message }); yield { error: error.message, sourceFile }; }
          }
        } finally { await zip.close(); await handle.close(); }
      } else {
        if (!Number.isSafeInteger(item.stat.size) || item.stat.size > options.limits.streamBytes) throw new Error('JSON exceeds the configured streaming input safety limit.');
        const handle = await fs.open(filename, 'r');
        try {
          const initial = await handle.stat();
          const unchanged = async () => { const state = await handle.stat(); if (state.size !== initial.size || state.mtimeMs !== initial.mtimeMs) throw new Error('Input changed during import. Retained completed records; retry using a stable copy of the export.'); };
          const factory = async function* () {
            await unchanged();
            for (let offset = 0; offset < initial.size;) {
              abort(options.signal); const bytes = Buffer.allocUnsafe(Math.min(256 * 1024, initial.size - offset));
              const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
              if (!bytesRead) throw new Error('Input was truncated during import.');
              offset += bytesRead; yield bytes.subarray(0, bytesRead);
            }
            await unchanged();
          };
          const readSmall = async () => { const chunks = []; for await (const chunk of factory()) chunks.push(chunk); return Buffer.concat(chunks); };
          let found = false;
          for await (const record of parseSource(factory, initial.size, filename, options, readSmall)) { found = true; abort(options.signal); yield record; }
          const final = await handle.stat();
          if (initial.size !== final.size || initial.mtimeMs !== final.mtimeMs) throw new Error('Input changed during import. Retained completed records; retry using a stable copy of the export.');
          if (!found) emit(options, { phase: 'skipped', sourceFile: filename, message: 'No readable conversation turns.' });
        } finally { await handle.close(); }
      }
    } catch (error) { if (error.name === 'AbortError') throw error; emit(options, { phase: 'error', sourceFile: filename, message: error.message }); yield { error: error.message, sourceFile: filename }; }
    await tick();
  }
  if (backups.length) {
    const sourceFile = backups.join(';');
    try {
      abort(options.signal);
      const backup = await loadBackup(backups, { signal: options.signal, limits: { jsonBytes: options.limits.fileBytes, databaseBytes: Math.min(options.limits.expandedBytes, 2 * 1024 ** 3), uploadBytes: Math.min(options.limits.zipBytes, 4 * 1024 ** 3) } });
      abort(options.signal);
      for (const record of normalizeDocument(backup, sourceFile, options)) if (record.turns.length) yield record;
    } catch (error) { if (error.name === 'AbortError') throw error; yield { error: error.message, sourceFile }; }
  }
  emit(options, { phase: 'complete', current: files.length, total: files.length, message: 'Import scan complete.' });
}
