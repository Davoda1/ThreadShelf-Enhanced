import { closeStoragePublication } from '../src/storage-publication.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { connect, MergeInsertBuilder } from '@lancedb/lancedb';
import { DatabaseSync } from 'node:sqlite';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-recovery-'));
process.env.LANCEDB_PATH = join(root, 'db');
process.env.COLLECTIONS_PATH = join(root, 'collections.json');
const store = await import('../src/store.ts');
const { activeThreadFilter, getStoragePublication } = await import('../src/storage-publication.ts');
const chats = await import('../src/generation/threads.ts');
const { ingestFiles, ingestFolder } = await import('../src/ingest.ts');
const db = await connect(process.env.LANCEDB_PATH, { readConsistencyInterval: 0 });
after(async () => {
  closeStoragePublication();
  await rm(root, { recursive: true, force: true });
});

const source = join(root, 'synthetic.json');
const conversation = (text = 'Original archived question', key = 'openai:stable-id') => ({
  key,
  title: 'Synthetic archive',
  turns: [{ user: text }],
});
const file = (conversations = [conversation()]) => ({
  sourceFile: source,
  provider: 'openai',
  conversations,
});
const response = {
  provider: 'llama-cpp',
  model: 'synthetic-model',
  content: 'Locally authored answer to preserve',
};
const rawChunks = async (collection) => {
  const publication = getStoragePublication(collection);
  const name = publication ? publication.indexTable : collection;
  if (!name || !(await db.tableNames()).includes(name)) return [];
  return (await db.openTable(name)).query().limit(1000).toArray();
};
const rawThreads = async (collection) =>
  (await db.openTable('__threads'))
    .query()
    .where(activeThreadFilter(collection))
    .limit(1000)
    .toArray();

// Intercept real LanceDB writes, including private staged tables and local-index merges.
const interceptWrites = async (t, intercept) => {
  const original = MergeInsertBuilder.prototype.execute;
  t.mock.method(MergeInsertBuilder.prototype, 'execute', function (data, options) {
    return intercept(data, () => original.call(this, data, options));
  });
  const tablePrototype = Object.getPrototypeOf(await db.openTable('__threads'));
  const originalAdd = tablePrototype.add;
  t.mock.method(tablePrototype, 'add', function (data, options) {
    return Array.isArray(data)
      ? intercept(data, () => originalAdd.call(this, data, options))
      : originalAdd.call(this, data, options);
  });
  const connectionPrototype = Object.getPrototypeOf(db);
  const originalCreate = connectionPrototype.createTable;
  t.mock.method(connectionPrototype, 'createTable', function (...args) {
    return Array.isArray(args[1])
      ? intercept(args[1], () => originalCreate.apply(this, args))
      : originalCreate.apply(this, args);
  });
};

