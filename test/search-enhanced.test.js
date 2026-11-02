import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '@lancedb/lancedb';
import { DatabaseSync } from 'node:sqlite';
import { fuseSearchResults, lexicalScore, TopResults } from '../src/search-ranking.js';
import { normalizeEnhancedSearchMode, normalizeSearchMode } from '../src/validation.js';

const temp = await mkdtemp(join(tmpdir(), 'threadshelf-hybrid-'));
process.env.LANCEDB_PATH = join(temp, 'lancedb');
process.env.COLLECTIONS_PATH = join(temp, 'collections.json');
const {
  searchCollection,
  keywordSearchCollection,
  lexicalSearchCollection,
  hybridSearchCollectionCandidates,
} = await import('../src/store.js');
const { closeStoragePublication } = await import('../src/storage-publication.js');
const db = await connect(process.env.LANCEDB_PATH);
let table;
const row = (i, overrides = {}) => ({
  id: `row-${String(i).padStart(5, '0')}`,
  vector: [1, 0, 0],
  document: `Ordinary synthetic baseline archive document ${i}`,
  sourceFile: `source-${i}.json`,
  provider: 'openai',
  conversationKey: `conversation-${i}`,
  title: `Synthetic ${i}`,
  role: 'ai',
  turnIndex: '0',
  model: 'common',
  createdAt: '2026-01-01T12:00:00Z',
  createdInThreadShelf: false,
  generationProvider: '',
  ...overrides,
});
const result = (id, document, extra = {}) => ({
  id,
  document,
  metadata: {
    collection: 'fixture',
    sourceFile: `${id}.json`,
    conversationKey: id,
    role: 'ai',
    turnIndex: '0',
    ...extra,
  },
});
before(async () => {
  const rows = Array.from({ length: 850 }, (_, i) =>
    row(i, { document: `needle synthetic archive ${i}` }),
  );
  rows[820] = row(820, {
    document: 'needle '.repeat(40),
    vector: [0, 1, 0],
    model: '/private/models/rare-model.gguf',
    role: 'user',
    createdInThreadShelf: true,
  });
  rows[821] = row(821, {
    document: 'A full explanation of ERR_CACHE_MISS and recovery',
    vector: [0, 1, 0],
    title: 'Cache diagnostics',
  });
  rows[822] = row(822, {
    document: 'Az árvíztűrő tükörfúrógép működése és javítása.',
    vector: [0, 1, 0],
  });
  rows[823] = row(823, {
    document: 'A note whose body uses a different term.',
    vector: [0, 1, 0],
    title: 'Unique title lookup',
  });
  rows[824] = row(824, {
    document: '\u{1e900}\u{1e923} synthetic Unicode word',
    vector: [0, 1, 0],
  });
  table = await db.createTable('fixture', rows);
});
after(async () => {
  closeStoragePublication();
  await rm(temp, { recursive: true, force: true });
});

