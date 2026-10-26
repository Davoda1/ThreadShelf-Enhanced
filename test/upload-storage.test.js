import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

let root;
let uploads;
let database;
let server;
let url;
let stopped;
let output = '';
const children = new Set();
const file = (name) => join(uploads, 'alpha', name);
const call = async (path = '/alpha', body, headers = {}) => {
  const response = await fetch(`${url}/api/uploads${path}`, {
    method: body === undefined ? 'GET' : 'DELETE',
    signal: AbortSignal.timeout(10_000),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
};
const spawnWorker = (path, args = [], env = {}) => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL(path, import.meta.url)), ...args],
    {
      env: {
        ...process.env,
        LANCEDB_PATH: database,
        UPLOADS_DIR: uploads,
        THREADSHELF_DATA_DIR: join(root, 'data'),
        COLLECTIONS_PATH: join(root, 'registry.json'),
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  child.stderr.on('data', (value) => {
    output += value;
  });
  const exit = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Upload test worker did not start: ${output}`)),
      15_000,
    );
    child.once('message', (value) => {
      clearTimeout(timeout);
      resolve(value);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Worker exited ${code}: ${output}`));
    });
  });
  const stop = async () => {
    if (child.exitCode === null) child.send('stop');
    await exit;
    children.delete(stop);
  };
  children.add(stop);
  return { child, ready, exit, stop };
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'threadshelf-upload-storage-'));
  uploads = join(root, 'custom-upload-root');
  database = join(root, 'archive');
  await mkdir(file('nested'), { recursive: true });
  await mkdir(join(uploads, '.incoming'), { recursive: true });
  await mkdir(join(uploads, 'beta'));
  await writeFile(file('one.json'), 'one');
  await writeFile(file('nested/two.json'), 'two two');
  await writeFile(file('image.png'), 'synthetic image');
  await writeFile(join(uploads, '.incoming', 'pending.json'), 'incomplete transfer');
  await writeFile(join(uploads, 'beta', 'other.json'), 'other collection');
  await mkdir(database);
  await writeFile(join(database, 'archive-sentinel'), 'conversations stay');
  await writeFile(join(root, 'registry.json'), '{"alpha":true}');
  server = spawnWorker('./shared/upload-storage-server.js');
  stopped = server.stop;
  url = `http://127.0.0.1:${(await server.ready).port}`;
});
after(async () => {
  for (const stop of [...children]) await stop();
  await rm(root, { recursive: true, force: true });
});

const seedJob = (
  id,
  state,
  { collection = 'alpha', sourceRoot = file(''), inputReady = false } = {},
) => {
  const db = new DatabaseSync(join(database, '.import-jobs', 'jobs.sqlite'));
  try {
    const value = {
      id,
      collection,
      kind: 'folder',
      state,
      clearFirst: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cancelRequested: false,
      attempts: 0,
      safeToClose: true,
      collectionLocked: false,
      sourceRoot,
      inputReady,
    };
    db.prepare(
      'INSERT OR REPLACE INTO jobs(id,collection,clearFirst,state,createdAt,updatedAt,value) VALUES(?,?,0,?,?,?,?)',
    ).run(id, collection, state, value.createdAt, value.updatedAt, JSON.stringify(value));
  } finally {
    db.close();
  }
};
const removeJobs = () => {
  const db = new DatabaseSync(join(database, '.import-jobs', 'jobs.sqlite'));
  try {
    db.exec('DELETE FROM jobs');
  } finally {
    db.close();
  }
};

