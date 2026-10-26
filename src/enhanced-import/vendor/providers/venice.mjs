/** Native Venice console-export and v4 backup reader; archival data stays intact. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseJSON, stringifyJSON, pythonJSON, utcNow, cleanReasoning, creationTimeMs } from './common.mjs';

export const LIMITS = Object.freeze({ jsonBytes: 512 * 1024 ** 2, databaseBytes: 2 * 1024 ** 3, uploadBytes: 4 * 1024 ** 3 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' ? value.trim() || null : null;
const without = (value, ...keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const child = message => message.parentMessageId !== undefined && message.parentMessageId !== null && message.parentMessageId !== '';
const get = (obj, key) => Object.hasOwn(obj, key) ? obj[key] : null;
// Construct sorted object text directly: JS objects automatically reorder numeric
// property names, which would change Python's lexical sort of keys "10" and "2".
const unicodeCompare = (a, b) => {
  const left = [...a], right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = left[index].codePointAt(0) - right[index].codePointAt(0);
    if (difference) return difference;
  }
  return left.length - right.length;
};
const sortedJSON = value => Array.isArray(value) ? '[' + value.map(sortedJSON).join(', ') + ']' : object(value) ? '{' + Object.keys(value).sort(unicodeCompare).map(key => JSON.stringify(key) + ': ' + sortedJSON(value[key])).join(', ') + '}' : pythonJSON(value);
const stringifyContent = value => typeof value === 'string' ? value : value == null ? '' : sortedJSON(value);
const string = value => value == null ? '' : String(value);

// Python str for the original title-generator excerpt; JSON content gets its own
// JSON serialization in the Grok converter below. This distinction is intentional.
function pythonRepr(value) {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    return quote + value.replaceAll('\\', '\\\\').replaceAll(quote, '\\' + quote).replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t') + quote;
  }
  if (Array.isArray(value)) return '[' + value.map(pythonRepr).join(', ') + ']';
  if (object(value)) return '{' + Object.entries(value).map(([key, item]) => pythonRepr(key) + ': ' + pythonRepr(item)).join(', ') + '}';
  return String(value);
}
const excerptContent = value => !value || Array.isArray(value) && !value.length || object(value) && !Object.keys(value).length ? '' : typeof value === 'string' ? value : pythonRepr(value);
const slice = (text, length) => [...text].slice(0, length).join('');

export function excerptFor(conversation) {
  const messages = conversation.messages || [];
  const roots = messages.filter(message => object(message) && message.parentMessageId == null);
  const selected = [];
  let users = 0, assistants = 0;
  for (const message of roots) {
    const content = excerptContent(message.content);
    if (message.role === 'user' && users < 2) selected.push('User: ' + slice(content, users++ === 0 ? 2200 : 900));
    else if (message.role === 'assistant' && assistants < 1) { selected.push('Assistant: ' + slice(content, 1300)); assistants++; }
    if (users >= 2 && assistants >= 1) break;
  }
  if (!selected.length && messages.length && object(messages[0])) selected.push(slice(excerptContent(messages[0].content), 2400));
  return slice(selected.join('\n\n'), 5000);
}

/** Check structures before conversion so no partial file can be produced. */
export function validateExport(data, { force = false, allowEmpty = false } = {}) {
  if (!object(data)) throw new Error('The input JSON root must be an object.');
  if (!force && data.format !== 'venice-chat-history') throw new Error('Not a venice-chat-history export.');
  if (!force && Number(data.formatVersion) !== 1) throw new Error(`Unsupported formatVersion: ${string(data.formatVersion)}`);
  if (!Array.isArray(data.owners)) throw new Error("Missing or invalid top-level 'owners' array.");
  const conversations = [];
  for (const [ownerIndex, owner] of data.owners.entries()) {
    if (!object(owner)) throw new Error(`owners[${ownerIndex}] is not an object.`);
    if (!Array.isArray(owner.conversations)) throw new Error(`owners[${ownerIndex}].conversations is not an array.`);
    for (const [index, conversation] of owner.conversations.entries()) {
      if (!object(conversation)) throw new Error(`owners[${ownerIndex}].conversations[${index}] is not an object.`);
      if (!Array.isArray(conversation.messages)) throw new Error(`Conversation ${string(conversation.id)} has no valid messages array.`);
      if (!conversation.messages.every(object)) throw new Error(`Conversation ${string(conversation.id)} contains a message that is not an object.`);
      conversations.push(conversation);
    }
  }
  if (!allowEmpty && !conversations.length) throw new Error('No conversations found.');
  return conversations;
}

