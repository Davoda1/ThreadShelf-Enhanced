import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { withInterprocessLock } from '../src/interprocess-lock.ts';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-lock-test-'));
const workers = new Set();
const workerPath = fileURLToPath(new URL('./shared/storage-lock-worker.js', import.meta.url));

function startWorker(resource) {
  const child = fork(workerPath, [JSON.stringify({ mode: 'lock', resource })], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  workers.add(child);
  let diagnostic = '';
  child.stderr.on('data', (data) => (diagnostic += data));
  const messages = [];
  child.on('message', (message) => messages.push(message));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const waitFor = async (type) => {
    const deadline = Date.now() + 10_000;
    while (!messages.some((message) => message.type === type)) {
      const failure = messages.find((message) => message.type === 'error');
      if (failure) throw new Error(failure.error);
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`Worker did not send ${type}: ${diagnostic}`);
      await delay(10);
    }
  };
  return { child, exited, waitFor };
}

after(async () => {
  for (const child of workers) if (child.exitCode === null) child.kill('SIGKILL');
  await Promise.all(
    [...workers].map((child) =>
      child.exitCode === null && child.signalCode === null
        ? new Promise((resolve) => child.once('exit', resolve))
        : undefined,
    ),
  );
  await rm(root, { recursive: true, force: true });
});

describe('interprocess storage locks', () => {
  it('serializes same-process asynchronous read-modify-write operations', async () => {
    let counter = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withInterprocessLock(join(root, 'counter'), async () => {
          const previous = counter;
          await delay(2);
          counter = previous + 1;
        }),
      ),
    );
    assert.equal(counter, 20);
  });

  it('supports nested ownership and releases after a failed mutation', async () => {
    const resource = join(root, 'nested');
    const expected = new Error('Synthetic write failure');
    await assert.rejects(
      withInterprocessLock(resource, () =>
        withInterprocessLock(resource, async () => {
          throw expected;
        }),
      ),
      (error) => error === expected,
    );
    assert.equal(await withInterprocessLock(resource, async () => 'recovered'), 'recovered');
  });

  it('serializes parallel nested mutations without deadlocking recursive ownership', async () => {
    const resource = join(root, 'parallel-nested');
    let counter = 0;
    await withInterprocessLock(resource, async () => {
      await Promise.all(
        Array.from({ length: 20 }, () =>
          withInterprocessLock(resource, () =>
            withInterprocessLock(resource, async () => {
              const previous = counter;
              await delay(1);
              counter = previous + 1;
            }),
          ),
        ),
      );
    });
    assert.equal(counter, 20);
  });

  it('times out and cancels without executing an unprotected mutation', async () => {
    const resource = join(root, 'timeout');
    const worker = startWorker(resource);
    await worker.waitFor('acquired');
    let entered = false;
    const mutation = async () => (entered = true);
    await assert.rejects(
      withInterprocessLock(resource, mutation, { timeoutMs: 50 }),
      /Timed out waiting/,
    );
    await assert.rejects(
      withInterprocessLock(resource, mutation, { signal: AbortSignal.timeout(50) }),
      /abort/i,
    );
    assert.equal(entered, false);
    worker.child.send({ type: 'release' });
    assert.equal(await worker.exited, 0);
  });

  it('releases the OS lock after abrupt owner termination', async () => {
    const resource = join(root, 'crash');
    const worker = startWorker(resource);
    await worker.waitFor('acquired');
    worker.child.kill('SIGKILL');
    await worker.exited;
    assert.equal(
      await withInterprocessLock(resource, async () => 'after crash', { timeoutMs: 2_000 }),
      'after crash',
    );
  });

  it('canonicalizes directory aliases to the same interprocess lock', async () => {
    const alias = root + '-alias';
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const worker = startWorker(join(root, 'aliased'));
      await worker.waitFor('acquired');
      await assert.rejects(
        withInterprocessLock(join(alias, 'aliased'), async () => {}, { timeoutMs: 50 }),
        /Timed out waiting/,
      );
      worker.child.send({ type: 'release' });
      assert.equal(await worker.exited, 0);
    } finally {
      await rm(alias, { force: true });
    }
  });

  it('does not inherit expired ownership through a detached async context', async () => {
    const resource = join(root, 'detached');
    let detached;
    let start;
    const gate = new Promise((resolve) => (start = resolve));
    await withInterprocessLock(resource, async () => {
      detached = (async () => {
        await gate;
        return withInterprocessLock(resource, async () => 'entered', { timeoutMs: 50 });
      })();
    });
    const worker = startWorker(resource);
    await worker.waitFor('acquired');
    start();
    await assert.rejects(detached, /Timed out waiting/);
    worker.child.send({ type: 'release' });
    assert.equal(await worker.exited, 0);
  });
});