test('custom upload root lists safe collection folders and paginates relative files', async () => {
  const collections = await call('');
  assert.equal(collections.status, 200);
  assert.deepEqual(collections.body, {
    collections: [{ collection: 'alpha' }, { collection: 'beta' }],
  });
  assert.equal(collections.headers.get('cache-control'), 'no-store');
  const seen = [];
  let cursor;
  do {
    const page = await call(`/alpha?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.files.length, 1);
    assert.equal(page.body.locked, false);
    assert.equal(typeof page.body.files[0].modifiedAt, 'number');
    assert.equal(typeof page.body.files[0].bytes, 'number');
    seen.push(page.body.files[0].path);
    cursor = page.body.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(seen.sort(), ['image.png', 'nested/two.json', 'one.json']);
  assert.equal((await call('/missing')).status, 404);
  for (const query of ['limit=0', 'limit=201', 'limit=x', 'cursor=-1', 'cursor=1e3', 'cursor[]=1'])
    assert.equal((await call(`/alpha?${query}`)).status, 400, query);
});

test('source deletion rejects cross-site requests, staging, traversal, aliases and malformed selection atomically', async () => {
  assert.equal(
    (await call('/alpha', { all: true }, { Origin: 'https://attacker.invalid' })).status,
    403,
  );
  const badHost = await new Promise((resolve, reject) => {
    const request = httpRequest(
      `${url}/api/uploads/alpha`,
      {
        method: 'DELETE',
        headers: { Host: 'attacker.invalid', 'Content-Type': 'application/json' },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    request.once('error', reject);
    request.end(JSON.stringify({ all: true }));
  });
  assert.equal(badHost, 403);
  assert.equal((await call('/.incoming', { all: true })).status, 400);
  assert.equal((await call('/Alpha', { all: true })).status, 400);
  for (const path of [
    '../beta/other.json',
    '/other.json',
    'nested/../../other',
    'nested\\two.json',
    './one.json',
    'nested//two.json',
    'C:/one.json',
    'one.json:stream',
    '.incoming/pending.json',
    'nested/.INCOMING/x',
    'one.json.',
    'one.json ',
    'NUL',
    'nested',
    'one.json\0',
  ]) {
    const result = await call('/alpha', { paths: ['one.json', path] });
    assert.equal(result.status, 400, path);
    assert.equal(await readFile(file('one.json'), 'utf8'), 'one');
  }
  for (const body of [
    {},
    [],
    { all: false },
    { all: true, paths: ['one.json'] },
    { paths: [] },
    { paths: Array(201).fill('one.json') },
    { paths: ['one.json'], unexpected: true },
  ])
    assert.equal((await call('/alpha', body)).status, 400, JSON.stringify(body));
  assert.equal((await call('/alpha', { paths: ['one.json', 'missing.json'] })).status, 404);
  assert.equal(await readFile(file('one.json'), 'utf8'), 'one');
});

test('all unfinished jobs and incomplete retry dependencies protect their needed uploads', async () => {
  for (const state of ['queued', 'running', 'paused', 'interrupted', 'failed', 'cancelled']) {
    seedJob(`state-${state}`, state);
    assert.equal((await call('/alpha')).body.locked, true, state);
    assert.equal((await call('/alpha', { paths: ['one.json'] })).status, 409, state);
    removeJobs();
  }
  for (const state of ['queued', 'running', 'paused', 'interrupted', 'failed', 'cancelled']) {
    seedJob(`cross-${state}`, state, { collection: 'another_collection', sourceRoot: uploads });
    assert.equal((await call('/alpha')).body.locked, true, `cross collection ${state}`);
    assert.equal((await call('/alpha', { all: true })).status, 409, `cross collection ${state}`);
    removeJobs();
  }
  for (const state of ['completed', 'failed', 'cancelled']) {
    seedJob('snapshotted', state, { inputReady: true });
    assert.equal((await call('/alpha')).body.locked, false, `snapshotted ${state}`);
    removeJobs();
  }
  for (const state of ['failed', 'cancelled']) {
    seedJob('outside', state, { sourceRoot: join(root, 'outside') });
    assert.equal((await call('/alpha')).body.locked, false, `unrelated ${state}`);
    removeJobs();
  }
  assert.equal(await readFile(file('one.json'), 'utf8'), 'one');
});

test('CLI/watch index locks and live collection writes reject cleanup until their owner finishes', async () => {
  for (const mode of ['index', 'hold-write']) {
    const worker = spawnWorker('./shared/indexing-coordinator-worker.js', [mode, 'alpha']);
    assert.equal((await worker.ready).state, 'owned');
    const blocked = await call('/alpha', { all: true });
    assert.equal(blocked.status, 409, mode);
    assert.equal(blocked.body.code, mode === 'index' ? 'INDEXING_BUSY' : 'COLLECTION_BUSY');
    await worker.stop();
  }
  assert.equal(await readFile(file('one.json'), 'utf8'), 'one');
});

test('source maintenance serializes with real job acceptance under the shared input reservation', async () => {
  const owner = spawnWorker('./shared/upload-storage-acceptance-worker.js', ['hold']);
  assert.equal((await owner.ready).state, 'owned');
  let completed = false;
  const deleting = call('/alpha', { paths: ['one.json'] }).then((result) => {
    completed = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(completed, false, 'cleanup waits for the input reservation');
  assert.equal(await readFile(file('one.json'), 'utf8'), 'one');
  const accepting = spawnWorker('./shared/upload-storage-acceptance-worker.js', ['accept']);
  await owner.stop();
  const accepted = await accepting.ready;
  const result = await deleting;
  assert.equal(accepted.state, 'accepted');
  assert.ok([200, 409].includes(result.status));
  assert.equal(
    accepted.sourcePresent,
    result.status === 409,
    'acceptance either protects the input or sees cleanup already completed',
  );
  assert.equal(await accepting.exit, 0);
  removeJobs();
  await writeFile(file('one.json'), 'one');
});

test('bounded traversal rejects excessive depth before clearing any files', async () => {
  const directory = join(uploads, 'deep');
  const nested = join(directory, ...Array(33).fill('d'));
  await mkdir(nested, { recursive: true });
  await writeFile(join(directory, 'keep.json'), 'safe');
  await writeFile(join(nested, 'deep.json'), 'deep');
  assert.equal((await call('/deep')).status, 413);
  assert.equal((await call('/deep', { all: true })).status, 413);
  assert.equal(await readFile(join(directory, 'keep.json'), 'utf8'), 'safe');
  assert.equal(await readFile(join(nested, 'deep.json'), 'utf8'), 'deep');
  await rm(directory, { recursive: true });
});

test('symlinks cannot expose or delete targets outside uploaded source storage', async () => {
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'secret.txt'), 'keep outside');
  await symlink(
    join(root, 'outside'),
    file('linked-dir'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  if (process.platform !== 'win32')
    await symlink(join(root, 'outside', 'secret.txt'), file('linked-file'));
  await symlink(
    join(root, 'outside'),
    join(uploads, 'linked_collection'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.equal(
    (await call('')).body.collections.some((entry) => entry.collection === 'linked_collection'),
    false,
  );
  assert.equal((await call('/linked_collection')).status, 409);
  assert.equal(
    (await call('/alpha')).body.files.some((entry) => entry.path.includes('linked')),
    false,
  );
  for (const path of [
    ...(process.platform === 'win32' ? [] : ['linked-file']),
    'linked-dir/secret.txt',
  ])
    assert.equal((await call('/alpha', { paths: [path] })).status, 400);
  assert.equal(await readFile(join(root, 'outside', 'secret.txt'), 'utf8'), 'keep outside');
});

test('selected deletion and clearing preserve indexed data, history, cache, other collections and incoming transfers', async () => {
  seedJob('retained-history', 'completed', { inputReady: true });
  const cache = join(root, 'data', 'image-cache');
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'cache-sentinel'), 'cached image');
  await mkdir(file('.incoming'), { recursive: true });
  await writeFile(file('.incoming/protected'), 'staging');
  assert.deepEqual((await call('/alpha', { paths: ['nested/two.json', 'nested/two.json'] })).body, {
    deleted: 1,
    bytes: 7,
  });
  const cleared = await call('/alpha', { all: true });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body, { deleted: 2, bytes: 18 });
  assert.deepEqual((await call('/alpha')).body.files, []);
  assert.deepEqual((await call('/alpha', { all: true })).body, { deleted: 0, bytes: 0 });
  assert.equal(await readFile(join(database, 'archive-sentinel'), 'utf8'), 'conversations stay');
  assert.equal(await readFile(join(root, 'registry.json'), 'utf8'), '{"alpha":true}');
  assert.equal(await readFile(join(cache, 'cache-sentinel'), 'utf8'), 'cached image');
  assert.equal(await readFile(join(uploads, 'beta', 'other.json'), 'utf8'), 'other collection');
  assert.equal(
    await readFile(join(uploads, '.incoming', 'pending.json'), 'utf8'),
    'incomplete transfer',
  );
  assert.equal(await readFile(file('.incoming/protected'), 'utf8'), 'staging');
  const db = new DatabaseSync(join(database, '.import-jobs', 'jobs.sqlite'));
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM jobs').get().count, 1);
  } finally {
    db.close();
  }
  removeJobs();
});

test('unsafe configured upload/database overlap cannot delete server data or leak its absolute path', async () => {
  await stopped();
  const protectedArchive = join(uploads, 'protected');
  await mkdir(protectedArchive);
  await writeFile(join(protectedArchive, 'archive-sentinel'), 'preserve configured archive');
  server = spawnWorker('./shared/upload-storage-server.js', [], { LANCEDB_PATH: protectedArchive });
  url = `http://127.0.0.1:${(await server.ready).port}`;
  const response = await call('/protected', { all: true });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /protected server data/);
  assert.equal(JSON.stringify(response.body).includes(root), false);
  assert.equal(
    await readFile(join(protectedArchive, 'archive-sentinel'), 'utf8'),
    'preserve configured archive',
  );
  assert.ok((await readdir(uploads)).includes('alpha'));
});

test('configured runtime, model and embedding caches are protected from uploaded-source cleanup', async () => {
  await server.stop();
  const shared = join(uploads, 'runtime');
  await mkdir(shared);
  await writeFile(join(shared, 'sentinel'), 'keep server resource');
  for (const key of [
    'THREADSHELF_TOOLS_PATH',
    'THREADSHELF_MODEL_CACHE',
    'THREADSHELF_IMAGE_CACHE_PATH',
    'THREADSHELF_MODELS_PATH',
  ]) {
    const worker = spawnWorker('./shared/upload-storage-server.js', [], { [key]: shared });
    url = `http://127.0.0.1:${(await worker.ready).port}`;
    assert.equal((await call('/runtime', { all: true })).status, 409, key);
    assert.equal(await readFile(join(shared, 'sentinel'), 'utf8'), 'keep server resource');
    await worker.stop();
  }
  for (const setting of ['downloadDirectory', 'modelDirectories', 'executablePath']) {
    const config = join(root, 'generation-config.json');
    await writeFile(
      config,
      JSON.stringify({
        llamaCpp: {
          [setting]:
            setting === 'modelDirectories'
              ? [shared]
              : setting === 'executablePath'
                ? join(shared, 'sentinel')
                : shared,
        },
      }),
    );
    const worker = spawnWorker('./shared/upload-storage-server.js', [], {
      GENERATION_CONFIG_PATH: config,
    });
    url = `http://127.0.0.1:${(await worker.ready).port}`;
    assert.equal((await call('/runtime', { all: true })).status, 409, setting);
    assert.equal(await readFile(join(shared, 'sentinel'), 'utf8'), 'keep server resource');
    await worker.stop();
  }
  const worker = spawnWorker('./shared/upload-storage-server.js', [], {
    UPLOADS_DIR: fileURLToPath(new URL('..', import.meta.url)),
  });
  url = `http://127.0.0.1:${(await worker.ready).port}`;
  assert.equal(
    (await call('/src')).status,
    409,
    'misconfigured root cannot manage application source',
  );
  await worker.stop();
});
