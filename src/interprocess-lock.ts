import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

interface LockOwner {
  active: boolean;
  children: Promise<void>;
}

export interface InterprocessLockOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const heldLocks = new AsyncLocalStorage<ReadonlyMap<string, LockOwner>>();
const DEFAULT_TIMEOUT_MS = 30_000;

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

const canonicalResource = async (resourcePath: string): Promise<string> => {
  const absolute = resolve(resourcePath);
  await mkdir(dirname(absolute), { recursive: true });
  const parent = await realpath(dirname(absolute));
  const resource = join(parent, basename(absolute));
  try {
    return await realpath(resource);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return resource;
  }
};

const isBusy = (error: unknown): boolean => {
  const code = (error as { errcode?: unknown } | undefined)?.errcode;
  // Extended SQLite error codes retain the base result in their low byte.
  return typeof code === 'number' && [5, 6].includes(code & 0xff);
};

const runOwned = async <T>(
  resource: string,
  inherited: ReadonlyMap<string, LockOwner> | undefined,
  owner: LockOwner,
  fn: () => Promise<T>,
): Promise<T> => {
  owner.active = true;
  const context = new Map(inherited);
  context.set(resource, owner);
  try {
    return await heldLocks.run(context, fn);
  } finally {
    // Direct child calls are serialized; each child receives its own scope so
    // recursive calls can proceed without deadlocking behind their parent.
    // Drain already-started children even when a caller failed to await them.
    for (;;) {
      const pending = owner.children;
      await pending;
      if (pending === owner.children) break;
    }
    owner.active = false;
  }
};

/**
 * Serialize a complete read-modify-write across local processes. SQLite owns
 * the operating-system lock, so process termination releases it without
 * guessing whether a heartbeat or PID is stale. The sidecar contains no user
 * records and MUST NOT be unlinked while any process may use this resource.
 * Callers must await their work and use a consistent order for distinct locks.
 */
export const withInterprocessLock = async <T>(
  resourcePath: string,
  fn: () => Promise<T>,
  options: InterprocessLockOptions = {},
): Promise<T> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new RangeError('Lock timeout must be a finite nonnegative number');
  options.signal?.throwIfAborted();
  const resource = await canonicalResource(resourcePath);
  const inherited = heldLocks.getStore();
  const parent = inherited?.get(resource);
  if (parent?.active) {
    const previous = parent.children;
    let release!: () => void;
    const completed = new Promise<void>((resolve) => (release = resolve));
    parent.children = previous.then(() => completed);
    await previous;
    try {
      options.signal?.throwIfAborted();
      if (!parent.active) return await withInterprocessLock(resource, fn, options);
      return await runOwned(
        resource,
        inherited,
        { active: false, children: Promise.resolve() },
        fn,
      );
    } finally {
      release();
    }
  }

  const lockPath = resource + '.lock.sqlite';
  // Do not open/close an existing sidecar with an unrelated fs handle: on
  // POSIX that close could release another SQLite connection's process locks.
  // Creating a missing file is synchronous so no same-process holder can
  // acquire its lock between this descriptor's creation and close.
  try {
    closeSync(openSync(lockPath, 'wx', 0o600));
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  const stat = lstatSync(lockPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error('The storage lock must be a regular, unaliased file');

  const database = new DatabaseSync(lockPath);
  let acquired = false;
  const owner: LockOwner = { active: false, children: Promise.resolve() };
  try {
    database.exec('PRAGMA busy_timeout = 0');
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        database.exec('BEGIN IMMEDIATE');
        acquired = true;
        break;
      } catch (error) {
        if (!isBusy(error)) throw error;
        if (performance.now() >= deadline)
          throw new Error('Timed out waiting for another process to finish a storage write', {
            cause: error,
          });
        // A synchronous SQLite busy wait would block a same-process lock
        // holder from finishing its awaited filesystem/database operation.
        await delay(Math.min(25, Math.max(1, deadline - performance.now())), undefined, {
          signal: options.signal,
        });
      }
    }
    return await runOwned(resource, inherited, owner, fn);
  } finally {
    owner.active = false;
    try {
      if (acquired) database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  }
};
