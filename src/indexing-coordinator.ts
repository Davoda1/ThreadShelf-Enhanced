import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, existsSync, lstatSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataPath } from './paths.js';
import { withInterprocessLock, type InterprocessLockOptions } from './interprocess-lock.js';

/** Locks and durable jobs follow the database, including explicit path overrides. */
export const indexingDataPath = (...parts: string[]): string =>
  join(resolve(process.env.LANCEDB_PATH || dataPath('lancedb')), ...parts);

export class CollectionBusyError extends Error {
  readonly code = 'COLLECTION_BUSY';
  readonly status = 409;
  constructor(readonly collection: string) {
    super(
      `Collection "${collection}" is busy. Wait for its import or update to finish, or cancel the import first.`,
    );
    this.name = 'CollectionBusyError';
  }
}

export class IndexingBusyError extends Error {
  readonly code = 'INDEXING_BUSY';
  readonly status = 409;
  constructor() {
    super('Another indexing process is already running for this database.');
    this.name = 'IndexingBusyError';
  }
}

const reservationPath = (collection: string): string =>
  indexingDataPath(
    '.coordination',
    `collection-${createHash('sha256').update(collection).digest('hex')}`,
  );

const clearReservations = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();
const sqliteBusy = (error: unknown): boolean => {
  const code = (error as { errcode?: unknown })?.errcode;
  return typeof code === 'number' && [5, 6].includes(code & 0xff);
};

const isLockTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  error.message === 'Timed out waiting for another process to finish a storage write';

/** A crashed clear job retains its logical reservation until recovery or cancellation. */
const hasPendingClearJob = (collection: string): boolean => {
  const path = indexingDataPath('.import-jobs', 'jobs.sqlite');
  if (!existsSync(path)) return false;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 0');
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'")
      .get();
    if (!table) return false;
    const columns = database.prepare('PRAGMA table_info(jobs)').all();
    const clear = columns.some((column) => column.name === 'clearFirst')
      ? 'clearFirst = 1'
      : "json_extract(value, '$.clearFirst') = 1";
    return Boolean(
      database
        .prepare(
          `SELECT 1 FROM jobs WHERE collection=? AND ${clear} AND state IN ('running','paused','interrupted') LIMIT 1`,
        )
        .get(collection),
    );
  } finally {
    database.close();
  }
};

/** Every collection mutation participates, including thread edits and index recovery. */
export const withCollectionMutationGuard = async <T>(
  collection: string,
  fn: () => Promise<T>,
): Promise<T> => {
  if (clearReservations.getStore()?.get(collection)?.active) return fn();
  if (hasPendingClearJob(collection)) throw new CollectionBusyError(collection);
  const lockPath = reservationPath(collection) + '.lock.sqlite';
  await mkdir(dirname(lockPath), { recursive: true });
  // As in interprocess-lock.ts, never open/close an unrelated descriptor for
  // an existing SQLite sidecar while another connection may own its OS locks.
  try {
    closeSync(openSync(lockPath, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(lockPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error('The collection reservation must be a regular, unaliased file');
  const database = new DatabaseSync(lockPath);
  let acquired = false;
  try {
    database.exec('PRAGMA busy_timeout = 0; BEGIN');
    // Reading the schema acquires a SQLite SHARED lock. Normal mutations can
    // coexist and retain their existing write serialization. A clear job's
    // EXCLUSIVE transaction excludes them without blocking the event loop.
    database.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
    acquired = true;
    return await fn();
  } catch (error) {
    if (!acquired && sqliteBusy(error)) throw new CollectionBusyError(collection);
    throw error;
  } finally {
    try {
      database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  }
};

const withClearReservation = <T>(
  collection: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> => {
  if (clearReservations.getStore()?.get(collection)?.active) return fn();
  return withInterprocessLock(
    reservationPath(collection),
    async () => {
      const owned = new Map(clearReservations.getStore());
      const owner = { active: true };
      owned.set(collection, owner);
      try {
        return await clearReservations.run(owned, fn);
      } finally {
        owner.active = false;
      }
    },
    { exclusiveTransaction: true, signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  );
};

/** Short per-collection serialization of job acceptance, claiming and deletion. */
export const withCollectionJobLifecycle = <T>(
  collection: string,
  fn: () => Promise<T>,
): Promise<T> => withInterprocessLock(reservationPath(collection) + '-lifecycle', fn);

/** Destructive operations exclude collection writes without taking the global indexer. */
export const withExclusiveCollectionMutation = async <T>(
  collection: string,
  fn: () => Promise<T>,
): Promise<T> => {
  try {
    return await withClearReservation(collection, fn, undefined, 0);
  } catch (error) {
    if (isLockTimeout(error)) throw new CollectionBusyError(collection);
    throw error;
  }
};

/**
 * Global indexer -> collection reservation -> existing collection/thread locks.
 * The lock is reentrant within the owning async operation. OS ownership, not a
 * PID file or an expiring heartbeat, protects against concurrent processes.
 */
export const withIndexOperation = async <T>(
  collection: string | undefined,
  clearFirst: boolean,
  fn: () => Promise<T>,
  options: InterprocessLockOptions = {},
): Promise<T> => {
  try {
    return await withInterprocessLock(
      indexingDataPath('.coordination', 'indexer'),
      () =>
        clearFirst && collection ? withClearReservation(collection, fn, options.signal) : fn(),
      { timeoutMs: 24 * 60 * 60 * 1000, ...options },
    );
  } catch (error) {
    if (isLockTimeout(error)) throw new IndexingBusyError();
    throw error;
  }
};

/** Held for the HTTP server's lifetime, independently of its host/port. */
export const withServerInstance = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await withInterprocessLock(indexingDataPath('.coordination', 'server'), fn, {
      timeoutMs: 0,
    });
  } catch (error) {
    if (isLockTimeout(error)) {
      throw new Error(
        'A ThreadShelf server is already running for this database. Stop it before starting another instance.',
        { cause: error },
      );
    }
    throw error;
  }
};
