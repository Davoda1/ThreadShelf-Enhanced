import { describe, it } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from '@lancedb/lancedb';
import { createMixedFixtureFolder, ingestViaNdjson, startApiServer } from './helpers.js';

describe('API E2E smoke', () => {
  it(
    'ingests mixed anonymized exports, searches multilingual text, and returns full thread',
    { timeout: 180_000 },
    async () => {
      const ctx = await startApiServer();
      const exportsDir = await createMixedFixtureFolder(ctx.tempRoot);

      try {
        const database = await connect(join(ctx.tempRoot, '.lancedb'));
        await database.createTable('e2e_fixture', [
          {
            id: 'legacy-row',
            vector: Array(384).fill(0),
            document: 'legacy filler unrelated to the search query',
            sourceFile: join(exportsDir, 'gemini', 'conversation.json'),
            conversationKey: '',
            title: '',
            role: 'ai',
            turnIndex: '0',
            model: '',
            createdAt: '',
          },
        ]);

        const ingestResult = await ingestViaNdjson(ctx.baseUrl, exportsDir, 'e2e_fixture', false);
        assert.strictEqual(ingestResult.files.length, 6);
        assert.strictEqual(ingestResult.conversations, 6);
        assert.strictEqual(ingestResult.errors.length, 0);
        assert.ok(ingestResult.ingested >= 8);
        const publicationDb = new DatabaseSync(
          join(ctx.tempRoot, '.lancedb', '.threadshelf-publication.sqlite'),
          { readOnly: true },
        );
        let publication;
        try {
          publication = publicationDb
            .prepare('SELECT generation,indexTable FROM publications WHERE collection=?')
            .get('e2e_fixture');
        } finally {
          publicationDb.close();
        }
        assert.ok(publication?.generation && publication.indexTable);
        const publishedIndex = await database.openTable(publication.indexTable);
        const schema = await publishedIndex.schema();
        assert.ok(schema.fields.some((field) => field.name === 'provider'));
        assert.strictEqual(await publishedIndex.countRows(), ingestResult.ingested);
        assert.strictEqual(await publishedIndex.countRows("id='legacy-row'"), 0);
        assert.strictEqual(
          await (
            await database.openTable('__threads')
          ).countRows(`collection='e2e_fixture' AND importGeneration='${publication.generation}'`),
          6,
        );

        const statsRes = await fetch(`${ctx.baseUrl}/api/collections/e2e_fixture/stats`);
        assert.strictEqual(statsRes.ok, true);
        const stats = await statsRes.json();
        assert.strictEqual(stats.collection, 'e2e_fixture');
        assert.strictEqual(stats.files, 6);
        assert.ok(stats.chunks >= 8);
        assert.ok(stats.roles.user > 0);
        assert.ok(stats.roles.ai > 0);

        const secondIngest = await ingestViaNdjson(ctx.baseUrl, exportsDir, 'e2e_fixture', false);
        assert.strictEqual(secondIngest.files.length, 6);
        assert.strictEqual(secondIngest.errors.length, 0);
        const dedupStatsRes = await fetch(`${ctx.baseUrl}/api/collections/e2e_fixture/stats`);
        assert.strictEqual(dedupStatsRes.ok, true);
        const dedupStats = await dedupStatsRes.json();
        assert.strictEqual(dedupStats.files, stats.files);
        assert.strictEqual(dedupStats.chunks, stats.chunks);
        assert.deepStrictEqual(dedupStats.roles, stats.roles);

        const searchUrl = new URL('/api/search', ctx.baseUrl);
        searchUrl.searchParams.set('collection', 'e2e_fixture');
        searchUrl.searchParams.set('q', 'contraseña Unicode ¿Qué tal?');
        searchUrl.searchParams.set('keywordBoost', '1');
        const searchRes = await fetch(searchUrl);
        assert.strictEqual(searchRes.ok, true);
        const searchData = await searchRes.json();
        assert.ok(searchData.results.length > 0);
        assert.ok(searchData.results.some((result) => result.metadata.provider));

        const datedSearchUrl = new URL('/api/search', ctx.baseUrl);
        datedSearchUrl.searchParams.set('collection', 'e2e_fixture');
        datedSearchUrl.searchParams.set('q', 'contraseña Unicode ¿Qué tal?');
        datedSearchUrl.searchParams.set('from', '2099-01-01');
        const datedSearchRes = await fetch(datedSearchUrl);
        assert.strictEqual(datedSearchRes.ok, true);
        const datedSearchData = await datedSearchRes.json();
        assert.strictEqual(datedSearchData.results.length, 0);

        // Keyword mode: exact case-insensitive substring match, no embedding rank.
        const keywordSearchUrl = new URL('/api/search', ctx.baseUrl);
        keywordSearchUrl.searchParams.set('collection', 'e2e_fixture');
        keywordSearchUrl.searchParams.set('q', 'CONTRASEÑA');
        keywordSearchUrl.searchParams.set('mode', 'keyword');
        const keywordSearchRes = await fetch(keywordSearchUrl);
        assert.strictEqual(keywordSearchRes.ok, true);
        const keywordSearchData = await keywordSearchRes.json();
        assert.ok(keywordSearchData.results.length > 0);
        assert.ok(
          keywordSearchData.results.every((result) =>
            result.document.toLowerCase().includes('contraseña'),
          ),
        );

        const keywordMissUrl = new URL('/api/search', ctx.baseUrl);
        keywordMissUrl.searchParams.set('collection', 'e2e_fixture');
        keywordMissUrl.searchParams.set('q', 'string-that-appears-nowhere-in-fixtures');
        keywordMissUrl.searchParams.set('mode', 'keyword');
        const keywordMissRes = await fetch(keywordMissUrl);
        assert.strictEqual(keywordMissRes.ok, true);
        const keywordMissData = await keywordMissRes.json();
        assert.strictEqual(keywordMissData.results.length, 0);

        const badModeUrl = new URL('/api/search', ctx.baseUrl);
        badModeUrl.searchParams.set('collection', 'e2e_fixture');
        badModeUrl.searchParams.set('q', 'anything');
        badModeUrl.searchParams.set('mode', 'fuzzy');
        const badModeRes = await fetch(badModeUrl);
        assert.strictEqual(badModeRes.status, 400);

        const top = searchData.results[0];
        assert.match(top.document, /contraseña|Unicode|¿Qué tal\?|zażółć/i);
        assert.strictEqual(top.metadata.collection, undefined);

        const threadUrl = new URL('/api/thread', ctx.baseUrl);
        threadUrl.searchParams.set('collection', 'e2e_fixture');
        threadUrl.searchParams.set('sourceFile', top.metadata.sourceFile);
        const threadRes = await fetch(threadUrl);
        assert.strictEqual(threadRes.ok, true);
        const threadData = await threadRes.json();
        assert.ok(threadData.turns.length >= 2);
        const threadText = JSON.stringify(threadData.turns);
        assert.ok(
          threadText.includes('contraseña') ||
            threadText.includes('¿Qué tal?') ||
            threadText.includes('Unicode'),
        );

        // Insights dashboard aggregates: derived from __threads + chunk
        // metadata only, so they must work without touching source files.
        const insightsUrl = new URL('/api/insights', ctx.baseUrl);
        insightsUrl.searchParams.set('collection', 'e2e_fixture');
        const insightsRes = await fetch(insightsUrl);
        assert.strictEqual(insightsRes.ok, true);
        const insights = await insightsRes.json();
        assert.strictEqual(insights.collection, 'e2e_fixture');
        assert.strictEqual(insights.totals.files, 6);
        assert.strictEqual(insights.totals.conversations, 6);
        assert.ok(insights.totals.turns > 0);
        assert.ok(insights.totals.chunks >= 8);
        assert.ok(insights.providers.length >= 4);
        assert.ok(insights.providers.every((p) => p.provider && p.turns > 0));
        assert.ok(insights.longestThreads.length > 0);
        assert.ok(insights.longestThreads[0].turnCount > 0);
        // Fixtures carry dated turns → the activity series and range exist.
        assert.ok(Array.isArray(insights.activity));
        if (insights.activity.length > 0) {
          assert.match(insights.activity[0].month, /^\d{4}-\d{2}$/);
          assert.ok(insights.firstActivity);
          assert.ok(insights.lastActivity);
        }

        const badInsightsRes = await fetch(
          `${ctx.baseUrl}/api/insights?collection=${encodeURIComponent('***')}`,
        );
        assert.strictEqual(badInsightsRes.status, 400);

        const clearRes = await fetch(`${ctx.baseUrl}/api/collections/e2e_fixture/clear`, {
          method: 'POST',
        });
        assert.strictEqual(clearRes.ok, true);
        const emptyStatsRes = await fetch(`${ctx.baseUrl}/api/collections/e2e_fixture/stats`);
        assert.strictEqual(emptyStatsRes.ok, true);
        const emptyStats = await emptyStatsRes.json();
        assert.strictEqual(emptyStats.chunks, 0);
        assert.strictEqual(emptyStats.isEmpty, true);
      } catch (e) {
        e.message += `\nServer output:\n${ctx.output.join('')}`;
        throw e;
      } finally {
        await ctx.stop();
      }
    },
  );
});
