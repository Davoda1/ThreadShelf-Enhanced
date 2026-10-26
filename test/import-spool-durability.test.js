import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSpoolWriter,
  readCheckpoint,
  readImportSpool,
} from '../src/enhanced-import/spool.js';

const record = {
  sourceFile: 'synthetic.json',
  provider: 'threadshelf',
  conversation: { key: 'synthetic', turns: [{ user: 'Synthetic durable conversation' }] },
};
const checkpoint = {
  inputHash: 'synthetic-hash',
  sourceFile: record.sourceFile,
  count: 1,
  providers: ['threadshelf'],
  warnings: [],
};

const withSyncBoundary = async (t, inspect, fn) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'threadshelf-spool-sync-'));
  const originalOpen = fs.open;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      await inspect(String(args[0]), args[1]);
      return originalSync();
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await fn(join(root, 'synthetic.records'));
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
};

test('completed spools remain durable on platforms requiring writable flush handles', async (t) => {
  let flushedCheckpoint = false;
  await withSyncBoundary(
    t,
    async (path, flags) => {
      // Windows FlushFileBuffers requires GENERIC_WRITE. Enforce that real OS
      // contract on every host while retaining actual file writes and flushes.
      if (!/[wa+]/.test(String(flags)))
        throw Object.assign(new Error('Writable handle required for fsync'), { code: 'EPERM' });
      if (path.endsWith('.checkpoint.partial')) {
        assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).count, 1);
        flushedCheckpoint = true;
      }
    },
    async (path) => {
      const writer = await createSpoolWriter(path);
      try {
        await writer.append(record);
        const completed = await writer.finish(checkpoint);
        assert.equal(flushedCheckpoint, true);
        assert.deepEqual(
          await readCheckpoint(path, record.sourceFile, checkpoint.inputHash),
          completed,
        );
        const replayed = [];
        for await (const value of readImportSpool(path)) replayed.push(value);
        assert.deepEqual(replayed, [record]);
      } finally {
        await writer.discard();
      }
    },
  );
});

test('a checkpoint flush failure never publishes a reusable completed spool', async (t) => {
  const failure = Object.assign(new Error('Synthetic checkpoint flush failure'), { code: 'EIO' });
  await withSyncBoundary(
    t,
    async (path) => {
      if (path.endsWith('.checkpoint.partial')) throw failure;
    },
    async (path) => {
      const writer = await createSpoolWriter(path);
      try {
        await writer.append(record);
        await assert.rejects(writer.finish(checkpoint), (error) => error === failure);
        assert.equal(
          await readCheckpoint(path, record.sourceFile, checkpoint.inputHash),
          undefined,
        );
        await assert.rejects(fs.readFile(path + '.complete.json'), { code: 'ENOENT' });
      } finally {
        await writer.discard();
      }
    },
  );
});