const childRun = (code) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45_000,
      killSignal: 'SIGKILL',
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// This serial suite includes real embeddings and several process restarts; allow
// bounded headroom when the full runner also executes multiprocess regressions.
describe('durable archive and index recovery', { concurrency: false, timeout: 120_000 }, () => {
  it('lets another collection save while import embedding is paused', async () => {
    await store.replaceImportedFiles('unblocked_chat', [file()]);
    const target = await chats.resolveStoredThreadGenerationTarget(
      'unblocked_chat',
      source,
      conversation().key,
    );
    const entered = deferred();
    const gate = deferred();
    const importing = store.replaceImportedFiles('paused_import', [file()], {
      clearFirst: true,
      onEmbeddingProgress: async (done) => {
        if (done === 0) {
          entered.resolve();
          await gate.promise;
        }
      },
    });
    await entered.promise;
    try {
      const saved = await chats.appendStoredThreadExchange(
        target,
        'Independent chat write',
        response,
      );
      assert.equal(saved.saved, true);
    } finally {
      gate.resolve();
    }
    await importing;
  });

  it('rebuilds a stale import snapshot after a same-thread append during embedding', async () => {
    const collection = 'snapshot_retry';
    await store.replaceImportedFiles(collection, [file()]);
    let snapshots = 0;
    await store.replaceImportedFiles(collection, [file()], {
      onEmbeddingProgress: async (done) => {
        if (done !== 0) return;
        snapshots++;
        if (snapshots !== 1) return;
        await store.updateStoredThreadFromCurrent(
          collection,
          source,
          conversation().key,
          (current) => ({
            provider: current.provider,
            conversation: {
              key: current.conversationKey,
              title: current.title,
              turns: [
                ...JSON.parse(current.turnsJson),
                { ai: 'Written during embedding', createdInThreadShelf: true },
              ],
            },
          }),
        );
      },
    });
    assert.equal(snapshots, 2);
    assert.equal(
      JSON.parse((await store.getStoredThreads(collection, source))[0].turnsJson).at(-1).ai,
      'Written during embedding',
    );
    assert.equal(
      (await store.keywordSearchCollection(collection, 'Written during embedding')).length,
      1,
    );
  });

  it('preserves title and turns in both rename/append interleavings', async (t) => {
    const prototype = Object.getPrototypeOf(await db.openTable('__threads'));
    const original = prototype.update;
    for (const renameFirst of [true, false]) {
      const chat = await chats.createThreadShelfChat();
      const entered = deferred();
      const gate = deferred();
      let paused = false;
      const mocked = t.mock.method(prototype, 'update', async function (options) {
        const isRename = options.values?.title === 'Concurrent title' && !options.values?.turnsJson;
        const isAppend = options.values?.turnsJson?.includes('Concurrent response');
        if (!paused && (renameFirst ? isRename : isAppend)) {
          paused = true;
          entered.resolve();
          await gate.promise;
        }
        return original.call(this, options);
      });
      const rename = () => chats.renameThreadShelfChat(chat.id, 'Concurrent title');
      const append = () =>
        chats.appendThreadShelfChatExchange(chat.id, 'Concurrent prompt', {
          ...response,
          content: 'Concurrent response',
        });
      const first = renameFirst ? rename() : append();
      await entered.promise;
      const second = renameFirst ? append() : rename();
      gate.resolve();
      await Promise.all([first, second]);
      mocked.mock.restore();
      const saved = await chats.getThreadShelfChat(chat.id);
      assert.equal(saved.title, 'Concurrent title');
      assert.equal(saved.turns.at(-1).ai, 'Concurrent response');
      assert.equal(saved.turns.length, 2);
      await chats.deleteThreadShelfChat(chat.id);
    }
  });

  it('quarantines unreadable turns after reset without hiding healthy conversations', async () => {
    const collection = 'corrupt_reset';
    await store.replaceImportedFiles(collection, [
      file([
        conversation('Healthy searchable archive', 'good'),
        conversation('Corrupt target', 'bad'),
      ]),
    ]);
    // Warm the ready-filter cache before changing the table through another handle.
    assert.equal((await store.keywordSearchCollection(collection, 'Healthy')).length, 1);
    const tbl = await db.openTable('__threads');
    await tbl.update({ where: `collection = '${collection}'`, values: { indexPending: 'all' } });
    await tbl.update({
      where: `collection = '${collection}' AND conversationKey = 'bad'`,
      values: { turnsJson: '{broken' },
    });
    const [row] = await rawThreads(collection);
    await tbl.add([
      {
        ...row,
        sourceFile: 'threadshelf://collection-reset',
        conversationKey: '__reset',
        turnsJson: '[]',
        indexPending: 'reset',
      },
    ]);
    assert.deepEqual(await store.keywordSearchCollection(collection, 'Healthy'), []);
    await store.recoverPendingIndexes({ collection });
    assert.equal((await store.keywordSearchCollection(collection, 'Healthy')).length, 1);
    const bad = (await rawThreads(collection)).find((row) => row.conversationKey === 'bad');
    assert.equal(bad.turnsJson, '{broken');
    assert.equal(bad.indexPending, 'invalid');
    assert.match(bad.indexError, /original data retained/);
    // A later import also preserves the undecodable source instead of dropping it.
    await store.replaceImportedFiles(collection, [
      file([conversation('Healthy searchable archive', 'good')]),
    ]);
    assert.equal(
      (await rawThreads(collection)).find((row) => row.conversationKey === 'bad').turnsJson,
      '{broken',
    );
  });

  it('backs off persistently, pauses after eight failures and resumes after an edit', async (t) => {
    const collection = 'retry_backoff';
    await store.replaceImportedFiles(collection, [file()]);
    const edit = () =>
      store.updateStoredThreadFromCurrent(collection, source, conversation().key, (current) => ({
        provider: current.provider,
        conversation: {
          key: current.conversationKey,
          title: current.title,
          turns: [{ ai: 'Failure that persists', createdInThreadShelf: true }],
        },
      }));
    await edit();
    let fail = true;
    let calls = 0;
    await interceptWrites(t, (data, execute) => {
      if (fail && data.some((row) => row.document === 'Failure that persists')) {
        calls++;
        throw new Error('synthetic offline embedding store');
      }
      return execute();
    });
    await assert.rejects(store.indexStoredFile(collection, source), /synthetic offline/);
    const first = (await rawThreads(collection))[0];
    assert.equal(first.indexAttempts, 1);
    assert.ok(first.indexRetryAt > Date.now());
    assert.match(first.indexError, /synthetic offline/);
    await store.recoverPendingIndexes({ collection });
    assert.equal(calls, 1);
    const tbl = await db.openTable('__threads');
    for (let attempt = 2; attempt <= 8; attempt++) {
      await tbl.update({ where: `collection = '${collection}'`, values: { indexRetryAt: 0 } });
      await store.recoverPendingIndexes({ collection });
    }
    await tbl.update({ where: `collection = '${collection}'`, values: { indexRetryAt: 0 } });
    await store.recoverPendingIndexes({ collection });
    assert.equal(calls, 8);
    fail = false;
    await edit();
    await store.recoverPendingIndexes({ collection });
    assert.equal((await rawThreads(collection))[0].indexPending, '');
    assert.equal((await rawThreads(collection))[0].indexAttempts, 0);
  });

  it('preserves local turns and offsets through repeated import, changed keys and clearFirst', async () => {
    const collection = 'preserved';
    await store.replaceImportedFiles(collection, [file()]);
    const target = await chats.resolveStoredThreadGenerationTarget(
      collection,
      source,
      conversation().key,
    );
    await chats.appendStoredThreadExchange(target, 'Locally authored follow-up', response);
    for (let repeat = 0; repeat < 2; repeat++) {
      await store.replaceImportedFiles(collection, [
        file([
          {
            ...conversation(),
            turns: [{ user: 'Updated imported question' }, { ai: 'New imported answer' }],
          },
        ]),
      ]);
      const [saved] = await store.getStoredThreads(collection, source);
      const turns = JSON.parse(saved.turnsJson);
      assert.equal(turns.length, 4);
      assert.equal(turns[3].ai, response.content);
      const chunks = await rawChunks(collection);
      assert.equal(chunks.filter((row) => row.document === response.content).length, 1);
      assert.equal(chunks.find((row) => row.document === response.content).turnIndex, '3');
    }
    await store.replaceImportedFiles(
      collection,
      [file([conversation('Different imported conversation', 'openai:new-id')])],
      { clearFirst: true },
    );
    assert.equal((await store.getStoredThreads(collection, source)).length, 2);
    assert.equal(
      (await store.keywordSearchCollection(collection, 'Locally authored answer')).length,
      1,
    );
    await store.replaceImportedFiles(collection, [], { clearFirst: true });
    assert.equal((await store.getStoredThreads(collection, source)).length, 1);
    assert.equal(
      (await store.keywordSearchCollection(collection, 'Locally authored answer')).length,
      1,
    );
  });

  it('forks a positional key when the export is a different conversation', async () => {
    const collection = 'positional';
    await store.replaceImportedFiles(collection, [
      file([conversation('First archive question', 'google:0')]),
    ]);
    const target = await chats.resolveStoredThreadGenerationTarget(collection, source, 'google:0');
    await chats.appendStoredThreadExchange(target, 'Local follow-up for first archive', response);
    await store.replaceImportedFiles(collection, [
      file([conversation('Entirely different archive', 'google:0')]),
    ]);
    const rows = await store.getStoredThreads(collection, source);
    assert.equal(rows.length, 2);
    assert.equal(
      JSON.parse(rows.find((row) => row.conversationKey === 'google:0').turnsJson).length,
      1,
    );
    assert.equal(
      JSON.parse(rows.find((row) => row.conversationKey !== 'google:0').turnsJson).at(-1).ai,
      response.content,
    );
  });

  it('leaves the previous archive and vectors intact when staging the new archive fails', async (t) => {
    const collection = 'atomic_archive';
    await store.replaceImportedFiles(collection, [file()]);
    const published = getStoragePublication(collection);
    await interceptWrites(t, (data, execute) => {
      if (data[0]?.collection === collection) throw new Error('synthetic archive write failure');
      return execute();
    });
    await assert.rejects(
      store.replaceImportedFiles(collection, [file([conversation('Replacement text')])]),
      /synthetic archive/,
    );
    assert.equal(
      JSON.parse((await store.getStoredThreads(collection, source))[0].turnsJson)[0].user,
      'Original archived question',
    );
    assert.equal((await rawChunks(collection))[0].document, 'Original archived question');
    assert.deepEqual(getStoragePublication(collection), published);
  });

  it('keeps the complete old publication on a failed vector stage and publishes a successful retry', async (t) => {
    const collection = 'atomic_vectors';
    await store.replaceImportedFiles(collection, [file()]);
    let fail = true;
    const published = getStoragePublication(collection);
    await interceptWrites(t, (data, execute) => {
      if (fail && data[0]?.document === 'Replacement vector text')
        throw new Error('synthetic vector failure');
      return execute();
    });
    await assert.rejects(
      store.replaceImportedFiles(collection, [file([conversation('Replacement vector text')])]),
      /synthetic vector/,
    );
    assert.equal((await rawChunks(collection))[0].document, 'Original archived question');
    assert.equal(
      JSON.parse((await rawThreads(collection))[0].turnsJson)[0].user,
      'Original archived question',
    );
    assert.equal((await rawThreads(collection))[0].indexPending, '');
    assert.equal((await store.keywordSearchCollection(collection, 'Original')).length, 1);
    assert.deepEqual(getStoragePublication(collection), published);
    fail = false;
    await store.recoverPendingIndexes();
    assert.equal(
      (await rawChunks(collection))[0].document,
      'Original archived question',
      'Unpublished failed input must not become the authoritative archive during recovery',
    );
    await store.replaceImportedFiles(collection, [file([conversation('Replacement vector text')])]);
    assert.equal((await rawChunks(collection))[0].document, 'Replacement vector text');
    assert.equal((await rawThreads(collection))[0].indexPending, '');
  });

  it('rolls back a failed publication transaction after both new tables have been staged', async (t) => {
    const collection = 'atomic_publication';
    await store.replaceImportedFiles(collection, [file()]);
    const previous = getStoragePublication(collection);
    const originalExec = DatabaseSync.prototype.exec;
    let failedCommits = 0;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
      if (sql === 'COMMIT' && this.location('main')?.endsWith('.threadshelf-publication.sqlite')) {
        failedCommits++;
        throw new Error('synthetic publication commit failure');
      }
      return originalExec.call(this, sql);
    });
    await assert.rejects(
      store.replaceImportedFiles(collection, [file([conversation('Must not become visible')])]),
      /synthetic publication commit failure/,
    );
    assert.equal(failedCommits, 1);
    assert.deepEqual(getStoragePublication(collection), previous);
    assert.deepEqual(
      (await rawChunks(collection)).map((row) => row.document),
      ['Original archived question'],
    );
    assert.equal(
      JSON.parse((await rawThreads(collection))[0].turnsJson)[0].user,
      'Original archived question',
    );
  });

  it('does not clear a collection when folder validation or cancellation fails', async () => {
    const collection = 'safe_clear';
    await store.replaceImportedFiles(collection, [file()]);
    const folder = join(root, 'bad-folder');
    await mkdir(folder);
    await writeFile(join(folder, 'broken.json'), '{invalid');
    const result = await ingestFolder(collection, folder, { clearFirst: true });
    assert.equal(result.errors.length, 1);
    assert.equal((await rawChunks(collection))[0].document, 'Original archived question');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      store.replaceImportedFiles(collection, [], { clearFirst: true, signal: controller.signal }),
      { name: 'AbortError' },
    );
    assert.equal((await rawThreads(collection))[0].indexPending, '');
  });

  it('keeps matching archive and vectors when cancellation arrives immediately after publication commits', async (t) => {
    const collection = 'commit_abort';
    await store.replaceImportedFiles(collection, [file()]);
    const controller = new AbortController();
    const originalExec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
      const result = originalExec.call(this, sql);
      if (sql === 'COMMIT' && this.location('main')?.endsWith('.threadshelf-publication.sqlite'))
        controller.abort();
      return result;
    });
    await store.replaceImportedFiles(
      collection,
      [file([conversation('Committed despite late cancellation')])],
      { signal: controller.signal },
    );
    assert.equal((await rawChunks(collection))[0].document, 'Committed despite late cancellation');
    assert.equal((await rawThreads(collection))[0].indexPending, '');
  });

  it('rejects deletion during generation, including the stored-thread API alias', async () => {
    const chat = await chats.createThreadShelfChat();
    const release = chats.acquireThreadShelfChat(chat.id);
    await assert.rejects(chats.deleteThreadShelfChat(chat.id), chats.ThreadShelfChatBusyError);
    release();
    const target = await chats.resolveStoredThreadGenerationTarget(
      'threadshelf_conversations',
      `threadshelf://chat/${chat.id}`,
      chat.id,
    );
    const releaseAlias = chats.acquireStoredThreadGeneration(target);
    await assert.rejects(chats.deleteThreadShelfChat(chat.id), chats.ThreadShelfChatBusyError);
    releaseAlias();
    // Simulate a crash after copying a legacy chat but before removing its source.
    await store.replaceThreadsForFile(
      '__threadshelf_chats',
      `threadshelf://chat/${chat.id}`,
      'threadshelf',
      [
        {
          key: chat.id,
          title: 'Leftover legacy copy',
          turns: [],
          createdInThreadShelf: true,
        },
      ],
    );
    await chats.deleteThreadShelfChat(chat.id);
    await assert.rejects(chats.getThreadShelfChat(chat.id), chats.ThreadShelfChatNotFoundError);
  });

  it('serializes deletion behind an in-flight index and never recreates deleted chunks', async (t) => {
    const chat = await chats.createThreadShelfChat('Delete race', [
      { user: 'Original locally stored message' },
    ]);
    const sourceFile = `threadshelf://chat/${chat.id}`;
    await store.updateStoredThreadFromCurrent(
      'threadshelf_conversations',
      sourceFile,
      chat.id,
      (current) => ({
        provider: 'threadshelf',
        conversation: {
          key: chat.id,
          title: chat.title,
          createdInThreadShelf: true,
          turns: [
            ...JSON.parse(current.turnsJson),
            { ai: 'Queued answer for deletion', createdInThreadShelf: true },
          ],
        },
      }),
    );
    let entered;
    const barrier = new Promise((resolve) => {
      entered = resolve;
    });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await interceptWrites(t, async (data, execute) => {
      if (data.some((row) => row.document === 'Queued answer for deletion')) {
        entered();
        await gate;
      }
      return execute();
    });
    const indexing = store.indexStoredFile('threadshelf_conversations', sourceFile);
    await barrier;
    const deleting = chats.deleteThreadShelfChat(chat.id);
    release();
    await Promise.all([indexing, deleting]);
    await store.recoverPendingIndexes();
    assert.equal(
      (await rawChunks('threadshelf_conversations')).filter((row) => row.sourceFile === sourceFile)
        .length,
      0,
    );
    assert.equal(
      (await rawThreads('threadshelf_conversations')).filter((row) => row.sourceFile === sourceFile)
        .length,
      0,
    );
  });

  it('retains an empty tombstone if deletion fails, then clears it on recovery', async (t) => {
    const collection = 'delete_retry';
    await store.replaceImportedFiles(collection, [file()]);
    const table = await db.openTable(getStoragePublication(collection)?.indexTable ?? collection);
    const prototype = Object.getPrototypeOf(table);
    const original = prototype.delete;
    let fail = true;
    t.mock.method(prototype, 'delete', function (where) {
      if (fail && where === `sourceFile = '${source.replaceAll("'", "''")}'`)
        throw new Error('synthetic delete failure');
      return original.call(this, where);
    });
    await assert.rejects(store.deleteStoredFile(collection, source), /synthetic delete/);
    const [tombstone] = await rawThreads(collection);
    assert.equal(tombstone.turnsJson, '[]');
    assert.equal(tombstone.indexPending, 'delete');
    assert.deepEqual(await store.getStoredThreads(collection, source), []);
    fail = false;
    await store.recoverPendingIndexes();
    assert.deepEqual(await rawChunks(collection), []);
    assert.deepEqual(await rawThreads(collection), []);
  });

  it('does not retry a failed local index after the saved chat is deleted', async (t) => {
    const chat = await chats.createThreadShelfChat('Failed local index');
    await interceptWrites(t, (data, execute) => {
      if (data.some((row) => row.document === 'Failed answer must stay deleted')) {
        throw new Error('synthetic local index failure');
      }
      return execute();
    });
    const result = await chats.appendThreadShelfChatExchange(chat.id, 'Saved before indexing', {
      ...response,
      content: 'Failed answer must stay deleted',
    });
    assert.equal(result.persistence.saved, true);
    assert.equal(result.persistence.indexed, false);
    await chats.deleteThreadShelfChat(chat.id);
    const recovered = await childRun(`
      import { startIndexRecovery, recoverPendingIndexes } from './src/store.ts';
      const stop = startIndexRecovery();
      await recoverPendingIndexes();
      stop();
    `);
    assert.equal(recovered.code, 0, recovered.output);
    const sourceFile = `threadshelf://chat/${chat.id}`;
    assert.equal(
      (await rawChunks('threadshelf_conversations')).filter((row) => row.sourceFile === sourceFile)
        .length,
      0,
    );
    assert.equal(
      (await rawThreads('threadshelf_conversations')).filter((row) => row.sourceFile === sourceFile)
        .length,
      0,
    );
  });

  it('retains the complete old publication after process death during staging, then accepts a fresh replacement', async () => {
    const collection = 'restart_clear';
    await store.replaceImportedFiles(collection, [file()]);
    const crashing = await childRun(`
      import { connect } from '@lancedb/lancedb';
      import { replaceImportedFiles } from './src/store.ts';
      const database = await connect(process.env.LANCEDB_PATH);
      const prototype = Object.getPrototypeOf(await database.openTable('__threads'));
      const original = prototype.add;
      prototype.add = async function(data, options) {
        const result = await original.call(this, data, options);
        if (data.some(row => row.collection === 'restart_clear' && row.importGeneration)) process.exit(73);
        return result;
      };
      await replaceImportedFiles('restart_clear', [{ sourceFile: 'synthetic-new-file', provider: 'openai',
        conversations: [{ key: 'new-id', title: 'Restarted archive', turns: [{ user: 'Durable replacement after restart' }] }]
      }], { clearFirst: true });
    `);
    assert.equal(crashing.code, 73, crashing.output);
    const recovered = await childRun(`
      import { recoverPendingIndexes } from './src/store.ts';
      await recoverPendingIndexes();
    `);
    assert.equal(recovered.code, 0, recovered.output);
    assert.deepEqual(
      (await rawChunks(collection)).map((row) => row.document),
      ['Original archived question'],
    );
    assert.equal(
      JSON.parse((await rawThreads(collection))[0].turnsJson)[0].user,
      'Original archived question',
    );
    await store.replaceImportedFiles(
      collection,
      [
        {
          sourceFile: 'synthetic-new-file',
          provider: 'openai',
          conversations: [
            {
              key: 'new-id',
              title: 'Restarted archive',
              turns: [{ user: 'Durable replacement after restart' }],
            },
          ],
        },
      ],
      { clearFirst: true },
    );
    const rows = await rawChunks(collection);
    assert.deepEqual(
      rows.map((row) => row.document),
      ['Durable replacement after restart'],
    );
    assert.equal((await rawThreads(collection)).length, 1);
    assert.equal((await rawThreads(collection))[0].indexPending, '');
  });

  it('indexes saved local turns after restart and reads their latest version', async () => {
    const collection = 'restart_local';
    await store.replaceThreadsForFile(collection, source, 'threadshelf', [
      {
        ...conversation('Outdated saved text'),
        createdInThreadShelf: true,
        turns: [{ user: 'Outdated saved text', createdInThreadShelf: true }],
      },
    ]);
    await store.updateStoredThreadFromCurrent(
      collection,
      source,
      conversation().key,
      (current) => ({
        provider: 'threadshelf',
        conversation: {
          key: current.conversationKey,
          title: current.title,
          createdInThreadShelf: true,
          turns: [{ user: 'Latest saved text for recovery', createdInThreadShelf: true }],
        },
      }),
    );
    const result = await childRun(
      `import { recoverPendingIndexes } from './src/store.ts'; await recoverPendingIndexes();`,
    );
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(
      (await rawChunks(collection)).map((row) => row.document),
      ['Latest saved text for recovery'],
    );
  });

  it('recovers the complete new publication after process death immediately following its commit', async () => {
    const collection = 'restart_committed';
    await store.replaceImportedFiles(collection, [file()]);
    const crashing = await childRun(`
      import { DatabaseSync } from 'node:sqlite';
      import { replaceImportedFiles } from './src/store.ts';
      const original = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        const result = original.call(this, sql);
        if (sql === 'COMMIT' && this.location('main')?.endsWith('.threadshelf-publication.sqlite')) process.exit(74);
        return result;
      };
      await replaceImportedFiles('restart_committed', [{ sourceFile: 'committed-new-file', provider: 'openai',
        conversations: [{ key: 'committed-id', title: 'Committed archive', turns: [{ user: 'Published together before process exit' }] }]
      }], { clearFirst: true });
    `);
    assert.equal(crashing.code, 74, crashing.output);
    const recovered = await childRun(
      `import { recoverPendingIndexes } from './src/store.ts'; await recoverPendingIndexes();`,
    );
    assert.equal(recovered.code, 0, recovered.output);
    assert.deepEqual(
      (await rawChunks(collection)).map((row) => row.document),
      ['Published together before process exit'],
    );
    const threads = await rawThreads(collection);
    assert.equal(threads.length, 1);
    assert.equal(
      JSON.parse(threads[0].turnsJson)[0].user,
      'Published together before process exit',
    );
    assert.equal(threads[0].indexPending, '');
  });

  const openRouterExport = (turns) => JSON.stringify({ platform: 'openrouter', turns });

  it('skips an empty export in watch ingest without deleting its archive', async () => {
    const collection = 'empty_watch';
    const folder = join(root, 'empty-watch');
    await mkdir(folder);
    const exportFile = join(folder, 'conversation.json');
    await writeFile(
      exportFile,
      openRouterExport([{ role: 'user', content: 'Archived before the export emptied' }]),
    );
    const first = await ingestFiles(collection, [exportFile]);
    assert.deepEqual(first.errors, []);
    await writeFile(exportFile, openRouterExport([]));
    const second = await ingestFiles(collection, [exportFile]);
    assert.deepEqual(second.skippedFiles, [exportFile]);
    assert.equal((await store.getStoredThreads(collection, exportFile)).length, 1);
    assert.equal(
      (await store.keywordSearchCollection(collection, 'Archived before the export')).length,
      1,
    );
  });

  it('skips empty auxiliary exports without vetoing valid clearFirst input and emits embedding progress', async () => {
    const collection = 'clear_progress';
    const folder = join(root, 'clear-progress');
    await mkdir(folder);
    const valid = join(folder, 'valid.json');
    await writeFile(
      valid,
      openRouterExport([
        { role: 'user', content: 'Replacement question with enough text' },
        { role: 'assistant', content: 'Replacement answer with enough text' },
      ]),
    );
    const events = [];
    const replaced = await ingestFolder(collection, folder, {
      clearFirst: true,
      onProgress: (event) => events.push(event),
    });
    assert.equal(replaced.replacementSkipped, undefined);
    const embedding = events.filter((event) => event.embeddingTotal !== undefined);
    assert.ok(embedding.some((event) => event.progressPercent > 0 && event.progressPercent < 100));
    assert.equal(embedding.at(-1).embeddingDone, embedding.at(-1).embeddingTotal);

    await writeFile(join(folder, 'empty.json'), openRouterExport([]));
    const skipped = await ingestFolder(collection, folder, { clearFirst: true });
    assert.equal(skipped.replacementSkipped, undefined);
    assert.equal(skipped.conversations, 1);
    assert.deepEqual(skipped.skippedFiles, [join(folder, 'empty.json')]);
    assert.equal((await store.getStoredThreads(collection, valid)).length, 1);
    await rm(valid);
    const emptyOnly = await ingestFolder(collection, folder, { clearFirst: true });
    assert.equal(emptyOnly.replacementSkipped, true);
    assert.equal((await store.getStoredThreads(collection, valid)).length, 1);
  });
});
