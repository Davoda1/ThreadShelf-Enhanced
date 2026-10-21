import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '@lancedb/lancedb';
import {
  ThreadShelfClient,
  ServerSearchPager,
} from '../fixtures/compatibility-clients/reader/server.mjs';
import alternative from '../fixtures/compatibility-clients/alternative/server.cjs';
import { ingestViaNdjson, startApiServer } from './helpers.js';

const { ServerClient } = alternative;
const collection = 'released_clients';
const conversationCount = 105;
const passageCount = conversationCount * 2;
const keyword = 'compatibility-marker';

// Synthetic ChatGPT data exercises the production parser, store and embedder.
const conversation = (index) => ({
  id: `synthetic-${index}`,
  title: `Bicycle notes ${String(index).padStart(3, '0')}`,
  current_node: 'assistant',
  mapping: {
    root: { id: 'root', parent: null, children: ['user'] },
    user: {
      id: 'user',
      parent: 'root',
      children: ['assistant'],
      message: {
        author: { role: 'user' },
        content: {
          content_type: 'text',
          parts: [`${keyword} ${index}: How can I maintain my bicycle safely?`],
        },
        create_time: 1770000000 + index * 2,
      },
    },
    assistant: {
      id: 'assistant',
      parent: 'user',
      children: [],
      message: {
        author: { role: 'assistant' },
        content: {
          content_type: 'text',
          parts: [
            `${keyword} ${index}: Check tire pressure, lubricate the chain, and inspect the brakes before cycling.`,
          ],
        },
        metadata: { model_slug: 'synthetic-model' },
        create_time: 1770000001 + index * 2,
      },
    },
  },
});

