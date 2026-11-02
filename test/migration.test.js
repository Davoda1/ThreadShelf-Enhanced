import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  utimes,
  copyFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const scripts = resolve('scripts');
const temp = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'enhanced-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const run = (file, args, env = {}, input = '', cwd) =>
  spawnSync(file, args, { env: { ...process.env, ...env }, input, encoding: 'utf8', cwd });
test('migration copies verified data, preserves source and backs up target environment', async (t) => {
  const root = await temp(t),
    source = join(root, 'old'),
    target = join(root, 'new');
  await mkdir(join(source, '.lancedb'), { recursive: true });
  await mkdir(target);
  await writeFile(join(source, '.lancedb', 'synthetic.db'), 'synthetic archive bytes');
  await writeFile(join(source, '.collections.json'), '["chatgpt"]');
  await writeFile(join(source, '.env'), 'PORT=3123\n');
  await writeFile(join(target, '.env'), 'PORT=3000\n');
  const args = [join(scripts, 'migrate-installation.mjs'), '--source', source, '--target', target];
  assert.notEqual(run(process.execPath, args).status, 0);
  // Match the documented invocation: the script and cwd are inside the target.
  // This also catches self-detection when /proc and Node use different PID namespaces.
  const installedScript = join(target, 'migrate-installation.mjs');
  await writeFile(installedScript, await readFile(args[0]));
  const result = run(
    process.execPath,
    [installedScript, ...args.slice(1), '--stopped'],
    {},
    '',
    target,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(target, '.lancedb', 'synthetic.db'), 'utf8'),
    'synthetic archive bytes',
  );
  assert.equal(
    await readFile(join(source, '.lancedb', 'synthetic.db'), 'utf8'),
    'synthetic archive bytes',
  );
  assert.equal(await readFile(join(target, '.env'), 'utf8'), 'PORT=3123\n');
  const backup = (await readdir(target)).find((n) => n.startsWith('.env.before-migration-'));
  assert.equal(await readFile(join(target, backup), 'utf8'), 'PORT=3000\n');
  assert.notEqual(
    run(process.execPath, [...args, '--stopped']).status,
    0,
    'must refuse overwriting migrated database',
  );
});
test('migration reopens published generations after the stopped synthetic OLD directory is removed', async (t) => {
  const root = await temp(t);
  const source = join(root, 'ThreadShelf-Enhanced-OLD');
  const target = join(root, 'ThreadShelf-Enhanced');
  await mkdir(source);
  await mkdir(target);
  const runStore = (directory, code) =>
    spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        THREADSHELF_MODEL_CACHE:
          process.env.THREADSHELF_MODEL_CACHE || resolve('.threadshelf/model-cache'),
        THREADSHELF_DATA_DIR: directory,
        LANCEDB_PATH: join(directory, '.lancedb'),
        COLLECTIONS_PATH: join(directory, '.collections.json'),
      },
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
  const seeded = runStore(
    source,
    `
    import assert from 'node:assert/strict';
    const store = await import('./src/store.ts');
    const { getStoragePublication } = await import('./src/storage-publication.ts');
    const file = (text) => ({ sourceFile: '/synthetic/export.json', provider: 'openai',
      conversations: [{ key: 'stable-migration-id', title: 'Synthetic migration', turns: [{ user: text }] }] });
    await store.replaceImportedFiles('migration', [file('First published migration conversation')]);
    await store.replaceImportedFiles('migration', [file('Latest published migration conversation')], { clearFirst: true });
    const publication = getStoragePublication('migration');
    assert.ok(publication.generation && publication.previousGeneration);
    assert.match(publication.indexTable, /^__index_/);
  `,
  );
  assert.equal(seeded.status, 0, seeded.stderr || String(seeded.error));
  await mkdir(join(source, '.threadshelf', 'image-cache'), { recursive: true });
  await writeFile(
    join(source, '.threadshelf', 'image-cache', 'synthetic.bin'),
    'cached image bytes',
  );
  const migrated = run(process.execPath, [
    join(scripts, 'migrate-installation.mjs'),
    '--source',
    source,
    '--target',
    target,
    '--stopped',
    '--include-caches',
  ]);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(
    await readFile(join(target, '.threadshelf', 'image-cache', 'synthetic.bin'), 'utf8'),
    'cached image bytes',
  );
  // Both child processes have exited; removing only this test's synthetic source
  // proves neither LanceDB fragments nor SQLite publication sidecars depend on it.
  await rm(source, { recursive: true });
  const reopened = runStore(
    target,
    `
    import assert from 'node:assert/strict';
    const store = await import('./src/store.ts');
    const { getStoragePublication } = await import('./src/storage-publication.ts');
    const before = getStoragePublication('migration');
    assert.ok(before.generation && before.previousGeneration);
    assert.equal((await store.keywordSearchCollection('migration', 'Latest published')).length, 1);
    assert.equal((await store.keywordSearchCollection('migration', 'First published')).length, 0);
    const rows = await store.getStoredThreads('migration', '/synthetic/export.json', 'stable-migration-id');
    assert.equal(rows.length, 1);
    assert.match(rows[0].turnsJson, /Latest published migration conversation/);
    await store.renameStoredThread('migration', '/synthetic/export.json', 'stable-migration-id', 'Renamed after migration');
    assert.equal((await store.getStoredThreads('migration', '/synthetic/export.json', 'stable-migration-id'))[0].title,
      'Renamed after migration');
  `,
  );
  assert.equal(reopened.status, 0, reopened.stderr || String(reopened.error));
});
test(
  'migration audits old-directory dependencies without rewriting configuration or exposing secrets',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await temp(t),
      source = join(root, 'old'),
      target = join(root, 'new');
    await mkdir(join(source, '.lancedb'), { recursive: true });
    await mkdir(join(source, '.threadshelf', 'models'), { recursive: true });
    await mkdir(target);
    await writeFile(join(source, '.lancedb', 'synthetic.db'), 'synthetic database');
    await writeFile(join(source, '.threadshelf', 'models', 'model.bin'), 'synthetic model');
    await symlink(
      join(source, '.threadshelf', 'models', 'model.bin'),
      join(source, '.threadshelf', 'linked-model.bin'),
    );
    const secret = 'SYNTHETIC_PRIVATE_VALUE_NOT_FOR_OUTPUT';
    const environment = `OPENROUTER_API_KEY=${secret}\nTHREADSHELF_MODELS_PATH=${join(source, '.threadshelf', 'models')}\n`;
    await writeFile(join(source, '.env'), environment);
    const args = [
      join(scripts, 'migrate-installation.mjs'),
      '--source',
      source,
      '--target',
      target,
    ];
    const result = run(process.execPath, [...args, '--stopped']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Keep the old installation/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
    assert.equal(await readFile(join(target, '.env'), 'utf8'), environment);
    assert.equal(await readFile(join(source, '.env'), 'utf8'), environment);
    const report = JSON.parse(
      await readFile(join(target, '.threadshelf', 'migration-report.json'), 'utf8'),
    );
    assert.equal(report.copyVerified, true);
    assert.equal(report.issues.length, 2);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
    assert.equal(run(process.execPath, [...args, '--audit-only']).status, 2);
    await rm(join(target, '.threadshelf', 'linked-model.bin'));
    await writeFile(
      join(target, '.env'),
      `THREADSHELF_MODELS_PATH=${join(target, '.threadshelf', 'models')}\n`,
    );
    assert.equal(run(process.execPath, [...args, '--audit-only']).status, 0);
  },
);

