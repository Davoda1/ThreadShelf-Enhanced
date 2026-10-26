import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { importEnhancedFile, iterateEnhancedFile, isClearlyUnsupportedExportPrefix } from '../src/enhanced-import/index.js';
import {
  createImportStage, createSpoolWriter, inputFingerprint,
  readCheckpoint, readImportSpool, spoolPath,
} from '../src/enhanced-import/spool.js';

const temporary = async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'threadshelf-streaming-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
const conversation = (key = 'synthetic') => ({
  key, provider: 'threadshelf', title: 'Synthetic streamed conversation',
  turns: [{ user: 'Question with **formatting**' }, { ai: 'Synthetic answer 日本語' }],
});
const zipFile = async (directory, entries) => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, value] of entries)
    await writer.add(name, new TextReader(typeof value === 'string' ? value : JSON.stringify(value)), { level: 0 });
  const path = join(directory, 'mixed.zip');
  await writeFile(path, await writer.close());
  return path;
};

test('mixed ZIP keeps valid conversations and reports unsupported members without fatal diagnostics', async (t) => {
  const root = await temporary(t);
  const file = await zipFile(root, [
    ['settings.json', { unrelated: true }],
    ['README', 'This is an unrelated readme.'],
    ['notes.txt', 'Unrelated notes'],
    ['conversations.json', [conversation()]],
  ]);
  const result = await importEnhancedFile(file);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].key, 'conversations.json::synthetic');
  assert.equal(result.warnings.filter((entry) => entry.code === 'unsupported').length, 3);
});

test('a malformed recognized export in a mixed archive still invalidates the whole file', async (t) => {
  const root = await temporary(t);
  const file = await zipFile(root, [
    ['valid.json', [conversation()]],
    ['conversations.json', '[{"mapping":'],
  ]);
  const events = [];
  for await (const event of iterateEnhancedFile(file)) events.push(event);
  assert.ok(events.some((event) => event.type === 'conversation'));
  assert.ok(events.some((event) => event.type === 'error' && event.notice.code === 'invalid'));
  const collected = await importEnhancedFile(file);
  assert.equal(collected.conversations.length, 0);
  assert.ok(collected.diagnostics.length);
});

test('unsupported structured JSON and extensionless notes are skipped, recognized format errors are fatal', async (t) => {
  const root = await temporary(t);
  for (const [name, value] of [
    ['unrelated.json', JSON.stringify({ applicationSettings: { theme: 'dark' } })],
    ['README', 'Plain project notes'],
    ['plain.json', 'Plain project notes with a misleading suffix'],
    ['metadata.txt', '{}'],
    ['plain.html', '<html><body>Documentation only</body></html>'],
  ]) {
    const file = join(root, name);
    await writeFile(file, value);
    const result = await importEnhancedFile(file);
    assert.equal(result.conversations.length, 0);
    assert.deepEqual(result.diagnostics, [], name);
    assert.equal(result.warnings[0].code, 'unsupported', name);
  }
  const invalid = join(root, 'venice.json');
  await writeFile(invalid, JSON.stringify({ format: 'venice-chat-history', formatVersion: 99, owners: [] }));
  const result = await importEnhancedFile(invalid);
  assert.equal(result.conversations.length, 0);
  assert.match(result.diagnostics.join('\n'), /Unsupported Venice/);
});

test('unrelated huge inputs skip before whole-document limits while inconclusive prefixes remain candidates', async (t) => {
  const root = await temporary(t);
  for (const name of ['README', 'notes.json']) {
    const file = join(root, name);
    const handle = await open(file, 'w');
    await handle.write('These are unrelated project notes.\n');
    await handle.truncate(1024 ** 3);
    await handle.close();
    const result = await importEnhancedFile(file);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.warnings[0].code, 'unsupported');
  }
  for (const bytes of [Buffer.from(' '.repeat(8192)), Buffer.from('\uFEFF[{'), Buffer.from('PK\x03\x04'), Buffer.from([0xff, 0xfe, 0x5b, 0])])
    assert.equal(isClearlyUnsupportedExportPrefix(bytes, 'export'), false);
  const whitespace = join(root, 'whitespace');
  await writeFile(whitespace, ' '.repeat(16384) + JSON.stringify([conversation('after-whitespace')]));
  const result = await importEnhancedFile(whitespace, { limits: { streamingThreshold: 1 } });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.conversations[0].key, 'after-whitespace');
});

