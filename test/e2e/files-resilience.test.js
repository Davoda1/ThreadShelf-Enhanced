import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdir, copyFile, rm } from 'fs/promises';
import { join } from 'path';
import { connect } from '@lancedb/lancedb';
import { startApiServer, ingestViaNdjson, repoRoot } from './helpers.js';

// Regression: LM Studio (and others) can rewrite/remove a conversation file after
// it was indexed. Since ingest stores normalized turns in the __threads table,
// both the /api/files listing and the /api/thread view must keep working from
// the stored copy after the source file disappears.
describe('files listing resilience', () => {
  it(
    'adds legacy thread metadata columns without rewriting archived turns',
    { timeout: 60_000 },
    async () => {
      for (const hasBlankColumn of [false, true]) {
        const ctx = await startApiServer({
          prefix: `threadshelf-thread-migration-${hasBlankColumn ? 'blank' : 'missing'}-`,
        });
        try {
          const database = await connect(join(ctx.tempRoot, '.lancedb'));
          const sourceFile = join(ctx.tempRoot, 'legacy-export.json');
          await database.createTable('legacy_threads', [{ sourceFile, role: 'user' }]);

          const legacyRow = {
            collection: 'legacy_threads',
            sourceFile,
            conversationKey: 'legacy:0',
            title: 'Legacy dated thread',
            provider: 'openai',
            ordinal: 0,
            turnCount: 2,
            turnsJson: JSON.stringify([
              { user: 'Earlier', createdAt: '2025-04-01T10:00:00.000Z' },
              {
                ai: 'Later',
                model: 'legacy/test-model',
                createdAt: '2026-06-15T12:30:00.000Z',
              },
            ]),
            ingestedAt: '2026-07-01T00:00:00.000Z',
            ...(hasBlankColumn ? { lastTurnAt: '' } : {}),
          };
          await database.createTable('__threads', [legacyRow]);

          const response = await fetch(`${ctx.baseUrl}/api/files?collection=legacy_threads`);
          const body = await response.json();
          assert.strictEqual(response.status, 200, JSON.stringify(body));
          assert.strictEqual(body.files.length, 1, JSON.stringify(body));
          assert.strictEqual(body.files[0].lastTurnAt, undefined);

          const migratedDatabase = await connect(join(ctx.tempRoot, '.lancedb'));
          const migratedTable = await migratedDatabase.openTable('__threads');
          const schema = await migratedTable.schema();
          assert.ok(schema.fields.some((field) => field.name === 'lastTurnAt'));
          assert.ok(schema.fields.some((field) => field.name === 'lastModel'));
          const rows = await migratedTable.query().toArray();
          assert.strictEqual(rows[0].lastTurnAt, '');
          assert.strictEqual(
            rows[0].lastModel,
            '',
            'legacy archives must not be rewritten only to backfill display metadata',
          );
        } catch (e) {
          e.message += `\nServer output:\n${ctx.output.join('')}`;
          throw e;
        } finally {
          await ctx.stop();
        }
      }
    },
  );

  it(
    'still lists and opens conversations when a source file is removed after indexing',
    { timeout: 180_000 },
    async () => {
      const ctx = await startApiServer({ prefix: 'threadshelf-files-' });
      const folder = join(ctx.tempRoot, 'exports');
      const fixtures = join(repoRoot, 'test', 'fixtures');
      await mkdir(folder, { recursive: true });
      await copyFile(join(fixtures, 'lmstudio-snapshot.json'), join(folder, 'a.conversation.json'));
      await copyFile(join(fixtures, 'lmstudio-polish.json'), join(folder, 'b.conversation.json'));

      try {
        const ingest = await ingestViaNdjson(ctx.baseUrl, folder, 'files_resilience');
        assert.strictEqual(ingest.files.length, 2);
        assert.strictEqual(ingest.errors.length, 0);

        const warm = await fetch(`${ctx.baseUrl}/api/files?collection=files_resilience`);
        assert.strictEqual(warm.status, 200);
        const warmData = await warm.json();
        assert.ok(
          warmData.files.some(
            (f) => f.sourceFile.endsWith('a.conversation.json') && f.turnCount > 0,
          ),
          JSON.stringify(warmData),
        );

        // Simulate the file disappearing / being rewritten away after indexing.
        await rm(join(folder, 'a.conversation.json'));

        const res = await fetch(`${ctx.baseUrl}/api/files?collection=files_resilience`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        // Both files still listed with their real conversations — the removed
        // one is served from stored threads, not a zero-turn fallback stub.
        assert.ok(data.files.length >= 2, JSON.stringify(data));
        assert.ok(
          data.files.some((f) => f.sourceFile.endsWith('b.conversation.json') && f.turnCount > 0),
          JSON.stringify(data),
        );
        const removedEntry = data.files.find((f) => f.sourceFile.endsWith('a.conversation.json'));
        assert.ok(removedEntry, JSON.stringify(data));
        assert.ok(removedEntry.turnCount > 0, JSON.stringify(removedEntry));

        // The full thread still opens from the stored copy after deletion.
        const threadUrl = new URL('/api/thread', ctx.baseUrl);
        threadUrl.searchParams.set('sourceFile', removedEntry.sourceFile);
        threadUrl.searchParams.set('collection', 'files_resilience');
        if (removedEntry.conversationKey) {
          threadUrl.searchParams.set('conversationKey', removedEntry.conversationKey);
        }
        const threadRes = await fetch(threadUrl);
        const threadText = await threadRes.text();
        assert.strictEqual(threadRes.status, 200, threadText);
        const thread = JSON.parse(threadText);
        assert.ok(Array.isArray(thread.turns) && thread.turns.length > 0, JSON.stringify(thread));

        const all = await fetch(`${ctx.baseUrl}/api/files?collection=all`);
        assert.strictEqual(all.status, 200);
        const allData = await all.json();
        assert.ok(allData.files.length >= 2, JSON.stringify(allData));
      } catch (e) {
        e.message += `\nServer output:\n${ctx.output.join('')}`;
        throw e;
      } finally {
        await ctx.stop();
      }
    },
  );
});
