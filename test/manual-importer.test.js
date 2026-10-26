import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const linux = { skip: process.platform !== 'linux' };
const fixture = async (t, availableMiB = 3072) => {
  const temporary = await mkdtemp(join(tmpdir(), 'threadshelf-manual-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'installed app');
  const input = join(temporary, 'synthetic exports');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'dist/src'), { recursive: true });
  await mkdir(input);
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
  await copyFile(join(project, 'manual-importer.sh'), join(root, 'manual-importer.sh'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'threadshelf-enhanced', version: '1.3.0' }),
  );
  await writeFile(
    join(input, 'conversations.json'),
    '[{"title":"Synthetic conversation","turns":[{"user":"Hello"}]}]',
  );
  await writeFile(join(root, '.env'), '');
  for (const name of ['ingest.js', 'store.js', 'paths.js', 'validation.js'])
    await writeFile(join(root, 'dist/src', name), '');
  await writeFile(
    join(root, 'dist/src/memory-governor.js'),
    `exports.systemMemory = () => ({ availableBytes: ${availableMiB} * 1048576 });`,
  );
  const imported = join(root, 'imported.json');
  await writeFile(
    join(root, 'dist/src/ingest-cli.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(imported)}, JSON.stringify({args:process.argv.slice(2),execArgv:process.execArgv,options:process.env.NODE_OPTIONS}));`,
  );
  const marker = join(root, 'preload.txt');
  await writeFile(
    join(root, 'preload.cjs'),
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');`,
  );
  const run = (args = [], overrides = {}) => {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        key.startsWith('THREADSHELF_') ||
        key.startsWith('MANUAL_IMPORTER_') ||
        ['LANCEDB_PATH', 'COLLECTIONS_PATH', 'NODE_OPTIONS', 'TMUX', 'STY'].includes(key)
      )
        delete env[key];
    return spawnSync(
      'bash',
      [
        join(root, 'manual-importer.sh'),
        '--non-interactive',
        '--import-dir',
        input,
        '--node',
        process.execPath,
        '--data-dir',
        join(temporary, 'data'),
        '--min-free-disk-mb',
        '0',
        '--color',
        'never',
        ...args,
      ],
      { cwd: temporary, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000 },
    );
  };
  return { root, input, imported, marker, run };
};

test(
  'public manual dry run accepts bounded startup headroom without executing preloads',
  linux,
  async (t) => {
    const { imported, marker, run } = await fixture(t);
    const result = run(['--dry-run'], { NODE_OPTIONS: '--require ./preload.cjs' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /3072 MiB available; 4096 MiB old-space ceiling; 1024 MiB startup \+ 2048 MiB reserve/,
    );
    assert.match(result.stderr, /No files changed; importer not started/);
    await assert.rejects(readFile(imported), { code: 'ENOENT' });
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  },
);

test(
  'public manual import rejects insufficient headroom before replacing input or starting a child',
  linux,
  async (t) => {
    const { root, input, imported, run } = await fixture(t, 3071);
    const source = join(root, 'new-source.json');
    await writeFile(source, '[{"title":"Replacement"}]');
    const existing = await readFile(join(input, 'conversations.json'), 'utf8');
    const result = run(['--yes', '--source-json', source, '--replace-source']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /startup 1024 \+ reserve 2048 requires 3072 MiB/);
    assert.equal(await readFile(join(input, 'conversations.json'), 'utf8'), existing);
    await assert.rejects(readFile(imported), { code: 'ENOENT' });
  },
);

test(
  'public manual importer preserves preloads only for the real child and applies the selected heap',
  linux,
  async (t) => {
    const { input, imported, marker, run } = await fixture(t);
    const options = '--require ./preload.cjs --max-old-space-size=2048';
    const result = run(['--yes', '--clear', '--collection', 'sample'], { NODE_OPTIONS: options });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(imported, 'utf8')), {
      args: [input, 'sample', '--clear'],
      execArgv: ['--max-old-space-size=4096'],
      options,
    });
    assert.equal(await readFile(marker, 'utf8'), 'ran\n');
  },
);

test(
  'public manual importer reports unknown memory without starting an import',
  linux,
  async (t) => {
    const { imported, run } = await fixture(t, 0);
    const result = run(['--yes']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Cannot determine available RAM/);
    await assert.rejects(readFile(imported), { code: 'ENOENT' });
  },
);

test(
  'public manual importer retains the full-heap preflight on older servers without a governor',
  linux,
  async (t) => {
    const { root, imported, run } = await fixture(t);
    await rm(join(root, 'dist/src/memory-governor.js'));
    const result = run(['--dry-run', '--heap-mb', '4096', '--reserve-mb', '256']);
    // The machine's available RAM determines success, but the legacy requirement is fixed.
    assert.match(
      result.stderr,
      /(?:4096 MiB startup \+ 256 MiB reserve|startup 4096 \+ reserve 256 requires 4352 MiB)/,
    );
    await assert.rejects(readFile(imported), { code: 'ENOENT' });
  },
);