test('migration audit rejects an image cache directed into OLD without changing either installation', async (t) => {
  const root = await temp(t);
  const source = join(root, 'ThreadShelf-Enhanced-OLD');
  const target = join(root, 'ThreadShelf-Enhanced');
  await mkdir(join(source, '.lancedb'), { recursive: true });
  await mkdir(target);
  // Check a not-yet-created cache too: starting the server must not recreate a
  // dependency on OLD merely because the directory was absent during the audit.
  const environment = `THREADSHELF_IMAGE_CACHE_PATH=${join(source, '.threadshelf', 'image-cache')}\n`;
  await writeFile(join(target, '.env'), environment);
  const args = [
    join(scripts, 'migrate-installation.mjs'),
    '--audit-only',
    '--source',
    source,
    '--target',
    target,
  ];
  const oldDirected = run(process.execPath, args);
  assert.equal(oldDirected.status, 2, oldDirected.stderr);
  assert.match(oldDirected.stdout, /old-directory-path: \.env:THREADSHELF_IMAGE_CACHE_PATH/);
  assert.equal(await readFile(join(target, '.env'), 'utf8'), environment);
  assert.deepEqual(await readdir(source), ['.lancedb']);
  assert.deepEqual(await readdir(target), ['.env']);

  await writeFile(join(target, '.env'), 'THREADSHELF_IMAGE_CACHE_PATH=.threadshelf/image-cache\n');
  const targetDirected = run(process.execPath, args);
  assert.equal(targetDirected.status, 0, targetDirected.stderr);
  assert.deepEqual(await readdir(target), ['.env'], 'audit must not create a cache or report');
});