describe('complete ordinary search and independent hybrid retrieval', () => {
  it('keeps the Reader two-mode contract while accepting additive enhanced hybrid', () => {
    assert.equal(normalizeEnhancedSearchMode('hybrid'), 'hybrid');
    assert.equal(normalizeEnhancedSearchMode(undefined), 'semantic');
    assert.throws(() => normalizeSearchMode('hybrid'));
  });
  it('finds rare normalized models and roles beyond the old semantic window', async () => {
    const rows = await searchCollection(
      'fixture',
      'needle',
      { n: 5, model: 'rare-model', roles: ['user'], origin: 'threadshelf' },
      [1, 0, 0],
    );
    assert.deepEqual(
      rows.map((r) => r.id),
      ['row-00820'],
    );
    assert.equal(rows[0].metadata.model, 'rare-model');
  });
  it('ranks exact matches across the complete collection, including filtered rows past 200', async () => {
    const rows = await keywordSearchCollection('fixture', 'needle', { n: 1 });
    assert.equal(rows[0].id, 'row-00820');
    const filtered = await keywordSearchCollection('fixture', 'needle', {
      n: 5,
      model: 'rare-model',
    });
    assert.deepEqual(
      filtered.map((r) => r.id),
      ['row-00820'],
    );
  });
  it('lexical identifiers enter hybrid even when outside the semantic candidate list', async () => {
    const lists = await hybridSearchCollectionCandidates(
      'fixture',
      'ERR_CACHE_MISS',
      { n: 200 },
      [1, 0, 0],
    );
    assert.ok(!lists.semantic.some((r) => r.id === 'row-00821'));
    assert.equal(lists.lexical[0].id, 'row-00821');
    const merged = fuseSearchResults(lists.semantic, lists.lexical, 'ERR_CACHE_MISS', 15);
    assert.equal(merged[0].id, 'row-00821');
  });
  it('matches accented Hungarian terms and titles independently from the document body', async () => {
    const hu = await lexicalSearchCollection('fixture', 'arvizturo tukorfurogep', { n: 5 });
    assert.equal(hu[0].id, 'row-00822');
    const title = await lexicalSearchCollection('fixture', 'unique title lookup', { n: 5 });
    assert.equal(title[0].id, 'row-00823');
  });
  it('keeps newer Unicode letters identical between indexed and full-scan retrieval', async () => {
    const query = '\u{1e922}\u{1e923}';
    const indexed = await lexicalSearchCollection('fixture', query, { n: 5 });
    assert.equal(indexed[0].id, 'row-00824');
    process.env.THREADSHELF_LEXICAL_CACHE = '0';
    try {
      const scanned = await lexicalSearchCollection('fixture', query, { n: 5 });
      assert.deepEqual(
        scanned.map((r) => r.id),
        indexed.map((r) => r.id),
      );
    } finally {
      delete process.env.THREADSHELF_LEXICAL_CACHE;
    }
  });
  it('uses the same complete ranking when cache use is disabled', async () => {
    const cached = await lexicalSearchCollection('fixture', 'needle', {
      n: 30,
      model: 'rare-model',
    });
    process.env.THREADSHELF_LEXICAL_CACHE = '0';
    try {
      const scanned = await lexicalSearchCollection('fixture', 'needle', {
        n: 30,
        model: 'rare-model',
      });
      assert.deepEqual(JSON.parse(JSON.stringify(scanned)), JSON.parse(JSON.stringify(cached)));
    } finally {
      delete process.env.THREADSHELF_LEXICAL_CACHE;
    }
  });
  it('rebuilds a damaged sidecar without losing results', async () => {
    const directory = join(process.env.LANCEDB_PATH, '.threadshelf-search');
    const files = (await readdir(directory)).filter((name) =>
      /^[a-f0-9]{24}-[a-f0-9]{64}\.sqlite$/.test(name),
    );
    assert.ok(files.length > 0);
    for (const file of files) await writeFile(join(directory, file), 'damaged disposable cache');
    const rows = await lexicalSearchCollection('fixture', 'ERR_CACHE_MISS', { n: 10 });
    assert.equal(rows[0].id, 'row-00821');
  });
  it('discards partially read cache rows before rebuilding a damaged payload', async () => {
    await lexicalSearchCollection('fixture', 'needle', { n: 50 });
    const directory = join(process.env.LANCEDB_PATH, '.threadshelf-search');
    const files = (await readdir(directory)).filter((name) =>
      /^[a-f0-9]{24}-[a-f0-9]{64}\.sqlite$/.test(name),
    );
    const cache = new DatabaseSync(join(directory, files[0]));
    try {
      cache
        .prepare('UPDATE documents SET payload = ? WHERE id = 1')
        .run(JSON.stringify(result('corrupt-ghost', 'needle '.repeat(200))));
      cache.prepare('UPDATE documents SET payload = ? WHERE id = 2').run('{broken');
    } finally {
      cache.close();
    }
    const rows = await lexicalSearchCollection('fixture', 'needle', { n: 50 });
    assert.ok(!rows.some((r) => r.id === 'corrupt-ghost'));
    assert.equal(rows[0].id, 'row-00820');
  });
  it('invalidates lexical cache on table versions without altering public identities', async () => {
    assert.equal((await lexicalSearchCollection('fixture', 'newversionneedle')).length, 0);
    await table.add([
      row(999, { document: 'newversionneedle newly committed synthetic document' }),
    ]);
    assert.deepEqual(
      (await lexicalSearchCollection('fixture', 'newversionneedle')).map((r) => r.id),
      ['row-00999'],
    );
    await table.delete("id = 'row-00999'");
    assert.equal((await lexicalSearchCollection('fixture', 'newversionneedle')).length, 0);
  });
  it('returns cancellation instead of a partial successful result', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      searchCollection('fixture', 'needle', { signal: controller.signal }, [1, 0, 0]),
      { name: 'AbortError' },
    );
    await assert.rejects(
      lexicalSearchCollection('fixture', 'needle', { signal: controller.signal }),
      { name: 'AbortError' },
    );
  });
  it('spreads hybrid results across conversations without discarding deferred hits', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      result(String(i), `needle different text ${i}`, {
        sourceFile: 'long.json',
        conversationKey: 'long',
      }),
    );
    rows.push(result('other', 'needle separate conversation'));
    const merged = fuseSearchResults(rows, rows, 'needle', 5);
    assert.ok(merged.slice(0, 3).some((r) => r.id === 'other'));
    assert.equal(merged.length, 5);
    assert.equal(new Set(merged.map((r) => r.id)).size, 5);
  });
  it('saturates repetition and keeps bounded top-k equivalent to full sorting', () => {
    const short = result('short', 'needle concise explanation');
    const spam = result('spam', 'needle '.repeat(10000));
    assert.ok(lexicalScore(spam, 'needle') < lexicalScore(short, 'needle') * 2);
    const values = Array.from({ length: 100000 }, (_, i) => ({ i, score: (i * 7919) % 65537 }));
    const compare = (a, b) => b.score - a.score || a.i - b.i;
    const top = new TopResults(50, compare);
    for (const value of values) top.add(value);
    assert.deepEqual(top.values(), [...values].sort(compare).slice(0, 50));
  });
});
