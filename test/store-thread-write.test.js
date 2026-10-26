import { closeStoragePublication } from '../src/storage-publication.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-thread-write-'));
process.env.LANCEDB_PATH = join(root, '.lancedb');

const {
  StoredThreadWriteError,
  getStoredThreads,
  replaceThreadsForFile,
  updateStoredThread,
  updateStoredThreadFromCurrent,
} = await import('../src/store.ts');

after(async () => {
  closeStoragePublication();
  await rm(root, { recursive: true, force: true });
});

describe('stored thread atomic updates', () => {
  it('merges against the latest row while holding the thread-store write lock', async () => {
    const collection = 'atomic_threads';
    const sourceFile = join(root, 'archive.json');
    const key = 'conversation:0';
    await replaceThreadsForFile(collection, sourceFile, 'openai', [
      {
        key,
        title: 'Atomic thread',
        turns: [{ user: 'Initial archive turn' }],
      },
    ]);

    await updateStoredThread(collection, sourceFile, 'openai', {
      key,
      title: 'Atomic thread',
      turns: [{ user: 'Initial archive turn' }, { ai: 'Concurrent re-ingest turn' }],
    });

    const saved = await updateStoredThreadFromCurrent(collection, sourceFile, key, (current) => {
      const turns = JSON.parse(current.turnsJson);
      return {
        provider: current.provider,
        conversation: {
          key,
          title: current.title,
          turns: [...turns, { user: 'Generated follow-up' }, { ai: 'Generated answer' }],
        },
      };
    });

    assert.deepStrictEqual(
      saved.turns.map((turn) => turn.user ?? turn.ai),
      [
        'Initial archive turn',
        'Concurrent re-ingest turn',
        'Generated follow-up',
        'Generated answer',
      ],
    );
    const [stored] = await getStoredThreads(collection, sourceFile);
    assert.deepStrictEqual(JSON.parse(stored.turnsJson), saved.turns);
  });

  it('reports a missing row instead of claiming that an update was saved', async () => {
    await assert.rejects(
      () =>
        updateStoredThreadFromCurrent(
          'atomic_threads',
          join(root, 'missing.json'),
          'missing',
          () => {
            throw new Error('updater must not run');
          },
        ),
      StoredThreadWriteError,
    );
  });
});