test('migration refuses a custom database layout and nested aliases before copying', async (t) => {
  const root = await temp(t),
    source = join(root, 'old'),
    target = join(root, 'new');
  await mkdir(join(source, '.lancedb'), { recursive: true });
  await mkdir(target);
  await writeFile(join(source, '.lancedb', 'synthetic.db'), 'synthetic');
  await writeFile(join(source, '.env'), `THREADSHELF_DATA_DIR=${join(root, 'external')}\n`);
  const args = [
    join(scripts, 'migrate-installation.mjs'),
    '--stopped',
    '--source',
    source,
    '--target',
    target,
  ];
  const result = run(process.execPath, args);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different storage layout/);
  assert.deepEqual(await readdir(target), []);
  assert.notEqual(run(process.execPath, [...args.slice(0, -1), source]).status, 0);
  assert.notEqual(run(process.execPath, [args[0], '--source', '--target', target]).status, 0);
});

test(
  'migration refuses database symlinks instead of claiming an independent verified copy',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await temp(t),
      source = join(root, 'old'),
      target = join(root, 'new'),
      database = join(root, 'external');
    await mkdir(source);
    await mkdir(target);
    await mkdir(database);
    await writeFile(join(database, 'synthetic.db'), 'synthetic');
    await symlink(database, join(source, '.lancedb'));
    const result = run(process.execPath, [
      join(scripts, 'migrate-installation.mjs'),
      '--stopped',
      '--source',
      source,
      '--target',
      target,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /database is a symlink/);
    assert.deepEqual(await readdir(target), []);
  },
);

test('migration keeps an earlier report unchanged and uses a new report name', async (t) => {
  const root = await temp(t),
    source = join(root, 'old'),
    target = join(root, 'new');
  await mkdir(join(source, '.lancedb'), { recursive: true });
  await mkdir(join(source, '.threadshelf'));
  await mkdir(target);
  await writeFile(join(source, '.lancedb', 'synthetic.db'), 'synthetic');
  const original = '{"syntheticPreviousReport":true}\n';
  await writeFile(join(source, '.threadshelf', 'migration-report.json'), original);
  const result = run(process.execPath, [
    join(scripts, 'migrate-installation.mjs'),
    '--stopped',
    '--source',
    source,
    '--target',
    target,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(target, '.threadshelf', 'migration-report.json'), 'utf8'),
    original,
  );
  assert.equal(
    (await readdir(join(target, '.threadshelf'))).filter((name) =>
      /^migration-report-\d+\.json$/.test(name),
    ).length,
    1,
  );
});

