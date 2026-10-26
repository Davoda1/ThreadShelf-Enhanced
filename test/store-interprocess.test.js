import { closeStoragePublication } from '../src/storage-publication.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '@lancedb/lancedb';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-store-process-'));
process.env.LANCEDB_PATH = join(root, 'database');
process.env.COLLECTIONS_PATH = join(root, 'collections.json');
const store = await import('../src/store.ts');
const workers = new Set();
const workerPath = fileURLToPath(new URL('./shared/storage-lock-worker.js', import.meta.url));
const sourceFile = join(root, 'synthetic.json');
const key = 'synthetic-conversation';

function writer(collection, label, options = {}) {
  const child = fork(
    workerPath,
    [JSON.stringify({ mode: 'append', collection, sourceFile, key, label, ...options })],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ...(options.database ? { LANCEDB_PATH: options.database } : {}) },
    },
  );
  workers.add(child);
  let diagnostics = '';
  child.stderr.on('data', (data) => (diagnostics += data));
  const messages = [];
  child.on('message', (message) => messages.push(message));
  const finished = new Promise((resolve, reject) =>
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Synthetic writer exited ${code}: ${JSON.stringify(messages)} ${diagnostics}`,
            ),
          ),
    ),
  );
  finished.catch(() => {});
  const ready = async () => {
    const deadline = Date.now() + 15_000;
    while (!messages.some((message) => message.type === 'ready')) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`Synthetic writer failed to start: ${diagnostics}`);
      await delay(10);
    }
  };
  return { child, ready, finished };
}

async function seed(collection) {
  await store.replaceThreadsForFile(collection, sourceFile, 'openai', [
    { key, title: 'Synthetic concurrency fixture', turns: [{ user: 'original' }] },
  ]);
}

async function waitForFile(filename) {
  const deadline = Date.now() + 15_000;
  while (!existsSync(filename)) {
    if (Date.now() > deadline) throw new Error('Synthetic writer did not reach read barrier');
    await delay(10);
  }
}

after(async () => {
  for (const child of workers) if (child.exitCode === null) child.kill('SIGKILL');
  await Promise.all(
    [...workers].map((child) =>
      child.exitCode === null && child.signalCode === null
        ? new Promise((resolve) => child.once('exit', resolve))
        : undefined,
    ),
  );
  closeStoragePublication();
  await rm(root, { recursive: true, force: true });
});

describe('stored thread writes across processes', () => {
  it('serializes nested concurrent appends inside a compound thread operation', async () => {
    const collection = 'nested_writers';
    await seed(collection);
    await store.withStoredThreadWriteLock(() =>
      Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          store.updateStoredThreadFromCurrent(collection, sourceFile, key, (current) => ({
            provider: current.provider,
            conversation: {
              key,
              title: current.title,
              turns: [...JSON.parse(current.turnsJson), { ai: 'nested-' + index }],
            },
          })),
        ),
      ),
    );
    const [saved] = await store.getStoredThreads(collection, sourceFile);
    assert.equal(JSON.parse(saved.turnsJson).length, 13);
  });

  it(
    'holds the lock over the read and write, preserving both overlapping appends',
    { timeout: 30_000 },
    async () => {
      const collection = 'barrier_writers';
      await seed(collection);
      const first = writer(collection, 'first', { barrier: root });
      await first.ready();
      await waitForFile(join(root, 'first-read'));
      const readDeadline = new AbortController();
      try {
        const [published] = await Promise.race([
          store.getStoredThreads(collection, sourceFile),
          delay(5_000, undefined, { signal: readDeadline.signal }).then(() => {
            throw new Error('Published thread read blocked behind a writer');
          }),
        ]);
        assert.deepEqual(JSON.parse(published.turnsJson), [{ user: 'original' }]);
      } finally {
        readDeadline.abort();
      }
      const second = writer(collection, 'second', { barrier: root });
      await second.ready();
      await delay(250);
      assert.equal(
        existsSync(join(root, 'second-read')),
        false,
        'second writer read outside the lock',
      );
      await writeFile(join(root, 'first-release'), 'release');
      await first.finished;
      await waitForFile(join(root, 'second-read'));
      await writeFile(join(root, 'second-release'), 'release');
      await second.finished;
      const [saved] = await store.getStoredThreads(collection, sourceFile);
      assert.deepEqual(
        JSON.parse(saved.turnsJson).map((turn) => turn.user ?? turn.ai),
        ['original', 'first-0', 'second-0'],
      );
    },
  );

  it(
    'preserves every successful append from four independent writers',
    { timeout: 30_000 },
    async () => {
      const collection = 'stress_writers';
      await seed(collection);
      const writers = Array.from({ length: 4 }, (_, index) =>
        writer(collection, 'writer' + index, { count: 8 }),
      );
      await Promise.all(writers.map((worker) => worker.finished));
      const [saved] = await store.getStoredThreads(collection, sourceFile);
      const turns = JSON.parse(saved.turnsJson);
      assert.equal(turns.length, 33);
      assert.deepEqual(
        new Set(turns.slice(1).map((turn) => turn.ai)),
        new Set(
          Array.from({ length: 4 }, (_, worker) =>
            Array.from({ length: 8 }, (_, index) => `writer${worker}-${index}`),
          ).flat(),
        ),
      );
    },
  );

  it(
    'can save after a writer is terminated between its read and write',
    { timeout: 30_000 },
    async () => {
      const collection = 'terminated_writer';
      await seed(collection);
      const failed = writer(collection, 'terminated', { barrier: root });
      await failed.ready();
      await waitForFile(join(root, 'terminated-read'));
      failed.child.kill('SIGKILL');
      await assert.rejects(failed.finished, /Synthetic writer exited/);
      await writer(collection, 'survivor').finished;
      const [saved] = await store.getStoredThreads(collection, sourceFile);
      assert.deepEqual(
        JSON.parse(saved.turnsJson).map((turn) => turn.user ?? turn.ai),
        ['original', 'survivor-0'],
      );
    },
  );

  it(
    'migrates legacy thread columns safely while independent processes read and append',
    { timeout: 30_000 },
    async () => {
      const database = join(root, 'legacy-database');
      const legacy = await connect(database, { readConsistencyInterval: 0 });
      await legacy.createTable('__threads', [
        {
          collection: 'legacy_schema',
          sourceFile,
          conversationKey: key,
          title: 'Legacy fixture',
          provider: 'openai',
          ordinal: 0,
          turnCount: 1,
          turnsJson: JSON.stringify([{ user: 'original' }]),
          ingestedAt: '2020-01-01T00:00:00.000Z',
        },
      ]);
      const writers = Array.from({ length: 4 }, (_, index) =>
        writer('legacy_schema', 'legacy' + index, { database, readFirst: true, count: 2 }),
      );
      await Promise.all(writers.map((worker) => worker.finished));
      const table = await legacy.openTable('__threads');
      const [saved] = await table.query().toArray();
      assert.equal(JSON.parse(saved.turnsJson).length, 9);
      assert.equal(saved.conversationKey, key);
      assert.equal(saved.sourceFile, sourceFile);
      assert.equal(saved.indexPending, 'local');
      assert.equal(saved.rawJson, '');
    },
  );

  it(
    'allows a separate process to append while an import is preparing embeddings',
    { timeout: 30_000 },
    async () => {
      const collection = 'embedding_available';
      await seed(collection);
      let preparing;
      let release;
      const ready = new Promise((resolve) => (preparing = resolve));
      const gate = new Promise((resolve) => (release = resolve));
      const importing = store.replaceImportedFiles(
        collection,
        [
          {
            sourceFile: sourceFile + '-empty',
            provider: 'openai',
            conversations: [{ key: 'empty', title: 'Empty fixture', turns: [] }],
          },
        ],
        {
          onEmbeddingProgress: async () => {
            preparing();
            await gate;
          },
        },
      );
      try {
        await ready;
        await writer(collection, 'during-embedding').finished;
      } finally {
        release();
        await importing;
      }
      const [saved] = await store.getStoredThreads(collection, sourceFile);
      assert.deepEqual(
        JSON.parse(saved.turnsJson).map((turn) => turn.user ?? turn.ai),
        ['original', 'during-embedding-0'],
      );
    },
  );

  it(
    'keeps published searches available while an import prepares embeddings',
    { timeout: 30_000 },
    async () => {
      const collection = 'search_during_embedding';
      await seed(collection);
      const database = await connect(process.env.LANCEDB_PATH, { readConsistencyInterval: 0 });
      await database.createTable(collection, [
        {
          id: 'published-row',
          document: 'Published searchable content',
          vector: [1, 0, 0],
          sourceFile,
          provider: 'openai',
          conversationKey: key,
          title: 'Published fixture',
          role: 'ai',
          turnIndex: '0',
          model: '',
          createdAt: '',
          createdInThreadShelf: false,
          generationProvider: '',
        },
      ]);
      let preparing;
      let release;
      const ready = new Promise((resolve) => (preparing = resolve));
      const gate = new Promise((resolve) => (release = resolve));
      const importing = store.replaceImportedFiles(
        collection,
        [
          {
            sourceFile: sourceFile + '-empty-search',
            provider: 'openai',
            conversations: [{ key: 'empty', title: 'Empty fixture', turns: [] }],
          },
        ],
        {
          onEmbeddingProgress: async () => {
            preparing();
            await gate;
          },
        },
      );
      const deadline = new AbortController();
      try {
        await ready;
        const results = await Promise.race([
          store.keywordSearchCollection(collection, 'searchable'),
          delay(5_000, undefined, { signal: deadline.signal }).then(() => {
            throw new Error('Published search blocked behind embedding preparation');
          }),
        ]);
        assert.equal(results.length, 1);
        assert.equal(results[0].id, 'published-row');
      } finally {
        deadline.abort();
        release();
        await importing;
      }
    },
  );
});
