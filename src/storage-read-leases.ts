import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dataPath } from './paths.js';
import { setTimeout as delay } from 'node:timers/promises';

interface ReadOwner {
  active: boolean;
  children: Set<Promise<unknown>>;
}
const heldRead = new AsyncLocalStorage<ReadOwner>();
let initialized: string | undefined;
const leasePath = (): string => {
  if (initialized) return initialized;
  const root = resolve(process.env.LANCEDB_PATH || dataPath('lancedb'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, '.threadshelf-read-leases.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(
      'PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY);',
    );
  } finally {
    db.close();
  }
  chmodSync(path, 0o600);
  initialized = path;
  return path;
};

/** Shared OS read locks protect retired generations held by in-flight queries. */
export const withStorageReadLease = async <T>(fn: () => Promise<T>): Promise<T> => {
  const parent = heldRead.getStore();
  if (parent?.active) {
    const child = fn();
    parent.children.add(child);
    try {
      return await child;
    } finally {
      parent.children.delete(child);
    }
  }
  const db = new DatabaseSync(leasePath());
  const owner: ReadOwner = { active: true, children: new Set() };
  let owned = false;
  try {
    db.exec('PRAGMA busy_timeout = 0;');
    const deadline = performance.now() + 30_000;
    for (;;) {
      db.exec('BEGIN;');
      try {
        // Reading the table is what obtains SQLite's shared OS lock.
        db.prepare('SELECT id FROM lease LIMIT 1').get();
        owned = true;
        break;
      } catch (error) {
        db.exec('ROLLBACK');
        const code = (error as { errcode?: number }).errcode;
        if (
          typeof code !== 'number' ||
          ![5, 6].includes(code & 0xff) ||
          performance.now() >= deadline
        )
          throw error;
        await delay(25);
      }
    }
    return await heldRead.run(owner, fn);
  } finally {
    while (owner.children.size) await Promise.allSettled([...owner.children]);
    owner.active = false;
    try {
      if (owned) db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  }
};

/** Maintenance never waits on active readers, including readers in another process. */
export const withExclusiveStorageRetirement = async (fn: () => Promise<void>): Promise<boolean> => {
  if (heldRead.getStore()?.active) return false;
  const db = new DatabaseSync(leasePath());
  let owned = false;
  try {
    try {
      db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
      owned = true;
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (typeof code === 'number' && [5, 6].includes(code & 0xff)) return false;
      throw error;
    }
    await fn();
    return true;
  } finally {
    try {
      if (owned) db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  }
};
