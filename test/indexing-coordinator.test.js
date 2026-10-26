import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopChildProcess } from './shared/helpers.js';

const fixtures = new WeakMap();
const temporaryRoot = async (t, prefix) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const fixture = { children: [], paths: [root] };
  fixtures.set(t, fixture);
  t.after(async () => {
    // Windows keeps SQLite sidecars locked until their owning workers exit.
    // A failed earlier after-hook also skips later hooks, so own cleanup here.
    const stopped = await Promise.allSettled(
      fixture.children.map((child) => stopChildProcess(child)),
    );
    const failures = stopped.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Coordinator workers failed to stop',
      );
    for (const path of fixture.paths.reverse()) await rm(path, { recursive: true, force: true });
    fixtures.delete(t);
  });
  return root;
};

const workerPath = fileURLToPath(
  new URL('./shared/indexing-coordinator-worker.js', import.meta.url),
);
const worker = (t, root, mode, collection = 'alpha') => {
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath, mode, collection], {
    env: { ...process.env, LANCEDB_PATH: root },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  fixtures.get(t).children.push(child);
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
    stop: () => stopChildProcess(child),
  };
};

test(
  'one server and one indexer are enforced across processes, with release after termination',
  { timeout: 30_000 },
  async (t) => {
    const root = await temporaryRoot(t, 'threadshelf-coordinator-');
    const first = worker(t, root, 'server');
    assert.equal((await first.message).state, 'owned');
    const duplicate = worker(t, root, 'server');
    assert.match((await duplicate.message).message, /already running/);
    assert.equal((await duplicate.exit).code, 17);

    const importer = worker(t, root, 'index');
    assert.equal((await importer.message).state, 'owned');
    const secondImporter = worker(t, root, 'index', 'another');
    assert.equal((await secondImporter.message).code, 'INDEXING_BUSY');
    await importer.stop();
    const replacement = worker(t, root, 'nested');
    assert.equal((await replacement.message).state, 'written');
    assert.equal((await replacement.exit).code, 0);
  },
);

test(
  'clear reservation rejects same-collection writes but leaves other collections writable',
  { timeout: 30_000 },
  async (t) => {
    const root = await temporaryRoot(t, 'threadshelf-clear-reservation-');
    const owner = worker(t, root, 'clear');
    assert.equal((await owner.message).state, 'owned');
    const blocked = worker(t, root, 'write');
    assert.equal((await blocked.message).code, 'COLLECTION_BUSY');
    const independent = worker(t, root, 'write', 'beta');
    assert.equal((await independent.message).state, 'written');
    assert.equal((await independent.exit).code, 0);
    await owner.stop();
    const recovered = worker(t, root, 'write');
    assert.equal((await recovered.message).state, 'written');
  },
);

test(
  'server guard canonicalizes a symlinked database location',
  { skip: process.platform === 'win32', timeout: 30_000 },
  async (t) => {
    const root = await temporaryRoot(t, 'threadshelf-server-alias-');
    const alias = `${root}-alias`;
    fixtures.get(t).paths.push(alias);
    await symlink(root, alias, 'dir');
    const owner = worker(t, root, 'server');
    assert.equal((await owner.message).state, 'owned');
    const duplicate = worker(t, alias, 'server');
    assert.equal((await duplicate.message).state, 'rejected');
  },
);

test(
  'ordinary mutation guards coexist so existing write locks can serialize concurrent edits',
  { timeout: 30_000 },
  async (t) => {
    const root = await temporaryRoot(t, 'threadshelf-shared-guard-');
    const owner = worker(t, root, 'hold-write');
    assert.equal((await owner.message).state, 'owned');
    const other = worker(t, root, 'write');
    assert.equal((await other.message).state, 'written');
    assert.equal((await other.exit).code, 0);
  },
);

test(
  'cancellation interrupts a clear job waiting for an existing mutation',
  { timeout: 30_000 },
  async (t) => {
    const root = await temporaryRoot(t, 'threadshelf-clear-cancel-');
    const owner = worker(t, root, 'hold-write');
    assert.equal((await owner.message).state, 'owned');
    const started = Date.now();
    const waiting = worker(t, root, 'clear-cancel');
    assert.equal((await waiting.message).state, 'rejected');
    assert.ok(
      Date.now() - started < 5000,
      'Cancellation must not wait for the 30-second lock timeout',
    );
  },
);

test(
  'a detached callback cannot reuse an expired clear reservation',
  { timeout: 30_000 },
  async (t) => {
    const root = await temporaryRoot(t, 'threadshelf-expired-clear-');
    const stale = worker(t, root, 'expired-clear');
    assert.equal((await stale.message).state, 'released');
    const next = worker(t, root, 'clear');
    assert.equal((await next.message).state, 'owned');
    const reply = new Promise((resolve) => stale.child.once('message', resolve));
    stale.child.send('continue');
    assert.equal((await reply).code, 'COLLECTION_BUSY');
  },
);
