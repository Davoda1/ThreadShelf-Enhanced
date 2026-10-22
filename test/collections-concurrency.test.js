import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve('tsx')).href;
const workerPath = fileURLToPath(new URL('./shared/collections-worker.mjs', import.meta.url));
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const childCleanups = new Map();

const temporaryRoot = async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'threadshelf-collections-'));
  const cleanups = [];
  childCleanups.set(root, cleanups);
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    childCleanups.delete(root);
    await rm(root, { recursive: true, force: true });
  });
  return root;
};

const startWorker = async (
  t,
  root,
  { operations = [], mode = 'registry', env = {}, cwd = root } = {},
) => {
  await mkdir(cwd, { recursive: true });
  const data = join(root, 'data');
  const child = spawn(
    process.execPath,
    ['--import', loader, workerPath, mode, JSON.stringify(operations)],
    {
      cwd,
      env: {
        ...process.env,
        THREADSHELF_DATA_DIR: data,
        COLLECTIONS_PATH: join(data, 'collections.json'),
        LANCEDB_PATH: join(data, 'lancedb'),
        UPLOADS_DIR: '',
        GENERATION_CONFIG_PATH: join(data, 'generation.json'),
        MASTER_PROMPTS_PATH: join(data, 'master-prompts.json'),
        THREADSHELF_TOOLS_PATH: join(data, 'tools'),
        THREADSHELF_MODELS_PATH: join(data, 'models'),
        THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS: '1',
        OPENROUTER_API_KEY: '',
        THREADSHELF_API_KEY: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = (output + String(chunk)).slice(-65536);
  });
  child.stderr.on('data', (chunk) => {
    output = (output + String(chunk)).slice(-65536);
  });
  const messages = [];
  child.on('message', (message) => messages.push(message));
  let exited = false;
  const finished = new Promise((resolve) => {
    child.once('error', (error) => {
      exited = true;
      resolve({ error });
    });
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  childCleanups.get(root).push(async () => {
    if (!exited) child.kill('SIGKILL');
    await finished;
  });
  const waitFor = async (kind) => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const message = messages.find((value) => value.kind === kind);
      if (message) return message;
      if (exited || Date.now() > deadline)
        throw new Error(`Fixture did not send ${kind}: ${output}`);
      await sleep(10);
    }
  };
  const ready = await waitFor('ready');
  return {
    ...ready,
    run: async () => {
      child.send({ command: 'run' });
      const result = await waitFor('result');
      assert.deepEqual(await finished, { code: 0, signal: null }, output);
      return result.results;
    },
    stop: async () => {
      if (!exited) child.send({ command: 'stop' });
      assert.deepEqual(await finished, { code: 0, signal: null }, output);
    },
  };
};

const readRegistry = async (root, path = join(root, 'data', 'collections.json')) =>
  JSON.parse(await readFile(path, 'utf8')).collections;
const assertSuccessful = (results) => {
  for (const result of results.flat()) assert.equal(result.status, 'fulfilled', result.error);
};
const addOperations = (prefix, count) =>
  Array.from({ length: count }, (_, index) => ({
    operation: 'add',
    name: `${prefix}_${String(index).padStart(2, '0')}`,
  }));

describe('collection registry concurrency and preservation', () => {
  it('persists every successful concurrent creation within one process', async (t) => {
    const root = await temporaryRoot(t);
    const operations = addOperations('single', 20);
    const worker = await startWorker(t, root, { operations });
    assertSuccessful(await worker.run());
    assert.deepEqual(
      await readRegistry(root),
      operations.map(({ name }) => name),
    );
  });

  it('serializes separate processes, keeps unrelated entries, and publishes complete JSON', async (t) => {
    const root = await temporaryRoot(t);
    const registry = join(root, 'data', 'collections.json');
    await mkdir(dirname(registry), { recursive: true });
    const oldNames = Array.from({ length: 20 }, (_, index) => `old_${index}`);
    await writeFile(registry, JSON.stringify({ collections: ['untouched', ...oldNames] }));
    const operationGroups = Array.from({ length: 4 }, (_, worker) => [
      ...addOperations(`process_${worker}`, 10),
      { operation: 'add', name: 'shared_name' },
      ...oldNames.slice(worker * 5, worker * 5 + 5).map((name) => ({ operation: 'remove', name })),
    ]);
    const workers = await Promise.all(
      operationGroups.map((operations) => startWorker(t, root, { operations })),
    );
    let running = true;
    let observations = 0;
    const observe = (async () => {
      while (running) {
        const value = await readRegistry(root);
        assert.ok(value.includes('untouched'));
        assert.ok(value.every((name) => typeof name === 'string'));
        observations++;
        await sleep(1);
      }
    })();
    let results;
    try {
      results = await Promise.all(workers.map((worker) => worker.run()));
    } finally {
      running = false;
      await observe;
    }
    assertSuccessful(results);
    assert.ok(observations > 0);
    const expected = [
      'untouched',
      'shared_name',
      ...operationGroups
        .flat()
        .filter((op) => op.operation === 'add' && op.name !== 'shared_name')
        .map((op) => op.name),
    ].sort();
    assert.deepEqual(await readRegistry(root), expected);
    assert.equal(
      (await readdir(dirname(registry))).filter((name) => name.endsWith('.tmp')).length,
      0,
    );
  });

  it('creates a custom registry parent without losing the configured location', async (t) => {
    const root = await temporaryRoot(t);
    const registry = join(root, 'separate', 'nested', 'registry.json');
    const worker = await startWorker(t, root, {
      env: { COLLECTIONS_PATH: registry },
      operations: addOperations('custom', 3),
    });
    assertSuccessful(await worker.run());
    assert.equal((await readRegistry(root, registry)).length, 3);
    assert.equal(existsSync(join(root, 'data', 'collections.json')), false);
  });

  for (const [label, raw] of [
    ['malformed JSON', '{"collections":["preserved"'],
    ['invalid entry types', '{"collections":["preserved",5]}'],
    ['missing collection array', '{"unrelated":"preserved"}'],
  ]) {
    it(`preserves ${label} and rejects mutations instead of replacing it`, async (t) => {
      const root = await temporaryRoot(t);
      const registry = join(root, 'data', 'collections.json');
      await mkdir(dirname(registry), { recursive: true });
      await writeFile(registry, raw);
      const worker = await startWorker(t, root, {
        operations: [
          { operation: 'add', name: 'new' },
          { operation: 'remove', name: 'preserved' },
          { operation: 'write', names: ['replacement'] },
        ],
      });
      const results = await worker.run();
      assert.ok(results.every((result) => result.status === 'rejected'));
      assert.equal(await readFile(registry, 'utf8'), raw);
    });
  }

  it('keeps a configured registry symlink and serializes its target alias', async (t) => {
    const root = await temporaryRoot(t);
    const target = join(root, 'data', 'collections.json');
    const alias = join(root, 'registry-link.json');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '{"collections":[]}');
    try {
      await symlink(target, alias, 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code))
        return t.skip('File symlink creation is unavailable for this Windows account');
      throw error;
    }
    const workers = await Promise.all([
      startWorker(t, root, { operations: addOperations('target', 10) }),
      startWorker(t, root, {
        env: { COLLECTIONS_PATH: alias },
        operations: addOperations('alias', 10),
      }),
    ]);
    assertSuccessful(await Promise.all(workers.map((worker) => worker.run())));
    assert.equal((await readRegistry(root)).length, 20);
    assert.deepEqual(await readRegistry(root, alias), await readRegistry(root));
    const { lstat } = await import('node:fs/promises');
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
  });
});

