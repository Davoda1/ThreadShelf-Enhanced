import { closeStoragePublication } from '../src/storage-publication.js';
import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'threadshelf-read-leases-'));
process.env.LANCEDB_PATH = join(root, 'db');
const { withStorageReadLease, withExclusiveStorageRetirement } =
  await import('../src/storage-read-leases.ts');
const { withPublicationSnapshot, publishStorageGeneration, getStoragePublication } =
  await import('../src/storage-publication.ts');
after(async () => {
  closeStoragePublication();
  await rm(root, { recursive: true, force: true });
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it('a delayed async child reacquires its lease and publication snapshot after the parent has finished', async () => {
  publishStorageGeneration('sample', 'first', null);
  const start = deferred(),
    entered = deferred(),
    finish = deferred();
  let child;
  await withStorageReadLease(() =>
    withPublicationSnapshot(async () => {
      child = (async () => {
        await start.promise;
        return withStorageReadLease(() =>
          withPublicationSnapshot(async () => {
            assert.equal(getStoragePublication('sample').generation, 'second');
            entered.resolve();
            await finish.promise;
          }),
        );
      })();
    }),
  );
  publishStorageGeneration('sample', 'second', null);
  start.resolve();
  await entered.promise;
  assert.equal(await withExclusiveStorageRetirement(async () => {}), false);
  finish.resolve();
  await child;
  assert.equal(await withExclusiveStorageRetirement(async () => {}), true);
});

it('an already-started nested read keeps the parent lease alive until it finishes', async () => {
  const entered = deferred(),
    finish = deferred();
  let child,
    parentFinished = false;
  const parent = withStorageReadLease(async () => {
    child = withStorageReadLease(async () => {
      entered.resolve();
      await finish.promise;
    });
  }).then(() => {
    parentFinished = true;
  });
  await entered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parentFinished, false);
  assert.equal(await withExclusiveStorageRetirement(async () => {}), false);
  finish.resolve();
  await Promise.all([parent, child]);
  assert.equal(await withExclusiveStorageRetirement(async () => {}), true);
});
