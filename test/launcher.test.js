import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(project, 'threadshelf-enhanced');
const linux = { skip: process.platform !== 'linux' };
const environment = (overrides = {}) => {
  const env = { ...process.env };
  for (const key of [
    'THREADSHELF_ENHANCED_DIR',
    'THREADSHELF_NODE_VERSION',
    'HOST',
    'PORT',
    'ALLOWED_HOSTS',
    'XDG_CACHE_HOME',
    'HF_HOME',
    'TMUX',
    'STY',
  ])
    delete env[key];
  return { ...env, ...overrides };
};
const run = (file, args = [], overrides = {}, cwd) =>
  spawnSync('bash', [file, ...args], { env: environment(overrides), encoding: 'utf8', cwd });
const installation = async (t, version = '24.22.1') => {
  const temporary = await mkdtemp(join(tmpdir(), 'enhanced-launcher-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'installed app');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const bin = join(root, `.local/node-v${version}-linux-${arch}/bin`);
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, 'dist/src'), { recursive: true });
  await mkdir(join(root, 'scripts'));
  await symlink(process.execPath, join(bin, 'node'));
  await copyFile(launcher, join(root, 'threadshelf-enhanced'));
  await copyFile(
    join(project, 'scripts/network-addresses.mjs'),
    join(root, 'scripts/network-addresses.mjs'),
  );
  await writeFile(join(root, '.env'), 'HOST=127.0.0.1\nPORT=4321\n');
  await writeFile(
    join(root, 'dist/src/server.js'),
    'console.log("server-started:" + process.env.PORT); process.exit(7);',
  );
  await writeFile(
    join(root, 'dist/src/ingest-cli.js'),
    'console.log(JSON.stringify({ args: process.argv.slice(2), port: process.env.PORT }));',
  );
  return { root, temporary, installed: join(root, 'threadshelf-enhanced') };
};

test('launcher help and version work before installation', linux, () => {
  const overrides = { THREADSHELF_ENHANCED_DIR: '/nonexistent-example-directory' };
  const help = run(launcher, ['--help'], overrides);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--index FOLDER COLLECTION/);
  assert.match(help.stdout, /THREADSHELF_ENHANCED_DIR/);
  assert.equal(run(launcher, ['--version'], overrides).stdout.trim(), 'threadshelf-enhanced 1.1.0');
});

test(
  'launcher resolves its own directory and propagates the single server exit code',
  linux,
  async (t) => {
    const { installed, temporary } = await installation(t);
    const result = run(installed, [], {}, temporary);
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout.match(/server-started:/g)?.length, 1);
    assert.match(result.stdout, /ThreadShelf local access: http:\/\/127\.0\.0\.1:4321\//);
    assert.match(result.stdout, /ThreadShelf access is local only, as configured by HOST/);
    assert.ok(
      result.stdout.indexOf('ThreadShelf local access:') < result.stdout.indexOf('server-started:'),
    );
  },
);

test('launcher follows relative symlinks from an unrelated working directory', linux, async (t) => {
  const { temporary } = await installation(t);
  const commands = join(temporary, 'commands');
  await mkdir(commands);
  await symlink('../installed app/threadshelf-enhanced', join(commands, 'first'));
  await symlink('first', join(commands, 'threadshelf-enhanced'));
  const result = run(join(commands, 'threadshelf-enhanced'), ['--check-runtime'], {}, tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Enhanced runtime\/build ready:/);
  assert.doesNotMatch(result.stdout, /server-started/);
});

test('launcher accepts a manually selected installation and runtime version', linux, async (t) => {
  const { root } = await installation(t, '24.0.0');
  const result = run(launcher, ['--check-runtime'], {
    THREADSHELF_ENHANCED_DIR: root,
    THREADSHELF_NODE_VERSION: 'v24.0.0',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Enhanced runtime\/build ready:/);
});

test(
  'launcher explains setup when configuration or the local build is missing',
  linux,
  async (t) => {
    const { root, installed } = await installation(t);
    await rm(join(root, '.env'));
    let result = run(installed);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing configuration:/);
    assert.match(result.stderr, /setup-threadshelf\.sh/);
    assert.match(result.stderr, /copy \.env\.example to \.env/);
    await writeFile(join(root, '.env'), 'HOST=127.0.0.1\n');
    await rm(join(root, 'dist/src/server.js'));
    result = run(installed, ['--check-runtime']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /setup-threadshelf\.sh/);
  },
);

test(
  'launcher indexes a folder with spaces and optional clearing without a terminal multiplexer',
  linux,
  async (t) => {
    const { root, installed, temporary } = await installation(t);
    const source = join(temporary, 'source exports');
    await mkdir(source);
    for (const clear of [false, true]) {
      const args = ['--index', 'source exports', 'example_collection'];
      if (clear) args.push('--clear');
      const result = run(installed, args, {}, temporary);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /server-started/);
      const payload = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.deepEqual(payload, {
        args: [source, 'example_collection', ...(clear ? ['--clear'] : [])],
        port: '4321',
      });
    }
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'HOST=127.0.0.1\nPORT=4321\n');
  },
);