test('immutable snapshot paths map to stable archived source identities', async (t) => {
  const root = await temporary(t);
  const snapshot = await zipFile(root, [['conversations.json', [conversation('stable')]]]);
  const original = join(root, 'original', 'export.zip');
  const result = await importEnhancedFile(snapshot, { sourcePathMap: { [snapshot]: original } });
  const imported = result.conversations[0];
  assert.equal(imported.sourceFile, original + '!conversations.json');
  assert.equal(imported.sourceIdentity.sourceFile, original + '!conversations.json');
  assert.equal(imported.key, 'conversations.json::stable');
});

test('iterator cancellation closes readers and preserves source bytes', async (t) => {
  const root = await temporary(t);
  const file = join(root, 'conversations.json');
  const bytes = JSON.stringify(Array.from({ length: 100 }, (_, index) => conversation(String(index))));
  await writeFile(file, bytes);
  const controller = new AbortController();
  let checkpoints = 0;
  const iterator = iterateEnhancedFile(file, {
    signal: controller.signal,
    limits: { streamingThreshold: 1 },
    checkpoint: async () => { checkpoints++; },
  });
  const first = await iterator.next();
  assert.equal(first.value.type, 'conversation');
  controller.abort(new DOMException('Synthetic cancellation', 'AbortError'));
  await assert.rejects(iterator.next(), { name: 'AbortError' });
  assert.ok(checkpoints > 0);
  assert.equal(await readFile(file, 'utf8'), bytes);
  await rm(file);
  assert.deepEqual(await readdir(root), []);
});

test('bounded spool checkpoints reject corruption and replay exact normalized data', async (t) => {
  const root = await temporary(t);
  const source = join(root, 'source.json');
  await writeFile(source, JSON.stringify([conversation('one'), conversation('two')]));
  const stage = await createImportStage(join(root, 'job-stage'));
  const path = spoolPath(stage.directory, source);
  const writer = await createSpoolWriter(path);
  const parsed = await importEnhancedFile(source);
  const expected = parsed.conversations.map((entry) => ({ sourceFile: source, provider: entry.provider, conversation: entry }));
  for (const record of expected) await writer.append(record);
  const inputHash = await inputFingerprint([source], {});
  const saved = await writer.finish({ inputHash, sourceFile: source, count: 2, providers: ['threadshelf'], warnings: [] });
  await writer.discard();
  assert.deepEqual(await readCheckpoint(path, source, inputHash), saved);
  const actual = [];
  for await (const record of readImportSpool(path)) actual.push(record);
  assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)));
  await stage.dispose(false);
  assert.ok((await readdir(stage.directory)).includes(path.split(/[\\/]/).at(-1)));
  const content = await readFile(path);
  content[content.length - 1] ^= 1;
  await writeFile(path, content);
  assert.equal(await readCheckpoint(path, source, inputHash), undefined);
  await assert.rejects(async () => { for await (const _record of readImportSpool(path)) { /* read to corruption */ } });
  await stage.dispose(true);
});

test('interrupted spool is never a reusable completed checkpoint', async (t) => {
  const root = await temporary(t);
  const directory = join(root, 'normalized');
  await mkdir(directory);
  const path = spoolPath(directory, 'synthetic');
  const writer = await createSpoolWriter(path);
  await writer.append({ sourceFile: 'synthetic', provider: 'threadshelf', conversation: { ...conversation(), sourceFile: 'synthetic', raw: {} } });
  await writer.discard();
  assert.equal(await readCheckpoint(path, 'synthetic', ''), undefined);
  assert.deepEqual(await readdir(directory), []);
});

test('individual normalized records have a fixed safety ceiling independent of collection size', async (t) => {
  const root = await temporary(t);
  const source = join(root, 'conversations.json');
  await writeFile(source, JSON.stringify([conversation()]));
  const result = await importEnhancedFile(source, { limits: { streamingThreshold: 1, recordBytes: 32 } });
  assert.equal(result.conversations.length, 0);
  assert.match(result.diagnostics.join('\n'), /per-record safety limit/);
});


test('small and streamed conversation wrappers retain valid records around unrelated metadata', async (t) => {
  const root = await temporary(t);
  const source = join(root, 'wrapped.json');
  await writeFile(source, JSON.stringify({ conversations: [conversation('kept'), { unrelated: 'metadata' }] }));
  for (const streamingThreshold of [1024 * 1024, 1]) {
    const result = await importEnhancedFile(source, { limits: { streamingThreshold } });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.conversations.length, 1);
    assert.equal(result.conversations[0].key, 'kept');
    assert.ok(result.warnings.length);
  }
});
