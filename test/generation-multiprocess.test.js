import { closeStoragePublication } from '../src/storage-publication.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { repoRoot, stopChildProcess } from './shared/helpers.js';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-generation-multiprocess-'));
process.env.THREADSHELF_DATA_DIR = root;
process.env.LANCEDB_PATH = join(root, 'db');
process.env.COLLECTIONS_PATH = join(root, 'collections.json');
const store = await import('../src/store.ts');
after(async () => {
  closeStoragePublication();
  await rm(root, { recursive: true, force: true });
});

const launch = (mode, id) => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/shared/generation-concurrency-worker.mjs', mode, id],
    { cwd: repoRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  const messages = [];
  let output = '';
  child.stdout.on('data', (chunk) => (output = (output + chunk).slice(-8192)));
  child.stderr.on('data', (chunk) => (output = (output + chunk).slice(-8192)));
  child.on('message', (message) => messages.push(message));
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  const wait = async (event) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const failed = messages.find((message) => message.event === 'failed');
      if (failed) throw new Error(failed.message);
      const found = messages.find((message) => message.event === event);
      if (found) return found;
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`Worker ${mode} did not emit ${event}. ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { child, messages, exited, wait, output: () => output };
};

const seed = async (collection) => {
  const id = randomUUID();
  const source = `threadshelf://chat/${id}`;
  await store.replaceThreadsForFile(collection, source, 'threadshelf', [
    {
      key: id,
      title: 'Synthetic compatibility chat',
      // Single characters intentionally need no embedding model.
      turns: [{ user: 'A' }],
      createdInThreadShelf: true,
      threadCreatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  return { id, source };
};

const overlap = async (t, firstMode, secondMode, id) => {
  const first = launch(firstMode, id);
  t.after(() => stopChildProcess(first.child));
  await first.wait('paused');
  const second = launch(secondMode, id);
  t.after(() => stopChildProcess(second.child));
  await second.wait('started');
  try {
    // The second process has entered the operation, but the first owns its
    // complete read-modify-write transaction after reading its native snapshot.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      second.messages.some((message) => message.event === 'done'),
      false,
    );
  } finally {
    await writeFile(join(root, `${id}-release`), 'release');
  }
  await Promise.all([first.wait('done'), second.wait('done')]);
  assert.equal(await first.exited, 0, first.output());
  assert.equal(await second.exited, 0, second.output());
};

describe('cross-process compatibility repairs', { concurrency: false, timeout: 45_000 }, () => {
  it('retains an append overlapping provenance normalization of an existing chat', async (t) => {
    const { id, source } = await seed('threadshelf_conversations');
    await overlap(t, 'normalize', 'append', id);
    const [row] = await store.getStoredThreads('threadshelf_conversations', source);
    const turns = JSON.parse(row.turnsJson);
    assert.deepEqual(
      turns.map((turn) => turn.user ?? turn.ai),
      ['A', 'B'],
    );
    assert.ok(turns.every((turn) => turn.createdInThreadShelf === true));
  });

  it('migrates a legacy chat once while another process loads and extends it', async (t) => {
    const { id, source } = await seed('__threadshelf_chats');
    await overlap(t, 'migrate', 'get-and-append', id);
    const rows = await store.getStoredThreads('threadshelf_conversations', source);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      JSON.parse(rows[0].turnsJson).map((turn) => turn.user ?? turn.ai),
      ['A', 'B'],
    );
    assert.deepEqual(await store.getStoredThreads('__threadshelf_chats', source), []);
  });
});
