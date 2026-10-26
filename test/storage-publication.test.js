import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-publication-'));
process.env.LANCEDB_PATH = root;
const {
  closeStoragePublication,
  getStoragePublication,
  publishStorageGeneration,
  withPublicationSnapshot,
} = await import('../src/storage-publication.ts');
after(async () => {
  closeStoragePublication();
  await rm(root, { recursive: true, force: true });
});

it('refuses disposal during reads and releases the file after completed publication work', async () => {
  publishStorageGeneration('sample', 'first', 'sample_index', 'model-identity');
  const expected = getStoragePublication('sample');
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const reading = withPublicationSnapshot(async () => {
    await barrier;
    assert.deepEqual(getStoragePublication('sample'), expected);
  });
  assert.throws(closeStoragePublication, /reads are active/);
  release();
  await reading;
  closeStoragePublication();
  closeStoragePublication();

  // Windows refuses this move while SQLite retains its database handle.
  const path = join(root, '.threadshelf-publication.sqlite');
  const moved = join(root, 'closed-publication.sqlite');
  await rename(path, moved);
  await rename(moved, path);
  assert.deepEqual(getStoragePublication('sample'), expected, 'reopening preserves publication');
  publishStorageGeneration('sample', 'second', 'sample_next', 'model-identity');
  assert.equal(getStoragePublication('sample').previousGeneration, 'first');
});

it('retains the disposal guard for a nested reader until that reader finishes', async () => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let nested;
  await withPublicationSnapshot(async () => {
    nested = withPublicationSnapshot(() => barrier);
  });
  assert.throws(closeStoragePublication, /reads are active/);
  release();
  await nested;
  closeStoragePublication();
});
