import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startApiServer, stopChildProcess } from './helpers.js';

const workerPath = fileURLToPath(
  new URL('../shared/indexing-coordinator-worker.js', import.meta.url),
);
const waitForJob = async (url, id, states = ['completed', 'failed', 'cancelled']) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/import-jobs/${id}`);
    assert.equal(response.status, 200);
    const job = await response.json();
    if (states.includes(job.state)) return job;
    await delay(50);
  }
  assert.fail('Durable import job did not reach its expected state');
};

const holdIndexer = async (database) => {
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath, 'index'], {
    env: { ...process.env, LANCEDB_PATH: database },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Could not hold synthetic indexer lock')),
      10_000,
    );
    child.once('message', (message) => {
      clearTimeout(timeout);
      message.state === 'owned' ? resolve() : reject(new Error(JSON.stringify(message)));
    });
    child.once('error', reject);
  });
  return child;
};

const upload = async (url, text, collection = 'durable', clearFirst = false) => {
  const form = new FormData();
  form.append('synthetic/notes.json', new Blob([text], { type: 'application/json' }), 'notes.json');
  form.append('collectionName', collection);
  form.append('clearFirst', String(clearFirst));
  const response = await fetch(`${url}/api/import-jobs/upload`, { method: 'POST', body: form });
  assert.equal(response.status, 202, await response.clone().text());
  return (await response.json()).job;
};

test(
  'closing a legacy progress connection after acceptance does not cancel a recognized export',
  { timeout: 180_000 },
  async (t) => {
    const ctx = await startApiServer({ prefix: 'threadshelf-detached-import-' });
    t.after(ctx.stop);
    const form = new FormData();
    form.append(
      'synthetic/conversations.json',
      new Blob(
        [
          JSON.stringify([
            {
              id: 'detached-synthetic-conversation',
              title: 'Synthetic bicycle maintenance',
              current_node: 'answer',
              mapping: {
                prompt: {
                  id: 'prompt',
                  parent: null,
                  message: {
                    author: { role: 'user' },
                    content: { parts: ['How should a bicycle chain be maintained?'] },
                  },
                },
                answer: {
                  id: 'answer',
                  parent: 'prompt',
                  message: {
                    author: { role: 'assistant' },
                    content: { parts: ['Clean and lubricate the bicycle chain regularly.'] },
                  },
                },
              },
            },
          ]),
        ],
        { type: 'application/json' },
      ),
      'conversations.json',
    );
    form.append('collectionName', 'detached');
    const response = await fetch(`${ctx.baseUrl}/api/ingest-upload-progress`, {
      method: 'POST',
      body: form,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('\n')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    const accepted = JSON.parse(text.split('\n')[0]);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.safeToClose, true);
    await reader.cancel();
    const job = await waitForJob(ctx.baseUrl, accepted.jobId);
    assert.equal(job.state, 'completed', job.error);
    assert.equal(job.progress.progressPercent, 100);
    const metadata = new DatabaseSync(
      join(ctx.tempRoot, '.lancedb', '.import-jobs', 'jobs.sqlite'),
      { readOnly: true },
    );
    try {
      const persisted = JSON.parse(
        metadata.prepare('SELECT value FROM jobs WHERE id=?').get(job.id).value,
      );
      assert.equal(
        persisted.progress.progressPercent,
        100,
        'completion is persisted, not only formatted by the API',
      );
    } finally {
      metadata.close();
    }
    assert.equal(job.result.conversations, 1);
    assert.equal(job.result.ingested, 2);
    const files = await (await fetch(`${ctx.baseUrl}/api/files?collection=detached`)).json();
    assert.equal(files.files.length, 1);
    assert.equal(
      files.files[0].sourceFile,
      join(ctx.tempRoot, '.uploads', 'detached', 'conversations.json'),
    );
    const sourceBytes = await readFile(files.files[0].sourceFile);
    const query = new URLSearchParams({
      collection: 'detached',
      sourceFile: files.files[0].sourceFile,
      conversationKey: files.files[0].conversationKey,
    });
    const thread = await (await fetch(`${ctx.baseUrl}/api/thread?${query}`)).json();
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/import-jobs/${job.id}`, { method: 'DELETE' })).status,
      200,
    );
    assert.equal((await fetch(`${ctx.baseUrl}/api/import-jobs/${job.id}`)).status, 404);
    assert.deepEqual(
      await (await fetch(`${ctx.baseUrl}/api/files?collection=detached`)).json(),
      files,
    );
    assert.deepEqual(await (await fetch(`${ctx.baseUrl}/api/thread?${query}`)).json(), thread);
    assert.deepEqual(await readFile(files.files[0].sourceFile), sourceBytes);
  },
);

