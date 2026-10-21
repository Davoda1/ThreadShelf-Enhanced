/** Native Meta Accounts Center converter. Source bytes remain authoritative. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJSON, stringifyJSON, pythonJSON, sha256, utcNow, creationTimeMs } from './common.mjs';

const FORMAT_VERSION = '5.0.0';
const COMPAT_COMMIT = '7a677115c5170366bd0537601a80722845f948e7';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strip = text => text.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
const take = (text, count) => Array.from(text).slice(0, count).join('');
const asciiJSON = value => pythonJSON(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/** Match Python json.loads(bytes), including UTF-16/32 exports and BOMs. */
export function decodeJSONBytes(bytes) {
  const raw = Buffer.from(bytes);
  let encoding = 'utf-8', offset = 0;
  if (raw.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0]))) { encoding = 'utf-32le'; offset = 4; }
  else if (raw.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))) { encoding = 'utf-32be'; offset = 4; }
  else if (raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) offset = 3;
  else if (raw.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) { encoding = 'utf-16le'; offset = 2; }
  else if (raw.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) { encoding = 'utf-16be'; offset = 2; }
  else if (raw.length >= 4 && raw[0] === 0 && raw[1] === 0 && raw[2] === 0) encoding = 'utf-32be';
  else if (raw.length >= 4 && raw[1] === 0 && raw[2] === 0 && raw[3] === 0) encoding = 'utf-32le';
  else if (raw.length >= 2 && raw[0] === 0) encoding = 'utf-16be';
  else if (raw.length >= 2 && raw[1] === 0) encoding = 'utf-16le';
  if (encoding.startsWith('utf-32')) {
    if ((raw.length - offset) % 4) throw new Error('Invalid UTF-32 JSON byte length.');
    const parts = [], chunk = [];
    for (let i = offset; i < raw.length; i += 4) {
      const cp = encoding === 'utf-32le' ? raw.readUInt32LE(i) : raw.readUInt32BE(i);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error('Invalid UTF-32 JSON character.');
      chunk.push(cp);
      if (chunk.length === 4096) { parts.push(String.fromCodePoint(...chunk)); chunk.length = 0; }
    }
    parts.push(String.fromCodePoint(...chunk));
    return parseJSON(parts.join(''));
  }
  return parseJSON(new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(raw.subarray(offset)));
}

export function* findTranscripts(value, pointer = '') {
  if (object(value)) {
    if (typeof value.label === 'string' && value.label.toLowerCase().endsWith('.txt')) {
      if (typeof value.value !== 'string') throw new Error('Transcript has no string value at ' + pointer);
      yield { pointer, label: value.label, original: value.value };
    }
    for (const [key, child] of Object.entries(value)) {
      yield* findTranscripts(child, pointer + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'));
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* findTranscripts(value[i], pointer + '/' + i);
  }
}

export function splitTranscript(text) {
  const messages = [], preamble = [];
  let current = null, fenceChar = null, fenceLength = 0;
  // Python splitlines(keepends=True) recognizes more than CR/LF.
  const lines = text.match(/[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]|$)/g) || [];
  for (const line of lines) {
    if (!line) continue;
    const speaker = fenceChar === null ? /^(You|Meta AI):[ \t]?/.exec(line) : null;
    let body = line;
    if (speaker) {
      current = { sender: speaker[1] === 'You' ? 'human' : 'assistant', text: '' };
      messages.push(current);
      body = line.slice(speaker[0].length);
    }
    if (current === null) preamble.push(line);
    else current.text += body;
    const marker = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(body);
    if (marker) {
      const [, run, suffix] = marker;
      if (fenceChar === null) { fenceChar = run[0]; fenceLength = run.length; }
      else if (run[0] === fenceChar && run.length >= fenceLength && !strip(suffix)) { fenceChar = null; fenceLength = 0; }
    }
  }
  return { preamble: preamble.join(''), messages };
}

export function repairText(text) {
  if (Array.from(text).some(c => c.codePointAt(0) > 255)) return text;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(text, 'latin1')); }
  catch { return text; }
}

function fenced(text) {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return fence + '\n' + text + '\n' + fence;
}