function plainRow(raw) {
  const result = structuredClone(raw);
  const types = Object.hasOwn(result, '$types') ? result.$types : {};
  delete result.$types;
  if (!object(types)) throw new Error('Unsupported Dexie type annotations in a conversation/message.');
  for (const [keyPath, kind] of Object.entries(types)) {
    if (kind === 'arrayNonindexKeys') continue;
    if (kind !== 'undef') throw new Error(`Unsupported Dexie chat value type: ${String(kind)} at ${keyPath}. Use the console JSON export for this backup.`);
    const pieces = keyPath.split('.');
    let target = result;
    for (const piece of pieces.slice(0, -1)) {
      if (Array.isArray(target)) target = /^\d+$/.test(piece) && Number(piece) < target.length ? target[Number(piece)] : null;
      else if (object(target)) target = Object.hasOwn(target, piece) ? target[piece] : null;
      else { target = null; break; }
    }
    const last = pieces.at(-1);
    if (Array.isArray(target) && /^\d+$/.test(last) && Number(last) < target.length) target[Number(last)] = null;
    else if (object(target)) delete target[last];
  }
  return result;
}

async function jsonMember(entry, password, limits, signal) {
  if (entry.uncompressedSize > limits.jsonBytes) throw new Error(`Database/manifest entry exceeds the 512 MiB safety limit: ${entry.filename}`);
  if (entry.encrypted && !entry.zipCrypto) throw new Error('AES-encrypted ZIP containers are not supported. Use a standard ZipCrypto ZIP or an unencrypted backup.');
  const parts = [];
  let size = 0;
  const writer = new WritableStream({ write(chunk) {
    if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    size += chunk.byteLength;
    if (size > limits.jsonBytes) throw new Error('Expanded database entry exceeds the 512 MiB safety limit.');
    parts.push(Buffer.from(chunk));
  } });
  try {
    await entry.getData(writer, { password: password || undefined, checkSignature: true, useWebWorkers: false, signal });
  } catch (error) {
    if (error.name === 'AbortError' || /safety limit/.test(error.message)) throw error;
    if (entry.encrypted) throw new Error('Cannot decrypt ZIP entry. Check the ZIP password; Venice native encrypted backups are a separate format.', { cause: error });
    throw new Error(`Invalid or corrupt ZIP entry: ${entry.filename}`, { cause: error });
  }
  try {
    return parseJSON(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  } catch (error) {
    throw new Error(`Entry is not readable JSON: ${entry.filename}. Encrypted Venice payloads require a verified decryption format; export with Don't encrypt this backup.`, { cause: error });
  }
}

/** Complete ZIP containers may each carry a subset of the numbered DB chunks.
 * Files are random-accessed; media is never read, extracted, or discarded.
 */
export async function loadBackup(paths, { password, limits = LIMITS, signal, beforeWholeDocument } = {}) {
  const { ZipReader, Reader, Uint8ArrayReader } = await import('@zip.js/zip.js');
  class FileReader extends Reader {
    constructor(handle, size) { super(); this.handle = handle; this.size = size; }
    async readUint8Array(index, length) {
      const data = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await this.handle.read(data, read, length - read, index + read);
        if (!bytesRead) throw new Error('Unexpected end of ZIP file.');
        read += bytesRead;
      }
      // zip.js parses extra fields with Uint8Array.slice() copy semantics;
      // Buffer.slice() views otherwise corrupt ZIP64 offsets and sizes.
      return new Uint8Array(data);
    }
  }
  let manifest = null, total = 0, uploaded = 0;
  const chunks = new Map(), media = new Set();
  for (const source of paths) {
    if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    let handle, zip;
    try {
      let reader;
      if (typeof source === 'string') {
        handle = await fs.open(source, 'r');
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('ZIP input must be a regular file.');
        uploaded += info.size;
        reader = new FileReader(handle, info.size);
      } else {
        uploaded += source.byteLength;
        reader = new Uint8ArrayReader(source);
      }
      if (uploaded > limits.uploadBytes) throw new Error('Selected files exceed the 4 GiB upload safety limit.');
      zip = new ZipReader(reader, { useWebWorkers: false });
      let entries;
      // zip.js >=2.16 validates names as if they will be extracted. This reader
      // never extracts archive paths: only exact manifest.json/db/chunk-N.json
      // names are read into memory, and all other names are archival metadata.
      // Preserve those literal names (including traversal-looking media paths)
      // without weakening structural ZIP validation or writing any entry to disk.
      try { entries = await zip.getEntries({ filenameValidation: 'tolerant' }); }
      catch (error) { throw new Error('Invalid, corrupt or byte-split ZIP. Select complete ZIP containers from the same backup.', { cause: error }); }
      if (new Set(entries.map(entry => entry.filename)).size !== entries.length) throw new Error('Duplicate archive entry names; refusing ambiguous backup.');
      const manifestEntry = entries.find(entry => entry.filename === 'manifest.json');
      if (manifestEntry) {
        const current = await jsonMember(manifestEntry, password, limits, signal);
        if (!object(current) || current.backupVersion !== 4) throw new Error('Unsupported Venice backup manifest version (expected 4).');
        if (current.encrypted !== false) throw new Error("Venice native encrypted backups are not yet supported. Create a backup with Don't encrypt this backup, or use your console JSON export. A ZIP password does not decrypt Venice's internal encrypted files.");
        if (manifest && !isDeepStrictEqual(manifest, current)) throw new Error('The selected ZIPs belong to different backups (manifests differ).');
        manifest = current;
      }
      if (entries.length > 100000) throw new Error('ZIP contains too many entries.');
      for (const entry of entries) {
        if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
        const match = /^db\/chunk-(0|[1-9][0-9]*)\.json$/.exec(entry.filename);
        if (match) {
          const index = Number(match[1]);
          if (chunks.has(index)) throw new Error(`Duplicate database chunk ${index}; select each part only once.`);
          total += entry.uncompressedSize;
          if (total > limits.databaseBytes) throw new Error('Database exceeds the 2 GiB expanded-data safety limit. Use a smaller export.');
          await beforeWholeDocument?.(total);
          chunks.set(index, await jsonMember(entry, password, limits, signal));
        } else if (!entry.directory && entry.filename !== 'manifest.json') media.add(entry.filename);
      }
    } finally { if (zip) await zip.close(); if (handle) await handle.close(); }
  }
  if (!manifest) throw new Error('Missing manifest.json. Select all ZIP parts of one Venice backup.');
  const count = manifest.chunkCount;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 100000) throw new Error('Invalid manifest chunkCount.');
  const missing = Array.from({ length: count }, (_, index) => index).filter(index => !chunks.has(index));
  const extra = [...chunks.keys()].filter(index => index >= count).sort((a, b) => a - b);
  if (missing.length || extra.length) throw new Error(`Incomplete/inconsistent backup: missing chunks [${missing.slice(0, 20)}], unexpected chunks [${extra.slice(0, 20)}]. Select all parts together.`);
  const tables = new Map();
  for (let index = 0; index < count; index++) {
    const chunk = chunks.get(index);
    if (!object(chunk) || chunk.formatName !== 'dexie' || chunk.formatVersion !== 1) throw new Error(`Chunk ${index} is not a supported Dexie v1 export.`);
    if (!object(chunk.data) || !Array.isArray(chunk.data.data)) throw new Error(`Invalid Dexie data in chunk ${index}.`);
    if (String(chunk.data.databaseVersion) !== String(manifest.databaseVersion)) throw new Error(`Database version mismatch in chunk ${index}.`);
    for (const block of chunk.data.data) {
      if (!object(block) || typeof block.tableName !== 'string' || !Array.isArray(block.rows)) throw new Error(`Invalid table block in chunk ${index}.`);
      if (block.inbound !== true) throw new Error('Unsupported Dexie outbound table encoding.');
      if (!block.rows.every(object)) throw new Error('Invalid database row; expected an object.');
      if (!tables.has(block.tableName)) tables.set(block.tableName, []);
      for (const row of block.rows) tables.get(block.tableName).push(row);
    }
  }
  const conversations = new Map(), owners = new Map(), seenMessages = new Set();
  for (const raw of tables.get('conversations') || []) {
    const conversation = plainRow(raw), id = conversation.id;
    if (typeof id !== 'string' || !id || conversations.has(id)) throw new Error('Missing or duplicate conversation ID; refusing ambiguous title-cache mapping.');
    if (Object.hasOwn(conversation, 'messages')) throw new Error('Unexpected embedded messages in database conversation row.');
    conversation.messages = [];
    conversations.set(id, conversation);
    const owner = Object.hasOwn(conversation, 'ownerId') ? conversation.ownerId : manifest.ownerId;
    if (typeof owner !== 'string') throw new Error('Invalid conversation owner ID.');
    if (!owners.has(owner)) owners.set(owner, { ownerId: owner, conversations: [] });
    owners.get(owner).conversations.push(conversation);
  }
  for (const raw of tables.get('messages') || []) {
    const message = plainRow(raw);
    if (typeof message.id !== 'string' || !message.id || seenMessages.has(message.id)) throw new Error('Missing or duplicate message ID.');
    if (typeof message.conversationId !== 'string' || !conversations.has(message.conversationId)) throw new Error('Backup contains messages without their conversation. Select all parts of a complete backup.');
    seenMessages.add(message.id);
    conversations.get(message.conversationId).messages.push(message);
  }
  const timestamp = message => ['number', 'bigint', 'boolean'].includes(typeof message.createdAtUnixTimestamp) ? message.createdAtUnixTimestamp : 0;
  for (const conversation of conversations.values()) conversation.messages.sort((a, b) => timestamp(a) < timestamp(b) ? -1 : timestamp(a) > timestamp(b) ? 1 : 0);
  const messages = [...conversations.values()].flatMap(conversation => conversation.messages);
  return {
    format: 'venice-chat-history', formatVersion: 1, exportedAt: get(manifest, 'createdAt'),
    source: { databaseName: 'venice-db-encrypted', allStoredMessageVariantsIncluded: true, note: 'Converted from the selected Venice ZIP backup; only records present in that backup are available.' },
    stats: { owners: owners.size, conversations: conversations.size, messages: messages.length, childMessages: messages.filter(child).length },
    owners: [...owners.values()],
    veniceBackup: { manifest, databaseChunks: Array.from({ length: count }, (_, index) => chunks.get(index)), mediaArchivePaths: [...media].sort(), mediaBytesEmbedded: false, note: 'Raw database chunks retain Dexie types and non-chat tables. Media bytes remain in the source ZIP. This JSON is not a Venice restore backup.' },
  };
}