describe('collection registry atomic replacement failures', () => {
  const runFault = async (t, fault) => {
    const root = await temporaryRoot(t);
    const registry = join(root, 'data', 'collections.json');
    await mkdir(dirname(registry), { recursive: true });
    await writeFile(registry, JSON.stringify({ collections: ['preserved'] }));
    const worker = await startWorker(t, root, { mode: 'registry-rename', operations: fault });
    const result = await worker.run();
    assert.equal(result.temporaryFiles.length, 0, 'publication must clean its temporary file');
    for (const snapshot of result.snapshots) {
      assert.deepEqual(snapshot.destination, { collections: ['preserved'] });
      assert.deepEqual(snapshot.temporary, { collections: ['new_entry', 'preserved'] });
    }
    return result;
  };

  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    it(`retries transient Windows ${code} without removing the previous registry`, async (t) => {
      const result = await runFault(t, { platform: 'win32', code, failures: 3 });
      assert.deepEqual(result.outcome, { status: 'fulfilled' });
      assert.ok(result.attempts >= 4, 'all three injected failures must be retried');
      assert.deepEqual(result.after, ['new_entry', 'preserved']);
      assert.deepEqual(result.followup, ['followup', 'new_entry', 'preserved']);
    });
  }

  for (const [label, fault] of [
    ['POSIX permission errors', { platform: 'linux', code: 'EPERM', failures: 1 }],
    ['nontransient Windows errors', { platform: 'win32', code: 'ENOSPC', failures: 1 }],
  ]) {
    it(`immediately propagates ${label} and preserves the previous registry`, async (t) => {
      const result = await runFault(t, fault);
      assert.deepEqual(result.outcome, {
        status: 'rejected',
        code: fault.code,
        originalError: true,
      });
      assert.equal(result.attempts, 1);
      assert.deepEqual(result.after, ['preserved']);
      assert.deepEqual(result.followup, ['followup', 'preserved']);
    });
  }

  it('bounds permanent Windows denial and releases the lock without replacing the registry', async (t) => {
    const result = await runFault(t, {
      platform: 'win32',
      code: 'EPERM',
      failures: 1000,
      advanceClockMs: 2000,
    });
    assert.deepEqual(result.outcome, { status: 'rejected', code: 'EPERM', originalError: true });
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.after, ['preserved']);
    assert.deepEqual(result.followup, ['followup', 'preserved']);
  });
});