describe('Released private and public Local client compatibility', () => {
  let ctx;
  let reader;
  let other;

  before(
    async () => {
      ctx = await startApiServer({ prefix: 'threadshelf-clients-', portBase: 7300 });
      reader = new ThreadShelfClient(ctx.baseUrl);
      other = new ServerClient(ctx.baseUrl);
      const folder = join(ctx.tempRoot, 'synthetic-exports');
      await mkdir(folder);
      await writeFile(
        join(folder, 'conversations.json'),
        JSON.stringify(
          Array.from({ length: conversationCount }, (_, index) => conversation(index)),
        ),
      );
      const result = await ingestViaNdjson(ctx.baseUrl, folder, collection);
      assert.deepEqual(result.errors, [], 'Production embedding and ingestion must succeed');
      assert.equal(result.conversations, conversationCount);
      assert.equal(result.ingested, passageCount);
      // Released apps must keep working when original imports have been moved.
      await rm(folder, { recursive: true });
    },
    { timeout: 240_000 },
  );

  after(async () => {
    other?.dispose();
    await ctx?.stop();
  });

  it('runs the exact shared private/public adapter bytes', async () => {
    for (const [file, expected] of [
      ['reader/server.mjs', '5884a4f03d437a31a773b371da31e08d09431dcf'],
      ['alternative/server.cjs', '6f1f5cc2d4da2312045db5358c86c7e9165c2045'],
    ]) {
      const bytes = await readFile(
        new URL(`../fixtures/compatibility-clients/${file}`, import.meta.url),
      );
      const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(hash, expected, `${file} must match the public v1.0.0 and private adapter`);
    }
  });

  it('uses real 384-dimensional model embeddings in the native store', async () => {
    const db = await connect(join(ctx.tempRoot, '.lancedb'));
    const rows = await (
      await db.openTable(collection)
    )
      .query()
      .select(['vector'])
      .limit(1)
      .toArray();
    const vector = Array.from(rows[0].vector);
    assert.equal(vector.length, 384);
    assert.ok(vector.every(Number.isFinite));
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(norm > 0.99 && norm < 1.01, `Expected normalized production embedding, got ${norm}`);
  });

  it('Reader browses, opens stored threads and validates server Insights', async () => {
    assert.equal((await reader.health()).ok, true);
    assert.deepEqual(await reader.collections(), [{ name: collection, count: conversationCount }]);
    const page = await reader.files({ collection, page: 3, pageSize: 50, sort: 'title' });
    assert.equal(page.total, conversationCount);
    assert.equal(page.files.length, 5);
    const thread = await reader.thread(page.files[0]);
    assert.equal(thread.turnCount, 2);
    assert.ok(thread.turns.some((turn) => turn.ai?.includes('tire pressure')));
    assert.equal(thread.sourceIdentity.conversationKey, page.files[0].conversationKey);
    const insights = await reader.insights(collection);
    assert.equal(insights.totals.conversations, conversationCount);
    assert.equal(insights.totals.chunks, passageCount);
    assert.equal(insights.roles.user, conversationCount);
    assert.equal(insights.roles.ai, conversationCount);
  });

  it('Alternative browses, normalizes stored messages and validates Insights', async () => {
    assert.equal((await other.health()).ok, true);
    const collections = await other.collections();
    assert.equal(collections.total, conversationCount);
    assert.deepEqual(
      collections.collections.find((item) => item.name === collection),
      { name: collection, count: conversationCount },
    );
    const page = await other.browse({ collection, offset: 100, limit: 50, sort: 'title' });
    assert.equal(page.total, conversationCount);
    assert.equal(page.items.length, 5);
    assert.equal(page.hasMore, false);
    const thread = await other.thread(page.items[0]);
    assert.equal(thread.messages.length, 2);
    assert.deepEqual(
      thread.messages.map((message) => message.role),
      ['user', 'assistant'],
    );
    assert.ok(thread.messages[1].text.includes('tire pressure'));
    const insights = await other.stats(collection);
    assert.equal(insights.totals.conversations, conversationCount);
    assert.equal(insights.totals.chunks, passageCount);
  });

  for (const mode of ['keyword', 'semantic']) {
    it(
      `Reader and Alternative page all ${passageCount} real ${mode} passages`,
      { timeout: 90_000 },
      async () => {
        const q = mode === 'keyword' ? keyword : 'bicycle maintenance';
        const pager = new ServerSearchPager();
        const readerHits = [];
        let searchSession;
        let result;
        for (let page = 1; page <= 5; page++) {
          result = await pager.search(reader, {
            q,
            collection,
            searchMode: mode,
            pageSize: 50,
            page,
            searchSession,
          });
          searchSession = result.searchSession;
          assert.equal(result.total, passageCount);
          assert.equal(result.totalKnown, true);
          assert.equal(result.searchInfo.engine, 'server-paged');
          readerHits.push(...result.results);
        }
        assert.equal(result.hasMore, false);
        assert.equal(result.results.length, 10);
        assert.equal(new Set(readerHits.map((hit) => hit.passageId)).size, passageCount);

        const alternativeHits = [];
        for (let offset = 0; offset < passageCount; offset += 50) {
          result = await other.search({ q, collection, mode, limit: 50, offset });
          assert.equal(result.total, passageCount);
          assert.equal(result.exhaustive, true);
          assert.equal(result.engine, 'reader-extension');
          alternativeHits.push(...result.items);
        }
        assert.equal(result.hasMore, false);
        assert.equal(new Set(alternativeHits.map((hit) => hit.passageId)).size, passageCount);
        const identity = (hit) =>
          JSON.stringify([
            hit.collection,
            hit.sourceFile,
            hit.conversationKey,
            hit.turnIndex,
            hit.role,
          ]);
        assert.deepEqual(alternativeHits.map(identity), readerHits.map(identity));
        if (mode === 'semantic')
          assert.ok(readerHits.every((hit) => Number.isFinite(hit.distance)));

        const readerFiltered = await pager.search(reader, {
          q,
          collection,
          searchMode: mode,
          provider: 'openai',
          role: 'assistant',
          pageSize: 50,
        });
        const otherFiltered = await other.search({
          q,
          collection,
          mode,
          provider: 'openai',
          role: 'assistant',
          limit: 50,
        });
        assert.equal(readerFiltered.total, conversationCount);
        assert.equal(otherFiltered.total, conversationCount);
        assert.ok(
          readerFiltered.results.every(
            (hit) => hit.role === 'assistant' && hit.provider === 'openai',
          ),
        );
        assert.deepEqual(otherFiltered.items.map(identity), readerFiltered.results.map(identity));
      },
    );
  }

  it('keeps the released bounded /api/search client contract', async () => {
    const result = await reader.search({
      q: keyword,
      collection,
      searchMode: 'keyword',
      limit: 50,
    });
    assert.equal(result.results.length, 50);
    assert.equal(result.searchInfo.exhaustive, false);
    assert.equal(result.searchInfo.maxResults, 50);
  });
});