test(
  'migration never writes its report through a copied configuration-directory symlink',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await temp(t),
      source = join(root, 'old'),
      target = join(root, 'new'),
      config = join(root, 'external-config');
    await mkdir(join(source, '.lancedb'), { recursive: true });
    await mkdir(target);
    await mkdir(config);
    await writeFile(join(source, '.lancedb', 'synthetic.db'), 'synthetic');
    await writeFile(join(config, 'untouched.txt'), 'synthetic existing external configuration');
    await symlink(config, join(source, '.threadshelf'));
    const result = run(process.execPath, [
      join(scripts, 'migrate-installation.mjs'),
      '--stopped',
      '--source',
      source,
      '--target',
      target,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readdir(config), ['untouched.txt']);
    assert.equal(
      (await readdir(target)).filter((name) => /^\.migration-report-\d+\.json$/.test(name)).length,
      1,
    );
  },
);
test('1.4 migration preserves optional speech bytes and reports old vault roots without rewriting identities', async (t) => {
  const root = await temp(t),
    source = join(root, 'ThreadShelf-Enhanced-OLD'),
    target = join(root, 'ThreadShelf-Enhanced');
  await mkdir(join(source, '.lancedb'), { recursive: true });
  await mkdir(join(source, '.threadshelf', 'tts', 'assets'), { recursive: true });
  await mkdir(target);
  await writeFile(join(source, '.lancedb', 'synthetic.db'), 'unchanged archive');
  const speech = Buffer.from([0, 1, 2, 255]);
  await writeFile(join(source, '.threadshelf', 'tts', 'assets', 'synthetic-model.bin'), speech);
  const settings = '{"enabled":false,"streamingEnabled":false,"diskCacheEnabled":false}';
  await writeFile(join(source, '.threadshelf', 'tts', 'settings.json'), settings);
  const vault = {
    version: 1,
    activeId: 'unchanged-id',
    vaults: [
      { id: 'unchanged-id', name: 'Notes', vaultPath: join(source, 'Notes'), allowWrites: false },
    ],
  };
  await writeFile(join(source, '.threadshelf', 'obsidian.json'), JSON.stringify(vault));
  const generation = {
    llamaCpp: {
      projectorPaths: {
        [join(source, 'models', 'vision.gguf')]: join(target, 'models', 'mmproj.gguf'),
        [join(target, 'models', 'other.gguf')]: join(source, 'models', 'other-mmproj.gguf'),
      },
    },
  };
  await writeFile(join(source, '.threadshelf', 'generation.json'), JSON.stringify(generation));
  const migrated = run(process.execPath, [
    join(scripts, 'migrate-installation.mjs'),
    '--source',
    source,
    '--target',
    target,
    '--stopped',
  ]);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.match(migrated.stdout, /obsidian.vaults\[0\].vaultPath/);
  assert.match(migrated.stdout, /generation.llamaCpp.projectorPaths\[0\].model/);
  assert.match(migrated.stdout, /generation.llamaCpp.projectorPaths\[1\].projector/);
  assert.deepEqual(
    JSON.parse(await readFile(join(target, '.threadshelf', 'generation.json'), 'utf8')),
    generation,
  );
  assert.deepEqual(
    await readFile(join(target, '.threadshelf', 'tts', 'assets', 'synthetic-model.bin')),
    speech,
  );
  assert.equal(
    await readFile(join(target, '.threadshelf', 'tts', 'settings.json'), 'utf8'),
    settings,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(target, '.threadshelf', 'obsidian.json'), 'utf8')),
    vault,
  );
  assert.equal(
    await readFile(join(source, '.lancedb', 'synthetic.db'), 'utf8'),
    'unchanged archive',
  );
  const audit = run(process.execPath, [
    join(scripts, 'migrate-installation.mjs'),
    '--source',
    source,
    '--target',
    target,
    '--audit-only',
  ]);
  assert.equal(audit.status, 2);
});

test('migration requires both explicit paths and help contains no deployment defaults', () => {
  const script = join(scripts, 'migrate-installation.mjs');
  const help = run(process.execPath, [script, '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--source OLD --target NEW/);
  for (const args of [['--stopped'], ['--audit-only'], ['--stopped', '--source', 'unused']]) {
    const result = run(process.execPath, [script, ...args]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Both --source OLD and --target NEW are required/);
  }
});