test(
  'accepted uploads have independent snapshots and survive closing their client and restarting the server',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-durable-jobs-'));
    const db = join(root, 'db');
    t.after(() => rm(root, { recursive: true, force: true }));
    const blocker = await holdIndexer(db);
    t.after(() => stopChildProcess(blocker));
    const env = {
      LANCEDB_PATH: db,
      UPLOADS_DIR: join(root, 'uploads'),
      COLLECTIONS_PATH: join(root, 'collections.json'),
    };
    const firstServer = await startApiServer({ prefix: 'threadshelf-job-server-', env });
    t.after(firstServer.stop);
    await mkdir(join(root, 'uploads', 'durable'), { recursive: true });
    await writeFile(join(root, 'uploads', 'durable', 'notes.json'), '{"archived":"untouched"}');
    // Deliberately unsupported JSON exercises the real durable pipeline without
    // relying on model downloads; recognized-conversation tests live separately.
    const first = await upload(firstServer.baseUrl, '{"ordinary_note":"first"}');
    const second = await upload(firstServer.baseUrl, '{"ordinary_note":"second"}');
    assert.equal(first.safeToClose, true);
    assert.notEqual(first.id, second.id);
    assert.equal(
      await readFile(join(db, '.import-jobs', first.id, 'input', 'notes.json'), 'utf8'),
      '{"ordinary_note":"first"}',
    );
    assert.equal(
      await readFile(join(db, '.import-jobs', second.id, 'input', 'notes.json'), 'utf8'),
      '{"ordinary_note":"second"}',
    );
    assert.equal((await waitForJob(firstServer.baseUrl, first.id, ['queued'])).state, 'queued');
    firstServer.server.kill('SIGKILL');
    await stopChildProcess(firstServer.server);

    const restarted = await startApiServer({ prefix: 'threadshelf-job-restart-', env });
    t.after(restarted.stop);
    const listed = await (
      await fetch(`${restarted.baseUrl}/api/import-jobs?collection=durable`)
    ).json();
    assert.equal(listed.jobs.length, 2);
    assert.equal(
      listed.jobs.every((job) => job.state === 'queued'),
      true,
    );
    await stopChildProcess(blocker);
    const firstDone = await waitForJob(restarted.baseUrl, first.id);
    const secondDone = await waitForJob(restarted.baseUrl, second.id);
    assert.equal(firstDone.state, 'completed', firstDone.error);
    assert.equal(secondDone.state, 'completed', secondDone.error);
    assert.equal(firstDone.result.conversations, 0);
    assert.ok(firstDone.result.skippedFiles.length);
    assert.equal(
      await readFile(join(root, 'uploads', 'durable', 'notes.json'), 'utf8'),
      '{"archived":"untouched"}',
    );
  },
);

test(
  'queued jobs support explicit cancellation and retry, and reject modified staged input',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-job-controls-'));
    const db = join(root, 'db');
    t.after(() => rm(root, { recursive: true, force: true }));
    const blocker = await holdIndexer(db);
    t.after(() => stopChildProcess(blocker));
    const ctx = await startApiServer({
      env: {
        LANCEDB_PATH: db,
        UPLOADS_DIR: join(root, 'uploads'),
        COLLECTIONS_PATH: join(root, 'collections.json'),
      },
    });
    t.after(ctx.stop);
    const accepted = await upload(ctx.baseUrl, '{"ordinary_note":"kept"}');
    const cancelled = await fetch(`${ctx.baseUrl}/api/import-jobs/${accepted.id}/cancel`, {
      method: 'POST',
    });
    assert.equal((await cancelled.json()).job.state, 'cancelled');
    const retry = await fetch(`${ctx.baseUrl}/api/import-jobs/${accepted.id}/retry`, {
      method: 'POST',
    });
    assert.equal(retry.status, 202);
    assert.equal((await retry.json()).job.state, 'queued');
    await writeFile(
      join(db, '.import-jobs', accepted.id, 'input', 'notes.json'),
      '{"ordinary_note":"changed"}',
    );
    await stopChildProcess(blocker);
    const result = await waitForJob(ctx.baseUrl, accepted.id);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /checksum verification/);
    assert.notEqual(result.progress?.progressPercent, 100, 'failed work must not claim completion');
  },
);

