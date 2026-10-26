import { closeStoragePublication } from '../src/storage-publication.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from '@lancedb/lancedb';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-generations-'));
process.env.LANCEDB_PATH = join(root, 'db');
process.env.COLLECTIONS_PATH = join(root, 'collections.json');
const store = await import('../src/store.ts');
const { getStoragePublication, activeThreadFilter } = await import('../src/storage-publication.ts');
const { withStorageReadLease } = await import('../src/storage-read-leases.ts');
const { withIndexOperation } = await import('../src/indexing-coordinator.ts');
const db = await connect(process.env.LANCEDB_PATH, { readConsistencyInterval: 0 });
after(async () => {
  closeStoragePublication();
  await rm(root, { recursive: true, force: true });
});
const file = (text, sourceFile = '/synthetic/export.json', key = 'stable') => ({
  sourceFile,
  provider: 'openai',
  conversations: [{ key, title: 'Synthetic title', turns: [{ user: text }], raw: { text } }],
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const childRun = (code) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });

describe(
  'bounded collection generation publication',
  { concurrency: false, timeout: 120_000 },
  () => {
    it('keeps the old archive and vectors readable until the replacement is published', async () => {
      const collection = 'atomic_publish';
      await store.replaceImportedFiles(collection, [file('Previously published searchable text')]);
      const before = getStoragePublication(collection);
      let observed = false;
      await store.replaceImportedFiles(collection, [file('Replacement searchable text')], {
        clearFirst: true,
        onEmbeddingProgress: async (done, total) => {
          if (!total || done !== total) return;
          observed = true;
          assert.equal(getStoragePublication(collection).generation, before.generation);
          assert.match(
            (await store.getStoredThreads(collection, file('').sourceFile, 'stable'))[0].turnsJson,
            /Previously published/,
          );
          assert.equal(
            (await store.keywordSearchCollection(collection, 'Previously published')).length,
            1,
          );
          assert.equal((await store.keywordSearchCollection(collection, 'Replacement')).length, 0);
        },
      });
      assert.ok(observed);
      assert.notEqual(getStoragePublication(collection).generation, before.generation);
      assert.equal((await store.getStoredThreads(collection, file('').sourceFile)).length, 1);
      assert.equal(
        (await store.keywordSearchCollection(collection, 'Previously published')).length,
        0,
      );
      assert.equal((await store.keywordSearchCollection(collection, 'Replacement')).length, 1);
      assert.deepEqual(
        (await store.listCollections()).filter((name) => name.startsWith('__')),
        [],
      );
    });

    it('preserves the published generation on cancellation after embedding', async () => {
      const collection = 'cancel_generation';
      await store.replaceImportedFiles(collection, [file('Retained original conversation')]);
      const before = getStoragePublication(collection);
      const controller = new AbortController();
      await assert.rejects(
        store.replaceImportedFiles(collection, [file('Cancelled replacement conversation')], {
          clearFirst: true,
          signal: controller.signal,
          onEmbeddingProgress: (done, total) => {
            if (total && done === total) controller.abort(new Error('Synthetic cancel'));
          },
        }),
        /Synthetic cancel/,
      );
      assert.equal(getStoragePublication(collection).generation, before.generation);
      assert.equal(
        (await store.keywordSearchCollection(collection, 'Retained original')).length,
        1,
      );
      assert.equal(
        (await store.keywordSearchCollection(collection, 'Cancelled replacement')).length,
        0,
      );
    });

    it('preserves an unrelated file and targets one conversation without materializing its siblings', async () => {
      const collection = 'additive_generation';
      await store.replaceImportedFiles(collection, [
        file('First source retained', '/first.json', 'one'),
        file('Second source original', '/second.json', 'two'),
      ]);
      const imported = await store.replaceImportedFiles(collection, [
        file('Second source replacement', '/second.json', 'two'),
      ]);
      assert.equal(imported, 1, 'retained unrelated chunks are not counted as newly imported');
      assert.equal((await store.getStoredThreads(collection, '/first.json', 'one')).length, 1);
      assert.equal((await store.getStoredThreads(collection, '/second.json', 'missing')).length, 0);
      assert.equal(
        (await store.keywordSearchCollection(collection, 'First source retained')).length,
        1,
      );
      assert.equal(
        (await store.keywordSearchCollection(collection, 'Second source replacement')).length,
        1,
      );
    });

    it('rejects every interactive write while another clear operation owns the collection', async () => {
      const collection = 'reserved_generation';
      await store.replaceImportedFiles(collection, [file('Reserved original conversation')]);
      const entered = deferred(),
        release = deferred();
      const reservation = withIndexOperation(collection, true, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      try {
        for (const mutation of [
          () =>
            store.renameStoredThread(collection, file('').sourceFile, 'stable', 'Blocked title'),
          () =>
            store.updateStoredThreadFromCurrent(
              collection,
              file('').sourceFile,
              'stable',
              (row) => ({
                provider: row.provider,
                conversation: { key: 'stable', title: 'Blocked', turns: [] },
              }),
            ),
          () => store.deleteStoredFile(collection, file('').sourceFile),
          () => store.dropCollection(collection),
        ])
          await assert.rejects(mutation(), (error) => error.code === 'COLLECTION_BUSY');
      } finally {
        release.resolve();
        await reservation;
      }
      assert.equal(
        (await store.getStoredThreads(collection, file('').sourceFile))[0].title,
        'Synthetic title',
      );
    });

    it('retains live reader snapshots, then reclaims older generations and versions', async () => {
      const collection = 'leased_generation';
      await store.replaceImportedFiles(collection, [file('First generation visible')]);
      const first = getStoragePublication(collection);
      const entered = deferred(),
        release = deferred();
      const reader = withStorageReadLease(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      try {
        await store.replaceImportedFiles(collection, [file('Second generation visible')]);
        await store.replaceImportedFiles(collection, [file('Third generation visible')]);
        assert.ok((await db.tableNames()).includes(first.indexTable));
        assert.equal(
          await (
            await db.openTable('__threads')
          ).countRows(`collection='${collection}' AND importGeneration='${first.generation}'`),
          1,
        );
      } finally {
        release.resolve();
        await reader;
      }
      await store.retireStorageGenerations();
      assert.ok(!(await db.tableNames()).includes(first.indexTable));
      assert.equal(
        await (await db.openTable('__threads')).countRows(`collection='${collection}'`),
        2,
      );
      assert.equal(
        await (await db.openTable('__threads')).countRows(activeThreadFilter(collection)),
        1,
      );
    });

    it('recovers after process death with staged archive rows and a staged vector table', async () => {
      const collection = 'crashed_generation';
      await store.replaceImportedFiles(collection, [
        file('Crash-safe original searchable conversation'),
      ]);
      const before = getStoragePublication(collection);
      const result = await childRun(`
      import { connect } from '@lancedb/lancedb';
      const db = await connect(process.env.LANCEDB_PATH);
      const prototype = Object.getPrototypeOf(await db.openTable('__threads'));
      const add = prototype.add;
      prototype.add = async function(rows,options) {
        const result = await add.call(this,rows,options);
        if(Array.isArray(rows) && rows.some(row=>row.collection==='${collection}' && row.importGeneration && row.importGeneration!=='${before.generation}')) process.exit(77);
        return result;
      };
      const store = await import('./src/store.ts');
      await store.replaceImportedFiles('${collection}',${JSON.stringify([file('Unpublished replacement after crash')])},{clearFirst:true});
    `);
      assert.equal(result.code, 77, result.output.slice(-2000));
      assert.equal(getStoragePublication(collection).generation, before.generation);
      assert.equal(
        (await store.keywordSearchCollection(collection, 'Crash-safe original')).length,
        1,
      );
      assert.equal(
        (await store.keywordSearchCollection(collection, 'Unpublished replacement')).length,
        0,
      );
      await store.retireStorageGenerations();
      assert.equal(
        await (await db.openTable('__threads')).countRows(`collection='${collection}'`),
        1,
      );
      await store.replaceImportedFiles(collection, [file('Successful retry after crash')], {
        clearFirst: true,
      });
      assert.equal((await store.keywordSearchCollection(collection, 'Successful retry')).length, 1);
    });
    it('reclaims an interrupted first import even when no publication exists', async () => {
      const collection = 'first_import_crash';
      const result = await childRun(`
        import { connect } from '@lancedb/lancedb';
        const db = await connect(process.env.LANCEDB_PATH);
        const prototype = Object.getPrototypeOf(await db.openTable('__threads'));
        const add = prototype.add;
        prototype.add = async function(rows,options) {
          const result = await add.call(this,rows,options);
          if(Array.isArray(rows) && rows.some(row=>row.collection==='${collection}')) process.exit(78);
          return result;
        };
        const store = await import('./src/store.ts');
        await store.replaceImportedFiles('${collection}',${JSON.stringify([file('First unpublished synthetic conversation')])},{clearFirst:true});
      `);
      assert.equal(result.code, 78, result.output.slice(-2000));
      assert.equal(getStoragePublication(collection), undefined);
      assert.deepEqual(await store.getStoredThreads(collection, file('').sourceFile), []);
      const threads = await db.openTable('__threads');
      assert.equal(await threads.countRows(`collection='${collection}'`), 1);
      await store.retireStorageGenerations({ cleanupTemporary: true });
      assert.equal(await threads.countRows(`collection='${collection}'`), 0);
      assert.ok(!(await store.listCollections()).includes(collection));
    });

    it('invalidates another process readiness cache at publication without a later archive write', async () => {
      const collection = 'cross_process_readiness';
      await store.replaceImportedFiles(collection, [file('Old readiness conversation')]);
      const before = getStoragePublication(collection);
      await (
        await db.openTable('__threads')
      ).update({
        where: activeThreadFilter(collection),
        values: { indexPending: 'all' },
      });
      const marker = join(root, 'publication-ready');
      const release = join(root, 'publication-release');
      const pending = childRun(`
        import { DatabaseSync } from 'node:sqlite';
        import { existsSync, writeFileSync } from 'node:fs';
        const exec = DatabaseSync.prototype.exec;
        DatabaseSync.prototype.exec = function(sql) {
          if(sql==='COMMIT') {
            let row;
            try { row=this.prepare('SELECT generation FROM publications WHERE collection=?').get('${collection}'); } catch {}
            if(row && row.generation!=='${before.generation}') {
              writeFileSync(${JSON.stringify(marker)}, 'ready');
              const wait = new Int32Array(new SharedArrayBuffer(4));
              const until = Date.now()+15000;
              while(!existsSync(${JSON.stringify(release)})) {
                if(Date.now()>until) throw new Error('Publication test release timed out');
                Atomics.wait(wait,0,0,10);
              }
            }
          }
          return exec.call(this,sql);
        };
        const store = await import('./src/store.ts');
        await store.replaceImportedFiles('${collection}',${JSON.stringify([file('New readiness conversation')])},{clearFirst:true});
      `);
      try {
        const until = Date.now() + 15000;
        for (;;) {
          try {
            await access(marker);
            break;
          } catch {}
          assert.ok(Date.now() < until, 'child reaches publication boundary');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(getStoragePublication(collection).generation, before.generation);
        assert.deepEqual(await store.keywordSearchCollection(collection, 'Old readiness'), []);
      } finally {
        await writeFile(release, 'continue');
      }
      const result = await pending;
      assert.equal(result.code, 0, result.output.slice(-2000));
      assert.equal((await store.keywordSearchCollection(collection, 'New readiness')).length, 1);
    });

    it('waits for in-flight readers before physically deleting their collection', async () => {
      const collection = 'delete_with_reader';
      await store.replaceImportedFiles(collection, [file('Reader retained during deletion')]);
      const entered = deferred(),
        release = deferred();
      const reader = withStorageReadLease(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      let deleted = false;
      const deletion = store.dropCollection(collection).then(() => {
        deleted = true;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(deleted, false);
        assert.equal(
          (await store.keywordSearchCollection(collection, 'Reader retained')).length,
          1,
        );
      } finally {
        release.resolve();
        await reader;
      }
      await deletion;
      assert.ok(!(await store.listCollections()).includes(collection));
    });
  },
);
