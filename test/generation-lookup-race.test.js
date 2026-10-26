import { closeStoragePublication } from '../src/storage-publication.js';
import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { repoRoot, stopChildProcess } from './shared/helpers.js';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-generation-lookup-'));
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
    ['--import', 'tsx', 'test/shared/generation-lookup-worker.mjs', mode, id],
    { cwd: repoRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  const messages = [];
  let output = '';
  child.stdout.on('data', (chunk) => (output = (output + chunk).slice(-8192)));
  child.stderr.on('data', (chunk) => (output = (output + chunk).slice(-8192)));
  child.on('message', (message) => messages.push(message));
  const exited = new Promise((resolve) => child.on('close', resolve));
  const wait = async (event) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const failure = messages.find((message) => message.event === 'failed');
      if (failure) throw new Error(failure.message);
      const result = messages.find((message) => message.event === event);
      if (result) return result;
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`Worker ${mode} did not emit ${event}: ${output}`);
      await delay(10);
    }
  };
  return { child, messages, exited, wait, output: () => output };
};

it(
  'does not report a missing chat while another process moves it out of legacy storage',
  {
    timeout: 45_000,
  },
  async (t) => {
    const id = randomUUID();
    const source = `threadshelf://chat/${id}`;
    await store.replaceThreadsForFile('__threadshelf_chats', source, 'threadshelf', [
      {
        key: id,
        title: 'Synthetic lookup race',
        // Short text avoids a model download in this synchronization regression.
        turns: [{ user: 'A' }],
        createdInThreadShelf: true,
        threadCreatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const first = launch('pause-legacy', id);
    t.after(() => stopChildProcess(first.child));
    await first.wait('paused');
    const second = launch('migrate', id);
    t.after(() => stopChildProcess(second.child));
    await second.wait('started');
    try {
      // A legacy migration cannot slip between the first caller's primary and
      // legacy reads. The first process deliberately pauses before the latter.
      await delay(200);
      assert.equal(
        second.messages.some((message) => message.event === 'done'),
        false,
      );
    } finally {
      await writeFile(join(root, `${id}-lookup-release`), 'release');
    }
    const results = await Promise.all([first.wait('done'), second.wait('done')]);
    assert.ok(results.every((result) => result.id === id && result.turns[0].user === 'A'));
    assert.equal(await first.exited, 0, first.output());
    assert.equal(await second.exited, 0, second.output());
    assert.equal((await store.getStoredThreads('threadshelf_conversations', source)).length, 1);
    assert.deepEqual(await store.getStoredThreads('__threadshelf_chats', source), []);
  },
);
