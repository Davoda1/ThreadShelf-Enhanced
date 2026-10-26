import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(
  new URL('./shared/indexing-coordinator-worker.js', import.meta.url),
);
const worker = (root, mode, collection = 'alpha') => {
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath, mode, collection], {
    env: { ...process.env, LANCEDB_PATH: root },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr.on('data', (value) => {
    errors += String(value);
  });
  const exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const message = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Coordinator worker timed out: ${errors}`)),
      10_000,
    );
    child.once('message', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return {
    child,
    message,
    exit,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exit;
    },
  };
};

test('one server and one indexer are enforced across processes, with release after termination', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'threadshelf-coordinator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = worker(root, 'server');
  t.after(first.stop);
  assert.equal((await first.message).state, 'owned');
  const duplicate = worker(root, 'server');
  t.after(duplicate.stop);
  assert.match((await duplicate.message).message, /already running/);
  assert.equal((await duplicate.exit).code, 17);

  const importer = worker(root, 'index');
  t.after(importer.stop);
  assert.equal((await importer.message).state, 'owned');
  const secondImporter = worker(root, 'index', 'another');
  t.after(secondImporter.stop);
  assert.equal((await secondImporter.message).code, 'INDEXING_BUSY');
  await importer.stop();
  const replacement = worker(root, 'nested');
  t.after(replacement.stop);
  assert.equal((await replacement.message).state, 'written');
  assert.equal((await replacement.exit).code, 0);
});

test('clear reservation rejects same-collection writes but leaves other collections writable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'threadshelf-clear-reservation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = worker(root, 'clear');
  t.after(owner.stop);
  assert.equal((await owner.message).state, 'owned');
  const blocked = worker(root, 'write');
  t.after(blocked.stop);
  assert.equal((await blocked.message).code, 'COLLECTION_BUSY');
  const independent = worker(root, 'write', 'beta');
  t.after(independent.stop);
  assert.equal((await independent.message).state, 'written');
  assert.equal((await independent.exit).code, 0);
  await owner.stop();
  const recovered = worker(root, 'write');
  t.after(recovered.stop);
  assert.equal((await recovered.message).state, 'written');
});

test(
  'server guard canonicalizes a symlinked database location',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-server-alias-'));
    const alias = `${root}-alias`;
    t.after(async () => {
      await rm(alias, { force: true });
      await rm(root, { recursive: true, force: true });
    });
    await symlink(root, alias, 'dir');
    const owner = worker(root, 'server');
    t.after(owner.stop);
    assert.equal((await owner.message).state, 'owned');
    const duplicate = worker(alias, 'server');
    t.after(duplicate.stop);
    assert.equal((await duplicate.message).state, 'rejected');
  },
);

test('ordinary mutation guards coexist so existing write locks can serialize concurrent edits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'threadshelf-shared-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = worker(root, 'hold-write');
  t.after(owner.stop);
  assert.equal((await owner.message).state, 'owned');
  const other = worker(root, 'write');
  t.after(other.stop);
  assert.equal((await other.message).state, 'written');
  assert.equal((await other.exit).code, 0);
});

test('cancellation interrupts a clear job waiting for an existing mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'threadshelf-clear-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = worker(root, 'hold-write');
  t.after(owner.stop);
  assert.equal((await owner.message).state, 'owned');
  const started = Date.now();
  const waiting = worker(root, 'clear-cancel');
  t.after(waiting.stop);
  assert.equal((await waiting.message).state, 'rejected');
  assert.ok(
    Date.now() - started < 5000,
    'Cancellation must not wait for the 30-second lock timeout',
  );
});

test('a detached callback cannot reuse an expired clear reservation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'threadshelf-expired-clear-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stale = worker(root, 'expired-clear');
  t.after(stale.stop);
  assert.equal((await stale.message).state, 'released');
  const next = worker(root, 'clear');
  t.after(next.stop);
  assert.equal((await next.message).state, 'owned');
  const reply = new Promise((resolve) => stale.child.once('message', resolve));
  stale.child.send('continue');
  assert.equal((await reply).code, 'COLLECTION_BUSY');
});
