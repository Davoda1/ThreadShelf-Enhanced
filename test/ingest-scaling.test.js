import { closeStoragePublication } from '../src/storage-publication.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-ingest-scaling-'));
process.env.LANCEDB_PATH = join(root, 'db');
process.env.COLLECTIONS_PATH = join(root, 'collections.json');
process.env.UPLOADS_DIR = join(root, 'uploads');
const { ingestFolder } = await import('../src/ingest.js');
const { getStoredThreads } = await import('../src/store.js');
after(async () => {
  closeStoragePublication();
  await rm(root, { recursive: true, force: true });
});
const record = (key, text) => ({ provider: 'threadshelf', key, title: 'Synthetic import', turns: [{ user: text }] });

test('clear imports valid sources alongside unsupported, metadata and empty files', { timeout: 120000 }, async () => {
  const folder = join(root, 'mixed');
  await mkdir(folder);
  const valid = join(folder, 'valid.json');
  await writeFile(valid, JSON.stringify([record('one', 'A fully indexed valid conversation')]));
  await writeFile(join(folder, 'settings.json'), JSON.stringify({ unrelated: true }));
  await writeFile(join(folder, 'README'), 'These are unrelated notes.');
  await writeFile(join(folder, 'checksum.sha256'), 'Synthetic checksum sidecar.');
  await writeFile(join(folder, 'empty.json'), JSON.stringify({ platform: 'openrouter', turns: [] }));
  const result = await ingestFolder('mixed_sources', folder, { clearFirst: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.replacementSkipped, undefined);
  assert.equal(result.conversations, 1);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.completedSourceFiles, [valid]);
  assert.equal(result.skippedFiles.length, 4);
  assert.equal(JSON.parse((await getStoredThreads('mixed_sources', valid))[0].turnsJson)[0].user, 'A fully indexed valid conversation');

  await rm(valid);
  const empty = await ingestFolder('mixed_sources', folder, { clearFirst: true });
  assert.equal(empty.replacementSkipped, true);
  assert.equal(empty.conversations, 0);
  assert.equal((await getStoredThreads('mixed_sources', valid)).length, 1);
});

test('a malformed recognized source prevents clear publication after other files were staged', { timeout: 120000 }, async () => {
  const folder = join(root, 'invalid');
  await mkdir(folder);
  const source = join(folder, 'valid.json');
  await writeFile(source, JSON.stringify([record('stable', 'Previously committed text')]));
  assert.deepEqual((await ingestFolder('invalid_sources', folder, { clearFirst: true })).errors, []);
  await writeFile(source, JSON.stringify([record('stable', 'This replacement must not appear')]));
  await writeFile(join(folder, 'broken.json'), '[{"mapping":');
  const result = await ingestFolder('invalid_sources', folder, { clearFirst: true });
  assert.equal(result.replacementSkipped, true);
  assert.deepEqual(result.completedSourceFiles, []);
  assert.ok(result.errors.length);
  assert.equal(JSON.parse((await getStoredThreads('invalid_sources', source))[0].turnsJson)[0].user, 'Previously committed text');
});

test('valid mixed ZIP input is published with its stable source and conversation identity', { timeout: 120000 }, async () => {
  const folder = join(root, 'snapshot');
  await mkdir(folder);
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('settings.json', new TextReader('{"notAConversation":true}'));
  await writer.add('conversations.json', new TextReader(JSON.stringify([record('stable', 'A snapshot keeps original identities')])));
  await writeFile(join(folder, 'export.zip'), await writer.close());
  const originalRoot = join(root, 'original-uploads');
  const original = join(originalRoot, 'export.zip');
  const result = await ingestFolder('zip_sources', folder, { clearFirst: true, sourceRoot: originalRoot });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.files, [original]);
  assert.deepEqual(result.completedSourceFiles, [original]);
  const stored = (await getStoredThreads('zip_sources', original))[0];
  assert.equal(stored.conversationKey, 'conversations.json::stable');
  assert.equal(JSON.parse(stored.sourceIdentityJson).sourceFile, original + '!conversations.json');
});

test('a retry reuses only verified completed parse checkpoints', { timeout: 120000 }, async () => {
  const folder = join(root, 'checkpoint-input');
  const stagingDirectory = join(root, 'checkpoint-stage');
  await mkdir(folder);
  await writeFile(join(folder, 'valid.json'), JSON.stringify([record('retry', 'Checkpointed source conversation')]));
  const interrupted = await ingestFolder('checkpoint_source', folder, {
    clearFirst: true, stagingDirectory,
    onProgress: (event) => { if (event.phase === 'embedding') throw new Error('Synthetic interruption before publication'); },
  });
  assert.ok(interrupted.errors.length);
  assert.ok((await readdir(join(stagingDirectory, 'normalized'))).some((name) => name.endsWith('.complete.json')));
  const phases = [];
  const retried = await ingestFolder('checkpoint_source', folder, {
    clearFirst: true, stagingDirectory, onProgress: (event) => phases.push(event.phase),
  });
  assert.deepEqual(retried.errors, []);
  assert.ok(phases.includes('checkpoint'));
  assert.equal(retried.conversations, 1);
  await assert.rejects(readdir(join(stagingDirectory, 'normalized')), { code: 'ENOENT' });
});