export function conversationDate(label) {
  const match = /_(\d{2})-(\d{2})-(\d{4})(?:_(\d+))?\.txt$/i.exec(label);
  if (!match) return {};
  const [, monthText, dayText, yearText, epoch] = match;
  const month = Number(monthText), day = Number(dayText), year = Number(yearText);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return {};
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return {};
  const calendar = `${yearText}-${monthText}-${dayText}`;
  const info = { calendar_date: calendar, created_at: calendar, precision: 'day', source: 'transcript_label' };
  if (epoch && [10, 13].includes(epoch.length)) {
    info.epoch_in_label = epoch;
    const timestamp = new Date(Number(epoch) * (epoch.length === 13 ? 1 : 1000));
    if (!Number.isNaN(timestamp.valueOf())) {
      const iso = timestamp.toISOString();
      if (iso.slice(0, 10) === calendar) {
        info.created_at = epoch.length === 13 ? iso : iso.replace('.000Z', 'Z');
        info.precision = epoch.length === 13 ? 'milliseconds' : 'seconds';
      } else info.note = 'Epoch UTC date differs; explicit calendar date retained.';
    }
  }
  return info;
}

/** Exported for compatibility tests; production callers use importFiles/exportFile. */
export function convert(raw, filename, repair = false, titles = {}) {
  const source = Buffer.from(raw), data = decodeJSONBytes(source);
  if (!object(data) || !Array.isArray(data.label_values)) throw new Error('Expected a Meta AI export object with a label_values array.');
  const records = [...findTranscripts(data)], occurrences = new Map();
  if (!records.length) throw new Error('No labeled .txt transcript records were found; no output written.');
  const conversations = [], transcripts = [];
  for (const { pointer, label, original } of records) {
    const shown = repair ? repairText(original) : original;
    const { preamble, messages } = splitTranscript(shown);
    const identity = sha256(asciiJSON([data.fbid ?? null, original]));
    const occurrence = (occurrences.get(identity) || 0) + 1;
    occurrences.set(identity, occurrence);
    const uid = `meta-ai:${identity}:${occurrence}`;
    let readable = messages.map((message, i) => ({ ...message, uuid: `${uid}-${i + 1}`, model: message.sender === 'assistant' ? 'Meta AI' : null }));
    const fallback = !readable.some(m => strip(m.text));
    if (fallback) readable = [{ sender: 'human', text: '[Original Meta AI transcript]\n' + fenced(shown) }];
    const dateInfo = conversationDate(label);
    const conversation = {
      uuid: uid, name: titles[uid] || 'Meta AI — ' + label, chat_messages: readable,
      meta_ai_source: { json_pointer: pointer, label, preamble, original_transcript: original, date_from_label: dateInfo },
    };
    if (Object.keys(dateInfo).length) conversation.created_at = dateInfo.created_at;
    conversations.push(conversation);
    transcripts.push({ json_pointer: pointer, label, inferred_messages: messages.length, fallback, display_repaired: shown !== original,
      empty_messages: messages.filter(m => !strip(m.text)).length });
  }
  return {
    conversations,
    _meta_ai_archive: {
      format: 'meta-ai-to-threadshelf', version: FORMAT_VERSION, source_filename: filename,
      source_sha256: sha256(source), source_size_bytes: source.length, source_base64: source.toString('base64'),
      threadshelf_parser_commit: COMPAT_COMMIT,
      boundary_method: 'Unindented You:/Meta AI: lines outside Markdown fences',
      repair_text_requested: repair, transcripts,
    },
  };
}

export function restoreDocument(document) {
  const archive = document?._meta_ai_archive;
  if (!object(archive) || archive.format !== 'meta-ai-to-threadshelf') throw new Error('No supported lossless source archive found.');
  const encoded = archive.source_base64;
  if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Embedded source has invalid base64 encoding.');
  }
  const raw = Buffer.from(encoded, 'base64');
  if (sha256(raw) !== archive.source_sha256 || BigInt(raw.length) !== BigInt(archive.source_size_bytes ?? -1)) {
    throw new Error('Embedded source failed its SHA-256/size integrity check.');
  }
  return raw;
}

function excerptFor(messages) {
  const selected = [];
  let users = 0, assistants = 0;
  for (const message of messages) {
    if (message.role === 'user' && users < 2) selected.push('User: ' + take(message.content, users++ === 0 ? 2200 : 900));
    else if (message.role === 'assistant' && assistants < 1) { selected.push('Assistant: ' + take(message.content, 1300)); assistants++; }
    if (users >= 2 && assistants >= 1) break;
  }
  if (!selected.length && messages.length) selected.push(take(messages[0].content, 2400));
  return take(selected.join('\n\n'), 5000);
}