test('launcher rejects conflicting or incomplete actions', linux, async (t) => {
  const { installed, temporary } = await installation(t);
  for (const args of [
    ['--clear'],
    ['--index'],
    ['--index', temporary, 'example', '--check-runtime'],
    ['--check-runtime', '--index', temporary, 'example'],
    ['--index', temporary, '--clear'],
    ['--unknown'],
  ]) {
    const result = run(installed, args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /server-started/);
  }
});

test(
  'launcher loads address configuration from .env and respects shell overrides',
  linux,
  async (t) => {
    const { root, installed } = await installation(t);
    await writeFile(
      join(root, '.env'),
      'HOST=0.0.0.0\nPORT=4321\nALLOWED_HOSTS=archive.example.test\n',
    );
    let result = run(installed);
    assert.equal(result.status, 7, result.stderr);
    assert.match(
      result.stdout,
      /ThreadShelf configured address: http:\/\/archive\.example\.test:4321\//,
    );
    assert.ok(
      result.stdout.indexOf('ThreadShelf configured address:') <
        result.stdout.indexOf('server-started:4321'),
    );
    result = run(installed, [], { HOST: '127.0.0.1', PORT: '4322' });
    assert.equal(result.status, 7, result.stderr);
    assert.match(result.stdout, /ThreadShelf local access: http:\/\/127\.0\.0\.1:4322\//);
    assert.doesNotMatch(result.stdout, /archive\.example\.test/);
    assert.match(result.stdout, /server-started:4322/);
  },
);

test(
  'launcher cache defaults match setup and explicit cache paths are preserved',
  linux,
  async (t) => {
    const { root, installed, temporary } = await installation(t);
    await writeFile(
      join(root, 'dist/src/server.js'),
      'console.log(JSON.stringify({ xdg: process.env.XDG_CACHE_HOME, hf: process.env.HF_HOME }));',
    );
    for (const overrides of [
      {},
      { XDG_CACHE_HOME: join(temporary, 'cache'), HF_HOME: join(temporary, 'hf') },
    ]) {
      const result = run(installed, [], overrides);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), {
        xdg: overrides.XDG_CACHE_HOME || join(root, '.local/cache'),
        hf: overrides.HF_HOME || join(root, '.local/huggingface'),
      });
    }
  },
);

const signalFixture = async (t, { index = false } = {}) => {
  const fixture = await installation(t);
  const script = join(fixture.root, `dist/src/${index ? 'ingest-cli' : 'server'}.js`);
  await writeFile(
    script,
    `const { spawn } = require('node:child_process');
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
let stopping = false;
let workerClosed = false;
const cleanup = () => setTimeout(() => {
  console.log('cleanup-complete');
  process.exit(23);
}, 75);
worker.once('close', () => {
  workerClosed = true;
  if (stopping) cleanup();
});
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  // Wait for the child worker to be reaped, then finish asynchronous cleanup.
  if (workerClosed) cleanup();
});
worker.once('spawn', () => console.log('signal-ready:' + JSON.stringify({
  server: process.pid, worker: worker.pid,
})));
`,
  );
  const child = spawn(
    'bash',
    [fixture.installed, ...(index ? ['--index', fixture.temporary, 'example_collection'] : [])],
    { env: environment(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  let processes;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  t.after(() => {
    // On assertion failure, never leave the synthetic process group behind.
    if (processes) {
      try {
        process.kill(-processes.server, 'SIGKILL');
      } catch {}
    }
    child.kill('SIGKILL');
  });
  processes = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic server did not start')), 5000);
    child.stdout.on('data', () => {
      const match = stdout.match(/signal-ready:(\{[^\n]+\})/);
      if (match) {
        clearTimeout(timeout);
        resolve(JSON.parse(match[1]));
      }
    });
    completed.then((result) => {
      clearTimeout(timeout);
      reject(new Error(`Synthetic server exited before readiness: ${result.stderr}`));
    }, reject);
  });
  return { child, processes, completed };
};

for (const index of [false, true]) {
  test(
    `Ctrl+C stops and reaps ${index ? 'indexing' : 'the server'} and its worker before returning success`,
    { ...linux, timeout: 10000 },
    async (t) => {
      const { child, processes, completed } = await signalFixture(t, { index });
      assert.ok(child.kill('SIGINT'));
      const result = await completed;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stdout.match(/\nCTRL-C\n\n/g)?.length, 1, result.stdout);
      assert.match(result.stdout, /cleanup-complete/);
      for (const pid of Object.values(processes))
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    },
  );
}

test(
  'TERM stops and reaps the process group while retaining exit status 143',
  { ...linux, timeout: 10000 },
  async (t) => {
    const { child, processes, completed } = await signalFixture(t);
    assert.ok(child.kill('SIGTERM'));
    const result = await completed;
    assert.equal(result.code, 143, result.stderr);
    assert.equal(result.signal, null);
    assert.doesNotMatch(result.stdout, /CTRL-C/);
    assert.match(result.stdout, /cleanup-complete/);
    for (const pid of Object.values(processes))
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);

test('child-only signals remain failures without a launcher interrupt', linux, async (t) => {
  const { root, installed } = await installation(t);
  for (const [signal, status] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    await writeFile(join(root, 'dist/src/server.js'), `process.kill(process.pid, '${signal}');`);
    const result = run(installed);
    assert.equal(result.status, status, result.stderr);
    assert.doesNotMatch(result.stdout, /CTRL-C/);
  }
});