describe('collection HTTP deletion shares the ingestion upload resolver', () => {
  for (const override of ['unset', 'absolute', 'relative']) {
    it(`deletes the actual uploaded source with ${override} UPLOADS_DIR and preserves a cwd decoy`, async (t) => {
      const root = await temporaryRoot(t);
      const cwd = join(root, 'unrelated-working-directory');
      const uploads =
        override === 'unset'
          ? join(root, 'data', 'uploads')
          : override === 'absolute'
            ? join(root, 'configured-uploads')
            : join(cwd, 'relative-uploads');
      const env = {
        UPLOADS_DIR:
          override === 'unset' ? '' : override === 'absolute' ? uploads : 'relative-uploads',
      };
      const worker = await startWorker(t, root, { mode: 'http', cwd, env });
      const collection = 'audit_delete';
      const decoy = join(cwd, '.uploads', collection, 'keep.txt');
      await mkdir(dirname(decoy), { recursive: true });
      await writeFile(decoy, 'Synthetic unrelated file');
      const form = new FormData();
      form.append('collectionName', collection);
      form.append(
        'folder/empty.json',
        new Blob(['[]'], { type: 'application/json' }),
        'empty.json',
      );
      const upload = await fetch(`${worker.baseUrl}/api/ingest-upload`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(upload.status, 200, await upload.text());
      const uploaded = join(uploads, collection, 'empty.json');
      assert.equal(await readFile(uploaded, 'utf8'), '[]');
      const created = await fetch(`${worker.baseUrl}/api/collections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: collection }),
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(created.status, 200);
      const deleted = await fetch(`${worker.baseUrl}/api/collections/${collection}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(deleted.status, 200);
      assert.deepEqual(await deleted.json(), { ok: true, collection });
      assert.equal(existsSync(join(uploads, collection)), false);
      assert.equal(await readFile(decoy, 'utf8'), 'Synthetic unrelated file');
      assert.equal((await readRegistry(root)).includes(collection), false);
      await worker.stop();
    });
  }

  it('keeps normalized traversal names inside uploads and rejects protected collections', async (t) => {
    const root = await temporaryRoot(t);
    const worker = await startWorker(t, root, { mode: 'http' });
    const outside = join(root, 'data', 'outside', 'keep.txt');
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, 'Preserved outside upload root');
    const normalized = await fetch(`${worker.baseUrl}/api/collections/..%2Foutside`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(normalized.status, 200);
    assert.deepEqual(await normalized.json(), { ok: true, collection: 'outside' });
    assert.equal(await readFile(outside, 'utf8'), 'Preserved outside upload root');
    for (const name of ['all', 'chunks', 'threadshelf_conversations']) {
      const response = await fetch(`${worker.baseUrl}/api/collections/${name}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(response.status, 400, name);
    }
    await worker.stop();
  });

  it('preserves uploads when the registry is corrupt and releases failed mutation locks', async (t) => {
    const root = await temporaryRoot(t);
    const registry = join(root, 'data', 'collections.json');
    const uploaded = join(root, 'data', 'uploads', 'preserved', 'source.json');
    await mkdir(dirname(uploaded), { recursive: true });
    await writeFile(uploaded, '[]');
    await writeFile(registry, '{broken registry');
    const worker = await startWorker(t, root, { mode: 'http' });
    const deleted = await fetch(`${worker.baseUrl}/api/collections/preserved`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(deleted.status, 500);
    assert.equal(await readFile(uploaded, 'utf8'), '[]');
    assert.equal(await readFile(registry, 'utf8'), '{broken registry');
    const create = () =>
      fetch(`${worker.baseUrl}/api/collections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'after_repair' }),
        signal: AbortSignal.timeout(30000),
      });
    assert.equal((await create()).status, 500);
    await writeFile(registry, '{"collections":["preserved"]}');
    assert.equal((await create()).status, 200);
    assert.deepEqual(await readRegistry(root), ['after_repair', 'preserved']);
    await worker.stop();
  });
});