export function epochMs(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    value = value.trim();
    if (!value) return null;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) value = Number(value);
    else {
      // Python treats ISO strings without timezone information as UTC.
      if (!/^\d{4}-\d\d-\d\d(?:[T ]|$)/.test(value)) return null;
      if (!/Z$|[+-]\d\d(?::?\d\d)?$/i.test(value) && value.length > 10) value += 'Z';
      const date = Date.parse(value);
      return Number.isFinite(date) ? date : null;
    }
  }
  if (!['number', 'bigint'].includes(typeof value)) return null;
  value = Number(value);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value < 10000000000 ? value * 1000 : value);
}
const mongoDate = value => { const ms = epochMs(value); return ms == null ? null : { $date: { $numberLong: BigInt(ms).toString() } }; };
const previewTimestamp = value => { const ms = epochMs(value); return ms == null || Math.abs(ms) > 8640000000000000 ? undefined : new Date(ms).toISOString(); };
function tracesFor(message) {
  let value = message.reasoningContent;
  if (value == null) for (const key of ['thinkingContent', 'reasoning_content']) if (Object.hasOwn(message, key)) { value = message[key]; break; }
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item === 'string') return item.trim() ? [item.trim()] : [];
    if (object(item)) for (const key of ['thinking_trace', 'content', 'text']) if (nonempty(item[key])) return [nonempty(item[key])];
    return [];
  });
}
function labelFor(message, conversation, mode) {
  const name = nonempty(message.modelName), id = nonempty(message.modelId) || nonempty(conversation.modelId);
  return mode === 'id' ? id || name : mode === 'name-id' && name && id && name !== id ? `${name} [${id}]` : name || id;
}