function prepareExport(raw, filename, repair) {
  const data = decodeJSONBytes(raw);
  if (!object(data)) throw new Error('Expected a Meta AI JSON object.');
  const previous = object(data.localTitleGenerator?.metaTitles) ? data.localTitleGenerator.metaTitles : {};
  if (Object.hasOwn(data, '_meta_ai_archive')) {
    raw = restoreDocument(data);
    filename = data._meta_ai_archive.source_filename ?? filename;
  }
  const converted = convert(raw, filename, repair, previous);
  const conversations = converted.conversations.map(conv => {
    const messages = conv.chat_messages.map(msg => ({ role: msg.sender === 'human' ? 'user' : 'assistant', content: msg.text, parentMessageId: null }));
    return { id: conv.uuid, createdAtMs: creationTimeMs(conv.created_at), originalTitle: conv.name, isManual: Object.hasOwn(previous, conv.uuid), messages,
      excerpt: excerptFor(messages), ...(conv.created_at ? { timestamp: conv.created_at } : {}) };
  });
  return { raw: Buffer.from(raw), converted, conversations };
}

export async function importFiles(paths, options = {}) {
  if (!Array.isArray(paths) || paths.length !== 1) throw new Error('Select exactly one Meta AI export JSON file.');
  const raw = await readFile(paths[0]), filename = path.basename(paths[0]);
  const prepared = prepareExport(raw, filename, Boolean(options.repairText));
  const transcripts = prepared.converted._meta_ai_archive.transcripts;
  return {
    provider: 'meta', sourceName: filename, sourcePaths: [...paths], conversations: prepared.conversations,
    report: {
      transcripts, transcriptCount: transcripts.length,
      inferredMessages: transcripts.reduce((sum, t) => sum + t.inferred_messages, 0),
      fallbackTranscripts: transcripts.filter(t => t.fallback).length,
      repairedTranscripts: transcripts.filter(t => t.display_repaired).length,
      emptyMessages: transcripts.reduce((sum, t) => sum + t.empty_messages, 0),
      originalBytes: prepared.raw.length, roundTripVerified: restoreDocument(prepared.converted).equals(prepared.raw),
      note: 'Speaker boundaries are inferred. Exact original bytes are preserved; referenced media files are not embedded by the source JSON.',
    },
    _inputRaw: raw, _originalRaw: prepared.raw, _converted: prepared.converted, _repairText: Boolean(options.repairText),
  };
}

export async function exportFile(job, titles = {}, options = {}) {
  if (job?.provider !== 'meta' || !Buffer.isBuffer(job._inputRaw)) throw new Error('No Meta AI export has been imported.');
  if (!object(titles) || Object.values(titles).some(v => typeof v !== 'string')) throw new Error('Titles must be a mapping of conversation IDs to strings.');
  const repair = options.repairText === undefined ? job._repairText : Boolean(options.repairText);
  const prepared = prepareExport(job._inputRaw, job.sourceName, repair);
  const chosen = Object.fromEntries(prepared.conversations.map(row => [row.id, strip(Object.hasOwn(titles, row.id) ? titles[row.id] : row.originalTitle) || row.originalTitle]));
  const converted = convert(prepared.raw, prepared.converted._meta_ai_archive.source_filename, repair, chosen);
  const anthropication = options.anthropication !== false;
  const result = anthropication ? converted : decodeJSONBytes(prepared.raw);
  if (!anthropication) result._meta_ai_archive = converted._meta_ai_archive;
  result.localTitleGenerator = {
    version: FORMAT_VERSION, qualityVersion: 2, provider: 'meta', generatedAt: utcNow(),
    changedTitles: prepared.conversations.filter(r => chosen[r.id] !== r.originalTitle).length,
    metaTitles: chosen, note: 'Meta transcript labels and source bytes are preserved. Titles are separate metadata.',
  };
  if (!restoreDocument(result).equals(prepared.raw)) throw new Error('Source round-trip verification failed.');
  const suffix = anthropication ? '-retitled-threadshelf-anthropic.json' : '-retitled.json';
  return {
    buffer: Buffer.from(stringifyJSON(result, options.compact ? 0 : 2) + '\n', 'utf8'),
    filename: job.sourceName.replace(/\.[^.]+$/, '') + suffix,
    report: { ...job.report, changedTitles: result.localTitleGenerator.changedTitles, anthropication, repairText: repair },
  };
}

export function restoreOriginal(job) {
  if (job?.provider !== 'meta' || !job._converted) throw new Error('No Meta AI export has been imported.');
  return restoreDocument(job._converted);
}
