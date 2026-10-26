import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dataPath } from './paths.js';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One tiny transaction publishes the archive generation and its matching vector
 * table together. Conversation data remains in LanceDB. A staged generation is
 * invisible until this record commits, including after a killed importer.
 */
export interface StoragePublication {
  readonly collection: string;
  readonly generation: string;
  readonly indexTable: string | null;
  readonly previousGeneration: string;
  readonly previousIndexTable: string | null;
  readonly publishedAt: number;
  readonly embeddingIdentity: string;
}

let database: DatabaseSync | undefined;
let activeSnapshots = 0;
const readSnapshot = new AsyncLocalStorage<{
  active: boolean;
  values: ReadonlyMap<string, StoragePublication>;
}>();
const publicationDb = (): DatabaseSync => {
  if (database) return database;
  const root = resolve(process.env.LANCEDB_PATH || dataPath('lancedb'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, '.threadshelf-publication.sqlite');
  database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS publications (
      collection TEXT PRIMARY KEY,
      generation TEXT NOT NULL,
      indexTable TEXT,
      previousGeneration TEXT NOT NULL,
      previousIndexTable TEXT,
      publishedAt INTEGER NOT NULL,
      embeddingIdentity TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS staged_generations (
      collection TEXT NOT NULL, generation TEXT PRIMARY KEY, indexTable TEXT NOT NULL
    );
  `);
  if (
    !(database.prepare('PRAGMA table_info(publications)').all() as { name: string }[]).some(
      (column) => column.name === 'embeddingIdentity',
    )
  )
    database.exec("ALTER TABLE publications ADD COLUMN embeddingIdentity TEXT NOT NULL DEFAULT ''");
  return database;
};

/** Release the metadata handle after callers have stopped all store work. */
export const closeStoragePublication = (): void => {
  if (activeSnapshots) throw new Error('Cannot close storage publication while reads are active');
  // Transactions are synchronous, so no write can be in flight between calls.
  database?.close();
  database = undefined;
};

export const getStoragePublication = (collection: string): StoragePublication | undefined =>
  readSnapshot.getStore()?.active
    ? readSnapshot.getStore()!.values.get(collection)
    : (publicationDb()
        .prepare('SELECT * FROM publications WHERE collection = ?')
        .get(collection) as StoragePublication | undefined);

export const listStoragePublications = (): StoragePublication[] =>
  readSnapshot.getStore()?.active
    ? [...readSnapshot.getStore()!.values.values()]
    : (publicationDb()
        .prepare('SELECT * FROM publications ORDER BY collection')
        .all() as unknown as StoragePublication[]);

/** A query sees one archive/index mapping even if another process publishes midway. */
export const withPublicationSnapshot = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (readSnapshot.getStore()?.active) {
    activeSnapshots++;
    try {
      return await fn();
    } finally {
      activeSnapshots--;
    }
  }
  const snapshot = {
    active: true,
    values: new Map(listStoragePublications().map((entry) => [entry.collection, entry])),
  };
  activeSnapshots++;
  try {
    return await readSnapshot.run(snapshot, fn);
  } finally {
    snapshot.active = false;
    activeSnapshots--;
  }
};

export const publishStorageGeneration = (
  collection: string,
  generation: string,
  indexTable: string | null,
  embeddingIdentity = '',
): void => {
  const db = publicationDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = getStoragePublication(collection);
    db.prepare(
      `INSERT INTO publications
      (collection,generation,indexTable,previousGeneration,previousIndexTable,publishedAt,embeddingIdentity)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(collection) DO UPDATE SET
        generation=excluded.generation,indexTable=excluded.indexTable,
        previousGeneration=excluded.previousGeneration,
        previousIndexTable=excluded.previousIndexTable,publishedAt=excluded.publishedAt,
        embeddingIdentity=excluded.embeddingIdentity`,
    ).run(
      collection,
      generation,
      indexTable,
      previous?.generation === generation
        ? previous.previousGeneration
        : (previous?.generation ?? ''),
      previous?.generation === generation
        ? previous.previousIndexTable
        : previous
          ? previous.indexTable
          : collection,
      Date.now(),
      embeddingIdentity,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

export const invalidatePublicationEmbeddings = (collection: string): void => {
  publicationDb()
    .prepare("UPDATE publications SET embeddingIdentity='' WHERE collection=?")
    .run(collection);
};

export const registerStagedGeneration = (
  collection: string,
  generation: string,
  indexTable: string,
): void => {
  publicationDb()
    .prepare('INSERT INTO staged_generations(collection,generation,indexTable) VALUES(?,?,?)')
    .run(collection, generation, indexTable);
};
export const listStagedGenerations = (): {
  collection: string;
  generation: string;
  indexTable: string;
}[] =>
  publicationDb()
    .prepare('SELECT collection,generation,indexTable FROM staged_generations')
    .all() as { collection: string; generation: string; indexTable: string }[];
export const forgetStagedGeneration = (generation: string): void => {
  publicationDb().prepare('DELETE FROM staged_generations WHERE generation=?').run(generation);
};

export const forgetStoragePublication = (collection: string): void => {
  publicationDb().prepare('DELETE FROM publications WHERE collection = ?').run(collection);
};

const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Predicate applied to every archive read/write, including cross-collection reads. */
export const activeThreadFilter = (collection?: string | null): string => {
  if (collection) {
    const generation = getStoragePublication(collection)?.generation ?? '';
    return `collection = ${quote(collection)} AND importGeneration = ${quote(generation)}`;
  }
  const publications = listStoragePublications();
  if (!publications.length) return "importGeneration = ''";
  return `((importGeneration = '' AND collection NOT IN (${publications.map((p) => quote(p.collection)).join(',')})) OR ${publications
    .map(
      (p) => `(collection = ${quote(p.collection)} AND importGeneration = ${quote(p.generation)})`,
    )
    .join(' OR ')})`;
};