test(
  'an interrupted running replacement retains its reservation and resumes from verified input',
  { timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-running-recovery-'));
    const db = join(root, 'db');
    t.after(() => rm(root, { recursive: true, force: true }));
    const env = {
      LANCEDB_PATH: db,
      UPLOADS_DIR: join(root, 'uploads'),
      COLLECTIONS_PATH: join(root, 'collections.json'),
    };
    const firstServer = await startApiServer({ prefix: 'threadshelf-running-job-', env });
    t.after(firstServer.stop);
    const source = JSON.stringify(
      Array.from({ length: 40 }, (_, index) => ({
        conversationKey: `synthetic-resume-${index}`,
        title: `Synthetic resume ${index}`,
        turns: [
          { user: `How should bicycle ${index} be maintained?` },
          { ai: `Clean and lubricate bicycle ${index} regularly.` },
        ],
      })),
    );
    const accepted = await upload(firstServer.baseUrl, source, 'recovering', true);
    const active = await waitForJob(firstServer.baseUrl, accepted.id, ['running', 'paused']);
    assert.equal(active.collectionLocked, true);
    firstServer.server.kill('SIGKILL');
    await stopChildProcess(firstServer.server);

    const probe = spawn(process.execPath, ['--import', 'tsx', workerPath, 'write', 'recovering'], {
      env: { ...process.env, LANCEDB_PATH: db },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    t.after(() => stopChildProcess(probe));
    const rejected = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Reservation probe timed out')), 10_000);
      probe.once('message', (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      probe.once('error', reject);
    });
    assert.equal(rejected.code, 'COLLECTION_BUSY');
    await stopChildProcess(probe);

    const restarted = await startApiServer({ prefix: 'threadshelf-resumed-job-', env });
    t.after(restarted.stop);
    const completed = await waitForJob(restarted.baseUrl, accepted.id);
    assert.equal(completed.state, 'completed', completed.error);
    assert.equal(completed.result.conversations, 40);
    assert.equal(completed.attempts, 2);
    assert.equal(completed.collectionLocked, false);
  },
);

test(
  'folder jobs reject canonical paths containing their own job storage',
  { skip: process.platform === 'win32', timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-source-containment-'));
    const alias = `${root}-alias`;
    const { symlink } = await import('node:fs/promises');
    const ctx = await startApiServer({
      env: {
        LANCEDB_PATH: join(root, '..data', 'db'),
        UPLOADS_DIR: join(root, 'uploads'),
        COLLECTIONS_PATH: join(root, 'collections.json'),
      },
    });
    t.after(ctx.stop);
    t.after(async () => {
      await rm(alias, { force: true });
      await rm(root, { recursive: true, force: true });
    });
    await symlink(root, alias, 'dir');
    for (const folderPath of [root, alias]) {
      const response = await fetch(`${ctx.baseUrl}/api/import-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath, collection: 'containment' }),
      });
      assert.equal(response.ok, false);
      assert.match((await response.json()).error, /separate directories/);
    }
  },
);

test(
  'deletion cancels queued jobs before a worker can claim them without stopping unrelated jobs',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-delete-queued-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const db = join(root, 'db');
    const blocker = await holdIndexer(db);
    t.after(() => stopChildProcess(blocker));
    const ctx = await startApiServer({
      env: {
        LANCEDB_PATH: db,
        UPLOADS_DIR: join(root, 'uploads'),
        COLLECTIONS_PATH: join(root, 'collections.json'),
      },
    });
    t.after(ctx.stop);
    const source = JSON.stringify([{ conversationKey: 'queued-deletion', turns: [{ user: '?' }] }]);
    const removed = await upload(ctx.baseUrl, source, 'deleted_queue');
    const retained = await upload(ctx.baseUrl, source, 'retained_queue');
    const response = await fetch(`${ctx.baseUrl}/api/collections/deleted_queue`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal((await waitForJob(ctx.baseUrl, removed.id)).state, 'cancelled');
    assert.equal((await waitForJob(ctx.baseUrl, retained.id, ['queued'])).state, 'queued');
    await stopChildProcess(blocker);
    assert.equal((await waitForJob(ctx.baseUrl, retained.id)).state, 'completed');
    assert.equal((await waitForJob(ctx.baseUrl, removed.id)).state, 'cancelled');
    await assert.rejects(readFile(join(root, 'uploads', 'deleted_queue', 'notes.json')), {
      code: 'ENOENT',
    });
    assert.equal(
      await readFile(join(root, 'uploads', 'retained_queue', 'notes.json'), 'utf8'),
      source,
    );
    const files = await (await fetch(`${ctx.baseUrl}/api/files?collection=deleted_queue`)).json();
    assert.deepEqual(files.files, []);
  },
);

test(
  'finished history removal persists, covers all pages, preserves active jobs and serializes retry races',
  { timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-job-history-'));
    const dbRoot = join(root, 'db');
    const blocker = await holdIndexer(dbRoot);
    const servers = [];
    t.after(async () => {
      for (const server of servers) await server.stop();
      await stopChildProcess(blocker);
      await rm(root, { recursive: true, force: true });
    });
    const env = {
      LANCEDB_PATH: dbRoot,
      UPLOADS_DIR: join(root, 'uploads'),
      COLLECTIONS_PATH: join(root, 'collections.json'),
    };
    const ctx = await startApiServer({ prefix: 'threadshelf-history-server-', env });
    servers.push(ctx);
    assert.equal((await fetch(`${ctx.baseUrl}/api/import-jobs`)).status, 200);
    const databasePath = join(dbRoot, '.import-jobs', 'jobs.sqlite');
    const sourceFile = join(root, 'uploads', 'history', 'retained.json');
    await mkdir(join(root, 'uploads', 'history'), { recursive: true });
    await writeFile(sourceFile, 'Synthetic published source stays intact');
    const seeds = [];
    const seed = async (state, collection = 'history', progressPercent = 42) => {
      const id = randomUUID();
      const job = {
        id,
        collection,
        kind: 'upload',
        state,
        clearFirst: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        cancelRequested: state === 'cancelled',
        attempts: 1,
        safeToClose: true,
        collectionLocked: false,
        sourceRoot: join(root, 'uploads', collection),
        inputReady: true,
        progress: {
          status: 'progress',
          phase: 'indexing',
          progressPercent,
          totalFiles: 1,
          processedFiles: 0,
          totalChunks: 0,
          totalTokens: 0,
          elapsedMs: 1,
        },
      };
      const input = join(dbRoot, '.import-jobs', id, 'input', 'retained.json');
      await mkdir(join(dbRoot, '.import-jobs', id, 'input'), { recursive: true });
      await writeFile(input, 'Synthetic retry-only input');
      const db = new DatabaseSync(databasePath);
      try {
        db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        db.prepare(
          'INSERT INTO jobs(id,collection,clearFirst,state,createdAt,updatedAt,value) VALUES(?,?,?,?,?,?,?)',
        ).run(id, collection, 1, state, job.createdAt, job.updatedAt, JSON.stringify(job));
        db.prepare('INSERT INTO input_files(jobId,relativePath,size,sha256) VALUES(?,?,?,?)').run(
          id,
          'retained.json',
          26,
          'synthetic',
        );
        db.exec('COMMIT');
      } finally {
        db.close();
      }
      seeds.push({ id, input, state, collection });
      return { id, input, state, collection };
    };
    const remove = (id) => fetch(`${ctx.baseUrl}/api/import-jobs/${id}`, { method: 'DELETE' });
    const get = async (id, base = ctx.baseUrl) => {
      const response = await fetch(`${base}/api/import-jobs/${id}`);
      return { status: response.status, job: await response.json() };
    };
    const protectedJobs = [];
    for (const state of ['queued', 'running', 'paused', 'interrupted']) {
      const entry = await seed(state, `protected_${state}`);
      protectedJobs.push(entry);
      assert.equal((await remove(entry.id)).status, 409, state);
      assert.equal((await get(entry.id)).job.state, state);
      assert.equal(await readFile(entry.input, 'utf8'), 'Synthetic retry-only input');
    }
    for (let index = 0; index < 105; index++)
      await seed(['completed', 'failed', 'cancelled'][index % 3]);
    const other = await seed('failed', 'other_history', 37);
    assert.equal(
      (await get(other.id)).job.progress.progressPercent,
      37,
      'failed progress is not rewritten to 100',
    );
    const listed = await (await fetch(`${ctx.baseUrl}/api/import-jobs?collection=history`)).json();
    assert.equal(listed.jobs.length, 100, 'fixture exceeds both the 20-row UI and 100-row listing');
    const cleared = await fetch(`${ctx.baseUrl}/api/import-jobs?collection=history`, {
      method: 'DELETE',
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { deleted: 105 });
    for (const entry of seeds.filter((item) => item.collection === 'history')) {
      assert.equal((await get(entry.id)).status, 404);
      await assert.rejects(readFile(entry.input), { code: 'ENOENT' });
    }
    assert.equal((await get(other.id)).status, 200, 'collection filter preserves other history');
    assert.equal((await remove(randomUUID())).status, 404);
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/import-jobs?collection[]=history`, { method: 'DELETE' }))
        .status,
      400,
    );
    const races = [];
    for (let index = 0; index < 12; index++) {
      const entry = await seed('failed', `race_${index}`);
      const bulk = index % 2 === 1;
      const [removed, retried] = await Promise.all([
        bulk
          ? fetch(`${ctx.baseUrl}/api/import-jobs?collection=${entry.collection}`, {
              method: 'DELETE',
            })
          : remove(entry.id),
        fetch(`${ctx.baseUrl}/api/import-jobs/${entry.id}/retry`, { method: 'POST' }),
      ]);
      const removedBody = await removed.json();
      if (retried.status === 202) {
        assert.equal(removed.status, bulk ? 200 : 409, 'a retried queued job cannot be removed');
        if (bulk) assert.equal(removedBody.deleted, 0);
        assert.equal((await get(entry.id)).job.state, 'queued');
        assert.equal(await readFile(entry.input, 'utf8'), 'Synthetic retry-only input');
        races.push(entry);
      } else {
        assert.equal(removed.status, 200);
        assert.equal(removedBody.deleted, bulk ? 1 : true);
        assert.ok([404, 409].includes(retried.status));
        assert.equal((await get(entry.id)).status, 404);
        await assert.rejects(readFile(entry.input), { code: 'ENOENT' });
      }
    }
    const retriedFirst = await seed('failed', 'retried_first');
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/import-jobs/${retriedFirst.id}/retry`, { method: 'POST' }))
        .status,
      202,
    );
    assert.equal((await remove(retriedFirst.id)).status, 409);
    races.push(retriedFirst);
    const global = await fetch(`${ctx.baseUrl}/api/import-jobs`, { method: 'DELETE' });
    assert.equal(global.status, 200);
    assert.deepEqual(await global.json(), { deleted: 1 });
    for (const entry of protectedJobs) assert.equal((await get(entry.id)).job.state, entry.state);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM jobs WHERE state IN ('completed','failed','cancelled')",
            )
            .get().count,
        ),
        0,
      );
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS count FROM input_files').get().count),
        protectedJobs.length + races.length,
      );
    } finally {
      db.close();
    }
    await ctx.stop();
    // A crash after committing history removal can leave retry-input cleanup pending.
    const orphan = randomUUID();
    const pendingInput = join(dbRoot, '.import-jobs', orphan, 'input', 'retry.json');
    await mkdir(join(dbRoot, '.import-jobs', orphan, 'input'), { recursive: true });
    await writeFile(pendingInput, 'Synthetic cleanup checkpoint');
    const pendingDb = new DatabaseSync(databasePath);
    try {
      pendingDb.prepare('INSERT INTO job_history_cleanup(id) VALUES(?)').run(orphan);
    } finally {
      pendingDb.close();
    }
    const restarted = await startApiServer({ prefix: 'threadshelf-history-restart-', env });
    servers.push(restarted);
    assert.equal((await get(other.id, restarted.baseUrl)).status, 404);
    for (const entry of protectedJobs)
      assert.equal((await get(entry.id, restarted.baseUrl)).job.state, entry.state);
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await readFile(pendingInput);
      } catch (error) {
        assert.equal(error.code, 'ENOENT');
        break;
      }
      assert.ok(Date.now() < deadline, 'restart must retry committed cleanup');
      await delay(20);
    }
    assert.equal(await readFile(sourceFile, 'utf8'), 'Synthetic published source stays intact');
  },
);