/** Native equivalent of veniceai_to_threadshelf_grok.convert_export. */
export function convertExport(data, { modelLabel = 'name', primaryOnly = false, embedOriginal = false, force = false } = {}) {
  validateExport(data, { force, allowEmpty: true });
  if (!['name', 'id', 'name-id'].includes(modelLabel)) throw new Error('Model label must be name, id, or name-id.');
  const conversations = [], unmapped = [], seen = new Map();
  const stats = { source_conversations: 0, source_messages: 0, source_child_messages: 0, output_conversations: 0, output_responses: 0, thinking_traces: 0, coerced_content: 0, unknown_roles: 0, skipped_child_messages: 0, duplicate_conversation_ids: 0 };
  for (const owner of data.owners) for (const conversation of owner.conversations) {
    const index = stats.source_conversations++, ownerId = nonempty(owner.ownerId) || '';
    const base = nonempty(conversation.id) || `venice-conversation-${index + 1}`;
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    const id = occurrence === 1 ? base : `${base}__${ownerId || 'owner'}__${occurrence}`;
    if (occurrence > 1) stats.duplicate_conversation_ids++;
    stats.source_messages += conversation.messages.length;
    const seenMessages = new Map(), responses = [];
    for (const [messageIndex, message] of conversation.messages.entries()) {
      const messageBase = nonempty(message.id) || `${id}-message-${messageIndex + 1}`;
      const count = (seenMessages.get(messageBase) || 0) + 1;
      seenMessages.set(messageBase, count);
      const messageId = count === 1 ? messageBase : `${messageBase}__${count}`;
      let reason;
      if (child(message)) { stats.source_child_messages++; if (primaryOnly) { stats.skipped_child_messages++; reason = 'child-variant-hidden-by-primary-only'; } }
      const role = (nonempty(message.role) || '').toLowerCase();
      if (!reason && !['user', 'assistant'].includes(role)) { stats.unknown_roles++; reason = 'unsupported-role'; }
      if (reason) { unmapped.push({ reason, venice_owner_id: ownerId || null, venice_conversation_id: get(conversation, 'id'), message_index: messageIndex, message }); continue; }
      const coerced = message.content != null && typeof message.content !== 'string';
      const response = { _id: messageId, conversation_id: id, sender: role === 'user' ? 'human' : 'ASSISTANT', message: stringifyContent(message.content), parent_response_id: get(message, 'parentMessageId') };
      const created = mongoDate(message.createdAtUnixTimestamp), updated = mongoDate(message.updatedAtUnixTimestamp);
      if (created) response.create_time = created;
      if (updated) response.update_time = updated;
      const model = labelFor(message, conversation, modelLabel);
      if (model) response.model = model;
      const traces = role === 'assistant' ? tracesFor(message) : [];
      if (traces.length) response.agent_thinking_traces = traces.map((trace, i) => ({ agent_id: { rollout_id: String(i) }, thinking_trace: trace }));
      response.venice_metadata = without(message, 'content');
      if (coerced) response.venice_original_content = message.content;
      responses.push({ response, share_link: null });
      stats.output_responses++;
      stats.thinking_traces += traces.length;
      stats.coerced_content += Number(coerced);
    }
    if (!responses.length) continue;
    const meta = { id, conversation_id: id, title: nonempty(conversation.name) || `Conversation ${index + 1}`, leaf_response_id: responses.at(-1).response._id, starred: false, venice_owner_id: ownerId || null, venice_metadata: without(conversation, 'messages') };
    const created = mongoDate(conversation.createdAtUnixTimestamp), updated = mongoDate(conversation.updatedAtUnixTimestamp);
    if (created) meta.create_time = created;
    if (updated) meta.update_time = updated;
    if (nonempty(conversation.modelId)) meta.model = nonempty(conversation.modelId);
    conversations.push({ conversation: meta, responses });
  }
  stats.output_conversations = conversations.length;
  const output = {
    conversations, projects: [], tasks: [], media_posts: [],
    venice_conversion: { format: 'venice-to-threadshelf-grok', formatVersion: 1, converterVersion: '1.1.0', convertedAt: utcNow(), threadShelfCompatibility: 'Grok/xAI account-export parser', modelLabelMode: modelLabel, primaryOnly, sourceFormat: get(data, 'format'), sourceFormatVersion: get(data, 'formatVersion'), note: 'Venice-specific metadata is retained in venice_* fields. ThreadShelf ignores those fields and consumes the Grok-compatible fields.', stats },
    venice_export_metadata: without(data, 'owners'), venice_owner_metadata: data.owners.map(owner => without(owner, 'conversations')),
  };
  if (unmapped.length) output.venice_unmapped_messages = unmapped;
  if (embedOriginal) output.venice_original_export = data;
  return { output, stats };
}

