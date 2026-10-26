import { closeStoragePublication } from '../src/storage-publication.js';
import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = await mkdtemp(join(tmpdir(), 'enhanced-preservation-'));
process.env.LANCEDB_PATH = join(root, 'db');
process.env.COLLECTIONS_PATH = join(root, 'collections.json');
const { replaceThreadsForFile, updateStoredThreadFromCurrent, getStoredThreads } =
  await import('../src/store.ts');
const { loadThread } = await import('../src/services/thread.ts');
after(async () => {
  closeStoragePublication();
  await rm(root, { recursive: true, force: true });
});
it('retains raw conversation and message metadata through storage and continuation', async () => {
  const source = join(root, 'no-longer-present.json');
  const raw = {
    title: 'Original',
    mapping: { hidden: { role: 'tool', content: 'Original tool data' } },
  };
  const metadata = {
    content_references: [{ type: 'webpage', url: 'https://example.com', title: 'Example' }],
  };
  await replaceThreadsForFile('preservation', source, 'openai', [
    {
      key: 'openai:stable',
      title: 'Original',
      raw,
      turns: [{ user: 'Keep exact  whitespace\n' }, { ai: 'Answer', metadata }],
    },
  ]);
  const first = await loadThread(source, 'preservation', 'openai:stable');
  assert.deepEqual(first.raw, raw);
  assert.deepEqual(first.turns[1].metadata, metadata);
  assert.equal(first.turns[0].user, 'Keep exact  whitespace\n');
  await updateStoredThreadFromCurrent('preservation', source, 'openai:stable', (current) => ({
    provider: current.provider,
    conversation: {
      key: current.conversationKey,
      title: current.title,
      turns: [
        ...JSON.parse(current.turnsJson),
        { ai: 'Local continuation', createdInThreadShelf: true },
      ],
    },
  }));
  const [stored] = await getStoredThreads('preservation', source);
  assert.deepEqual(JSON.parse(stored.rawJson), raw);
  assert.equal((await loadThread(source, 'preservation', 'openai:stable')).turns.length, 3);
});
