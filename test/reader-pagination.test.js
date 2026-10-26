import { closeStoragePublication } from '../src/storage-publication.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '@lancedb/lancedb';
import express from 'express';

// Only synthetic rows, in isolated storage. No actual chat files or user DBs.
const temp = await mkdtemp(join(tmpdir(), 'threadshelf-reader-pagination-'));
process.env.LANCEDB_PATH = join(temp, 'lancedb');
process.env.COLLECTIONS_PATH = join(temp, 'collections.json');
const { createReaderSearchRouter } = await import('../src/routes/reader-search.js');
const { default: searchRouter } = await import('../src/routes/search.js');
const { requireLocalOrigin } = await import('../src/routes/local-origin.js');
const database = await connect(process.env.LANCEDB_PATH);
let server;
let base;
let embeddingCalls = 0;
const query = 'paginationneedle';
const row = (collection, i) => ({
  id: `${collection}-${String(i).padStart(4, '0')}`,
  vector: [1, 0, 0],
  document: `${query} synthetic document ${i}`,
  sourceFile: `${collection}-fixture.json`,
  provider: i % 2 ? 'anthropic' : 'openai',
  conversationKey: `conversation-${i}`,
  title: `Synthetic title ${i}`,
  role: i % 2 ? 'ai' : 'user',
  turnIndex: '0',
  model: i % 10 ? 'ordinary-model' : 'rare-model',
  createdAt: i % 2 ? '2026-01-05T12:00:00.000Z' : '2026-01-03T12:00:00.000Z',
  createdInThreadShelf: i % 3 === 0,
  generationProvider: '',
});
const identity = (r) => `${r.metadata.collection}/${r.id}`;
const request = async (options = {}, path = '/api/reader/search') => {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries({ q: query, collection: 'all', n: 50, mode: 'keyword', ...options })) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
};
const allPages = async (options = {}) => {
  let cursor;
  let expectedTotal;
  const results = [];
  do {
    const { status, body } = await request({ ...options, cursor });
    assert.equal(status, 200, JSON.stringify(body));
    expectedTotal ??= body.total;
    assert.equal(body.total, expectedTotal);
    assert.ok(body.results.length <= Number(options.n ?? 50));
    assert.equal(body.hasMore, body.nextCursor !== null);
    results.push(...body.results);
    cursor = body.nextCursor;
  } while (cursor);
  assert.equal(results.length, expectedTotal);
  assert.equal(new Set(results.map(identity)).size, expectedTotal, 'pages cannot overlap');
  return results;
};
before(async () => {
  for (const collection of ['alpha', 'beta']) {
    await database.createTable(collection, Array.from({ length: 260 }, (_, i) => row(collection, i)));
  }
  const app = express();
  app.use('/api', requireLocalOrigin);
  app.use(createReaderSearchRouter(async () => { embeddingCalls++; return [1, 0, 0]; }));
  app.use(searchRouter);
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeStoragePublication();
  await rm(temp, { recursive: true, force: true });
});

describe('Reader v1 cursor extension carried forward to ThreadShelf 1.3.0', () => {
  it('advertises the original capability contract', async () => {
    const { body } = await request({}, '/api/reader/capabilities');
    assert.equal(body.readerSearch.version, 1);
    assert.equal(body.readerSearch.path, '/api/reader/search');
    assert.equal(body.readerSearch.maxPageSize, 50);
    assert.equal(body.readerSearch.cursor, true);
    assert.equal(body.readerSearch.exactTotal, true);
  });
  for (const [label, options] of [
    ['keyword', { mode: 'keyword' }],
    ['meaning', { mode: 'semantic' }],
    ['smart', { mode: 'semantic', keywordBoost: true }],
  ]) {
    it(`${label} reaches all 520 chunks beyond the old 50/200 cutoffs, without duplicates`, async () => {
      const beforeCalls = embeddingCalls;
      const rows = await allPages(options);
      assert.equal(rows.length, 520);
      assert.equal(embeddingCalls - beforeCalls, options.mode === 'semantic' ? 1 : 0);
      const again = await request(options);
      assert.deepEqual(again.body.results.map(identity), rows.slice(0, 50).map(identity), 'equal-rank ordering must be repeatable');
    });
  }
  it('single-collection pages and final short page are exact', async () => {
    const rows = await allPages({ collection: 'alpha', n: 17 });
    assert.equal(rows.length, 260);
    assert.ok(rows.every((r) => r.metadata.collection === 'alpha'));
  });
  it('rare model matches past rank 200 are preserved in semantic searches', async () => {
    const rows = await allPages({ mode: 'semantic', model: 'rare-model', n: 7 });
    assert.equal(rows.length, 52);
    assert.ok(rows.every((r) => r.metadata.model === 'rare-model'));
  });
  it('applies provider, role, date and origin filters before pagination', async () => {
    const opts = { provider: 'openai', roles: 'user', from: '2026-01-03', to: '2026-01-03', origin: 'threadshelf', n: 13 };
    const rows = await allPages(opts);
    assert.equal(rows.length, 88);
    assert.ok(rows.every((r) => r.metadata.provider === 'openai' && r.metadata.role === 'user' && r.metadata.createdInThreadShelf));
    const archive = await allPages({ origin: 'archive' });
    assert.equal(archive.length, 346);
  });
  it('returns an empty complete page when there are no matches', async () => {
    const { status, body } = await request({ q: 'unmatched-synthetic-token' });
    assert.equal(status, 200);
    assert.deepEqual(body, { results: [], total: 0, hasMore: false, nextCursor: null });
  });
  it('rejects altered query/filter cursors, invalid offsets and invalid page sizes', async () => {
    const { body } = await request();
    const cursor = body.nextCursor;
    for (const change of [{ q: 'other' }, { model: 'rare-model' }, { provider: 'openai' }, { origin: 'archive' }]) {
      assert.equal((await request({ cursor, ...change })).status, 400);
    }
    assert.equal((await request({ cursor: 'invalid' })).status, 400);
    assert.equal((await request({ cursor: `${cursor.split('.')[0]}.999999` })).status, 400);
    assert.equal((await request({ n: 51 })).status, 400);
    assert.equal((await request({ n: -1 })).status, 400);
    assert.equal((await request({ origin: 'invalid' })).status, 400);
    assert.equal((await request({ cursor: `${'0'.repeat(48)}.50` })).status, 410);
  });
  it('deleting a snapshot makes its cursor expire explicitly', async () => {
    const { body } = await request();
    const deleted = await fetch(`${base}/api/reader/search?cursor=${encodeURIComponent(body.nextCursor)}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal((await request({ cursor: body.nextCursor })).status, 410);
  });
  it('preserves the upstream search response and validation contract', async () => {
    const result = await request({}, '/api/search');
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body), ['results']);
    assert.equal(result.body.results.length, 50);
    assert.equal((await request({ n: 51 }, '/api/search')).status, 400);
  });
  it('keeps an active result snapshot stable when database rows change', async () => {
    const { body: first } = await request({ collection: 'alpha' });
    const table = await database.openTable('alpha');
    await table.add([row('alpha', 999)]);
    const { body: next } = await request({ collection: 'alpha', cursor: first.nextCursor });
    assert.equal(next.total, 260);
    assert.ok(!next.results.some((r) => r.id === 'alpha-0999'));
    const fresh = await request({ collection: 'alpha' });
    assert.equal(fresh.body.total, 261);
  });
});