export async function importFiles(paths, options = {}) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Select a Venice JSON export or complete ZIP backup parts.');
  const sourcePaths = paths.map(name => path.resolve(name));
  const handle = await fs.open(sourcePaths[0], 'r');
  let header, firstSize;
  try { firstSize = (await handle.stat()).size; header = Buffer.alloc(4); await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
  const isZip = options.sourceFormat === 'zip' || options.sourceFormat !== 'json' && (path.extname(paths[0]).toLowerCase() === '.zip' || header.readUInt32LE(0) === 0x04034b50 || header.readUInt32LE(0) === 0x06054b50);
  let rawData, sourceBytes = null;
  if (isZip) rawData = await loadBackup(sourcePaths, options);
  else {
    if (paths.length !== 1) throw new Error('Additional backup parts require a ZIP input.');
    if (firstSize > LIMITS.jsonBytes) throw new Error('JSON export exceeds the 512 MiB safety limit.');
    sourceBytes = await fs.readFile(sourcePaths[0]);
    rawData = parseJSON(new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes));
  }
  const convs = validateExport(rawData, options), seen = new Set();
  const conversations = convs.map(conversation => {
    const id = conversation.id ? String(conversation.id) : '';
    if (!id || seen.has(id)) throw new Error('Missing or duplicate conversation ID; refusing ambiguous title-cache mapping.');
    seen.add(id);
    const createdAtMs = creationTimeMs(conversation.createdAtUnixTimestamp);
    return { id, createdAtMs, originalTitle: string(conversation.name || ''), isManual: conversation.hasDefaultName === false, excerpt: excerptFor(conversation), messages: conversation.messages.map(message => ({ role: string(message.role), content: stringifyContent(message.content), timestamp: previewTimestamp(message.createdAtUnixTimestamp) })) };
  });
  const actual = { conversations: convs.length, messages: convs.reduce((sum, conv) => sum + conv.messages.length, 0), childMessages: convs.reduce((sum, conv) => sum + conv.messages.filter(child).length, 0) };
  const warnings = [];
  for (const [key, counted] of Object.entries(actual)) if (typeof rawData.stats?.[key] === 'number' && rawData.stats[key] !== counted) warnings.push(`Source stats.${key} says ${rawData.stats[key]}, but counted ${counted}.`);
  if (isZip && rawData.veniceBackup.mediaArchivePaths.length) warnings.push('Media bytes remain in the source ZIP; their paths and all database chunks are retained in the output.');
  return { provider: 'venice', sourceName: path.basename(sourcePaths[0]), sourcePaths, conversations, report: { ...actual, warnings, sourceType: isZip ? 'backup' : 'json', backupParts: isZip ? paths.length : 0 }, rawData, sourceBytes };
}

export async function exportFile(job, titles = {}, options = {}) {
  const data = structuredClone(job.rawData);
  let changedTitles = 0;
  for (const owner of data.owners) for (const conversation of owner.conversations) {
    const id = String(conversation.id || '');
    const title = Object.hasOwn(titles, id) ? string(titles[id]).trim() : '';
    if (title && title !== string(conversation.name || '')) { conversation.name = title; conversation.hasDefaultName = false; changedTitles++; }
  }
  data.localTitleGenerator = { version: '6.0.0', qualityVersion: 2, generatedAt: utcNow(), changedTitles, note: 'Conversation names were locally generated. Original source export was not modified.' };
  const cleanedReasoning = options.cleanReasoning === false ? 0 : cleanReasoning(data);
  const grok = options.grokify !== false;
  const converted = grok ? convertExport(data, options) : { output: data, stats: {} };
  const stem = path.basename(job.sourceName, path.extname(job.sourceName));
  return { buffer: Buffer.from(stringifyJSON(converted.output, options.compact ? 0 : 2) + '\n'), filename: stem + (grok ? '-retitled-threadshelf-grok.json' : '-retitled.json'), report: { ...converted.stats, changedTitles, cleanedReasoning, warnings: job.report?.warnings || [] } };
}
