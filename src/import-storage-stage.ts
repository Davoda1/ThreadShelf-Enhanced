import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;

/** Replay permits optimistic retries without retaining the normalized export in RAM. */
export const createImportReplay = async <T>(
  databaseRoot: string,
  records: AsyncIterable<T>,
  retainedRoot?: string,
) => {
  const parent = retainedRoot ?? join(databaseRoot, '.threadshelf-staging');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = retainedRoot ? join(parent, 'replay') : await mkdtemp(join(parent, 'replay-'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'input.sqlite');
  const db = new DatabaseSync(path);
  await chmod(path, 0o600);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192; CREATE TABLE IF NOT EXISTS records(seq INTEGER PRIMARY KEY,value TEXT NOT NULL); DELETE FROM records;',
  );
  const put = db.prepare('INSERT INTO records(value) VALUES(?)');
  let batch: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const space = await statfs(root);
    if (space.bavail * space.bsize < Math.max(256 * 1024 ** 2, bytes * 2))
      throw new Error(
        'Insufficient free disk space to stage the import; the published collection was preserved.',
      );
    db.exec('BEGIN');
    try {
      for (const record of batch) put.run(record);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    batch = [];
    bytes = 0;
  };
  try {
    for await (const record of records) {
      const value = JSON.stringify(record);
      if (batch.length && (batch.length >= 32 || bytes + value.length * 2 > 8 * 1024 ** 2))
        await flush();
      batch.push(value);
      bytes += value.length * 2;
    }
    await flush();
  } catch (error) {
    db.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    // Attempts keep their embedding cache adjacent to the replay database.
    stagingDirectory: retainedRoot ?? root,
    async *records(): AsyncGenerator<T> {
      for (const row of db.prepare('SELECT value FROM records ORDER BY seq').iterate())
        yield JSON.parse(String(row.value)) as T;
    },
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

/** Disk-backed joins and reusable completed embedding batches, never an archive-sized JS map. */
export const createImportStorageStage = async (databaseRoot: string, retainedRoot?: string) => {
  const parent = retainedRoot
    ? join(retainedRoot, 'storage')
    : join(databaseRoot, '.threadshelf-staging');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = retainedRoot ? parent : await mkdtemp(join(parent, 'import-'));
  const filename = join(root, 'stage.sqlite');
  const db = new DatabaseSync(filename);
  await chmod(filename, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA temp_store = FILE;
    PRAGMA cache_size = -8192;
    CREATE TABLE IF NOT EXISTS previous_rows (identity TEXT PRIMARY KEY, value TEXT NOT NULL, matched INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS next_rows (seq INTEGER PRIMARY KEY, identity TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS embeddings (identity TEXT PRIMARY KEY, value TEXT NOT NULL);
    DELETE FROM previous_rows;
    DELETE FROM next_rows;
  `);
  const identity = (row: Row) => JSON.stringify([row.sourceFile, row.conversationKey]);
  const previousPut = db.prepare(
    'INSERT OR REPLACE INTO previous_rows(identity,value,matched) VALUES(?,?,0)',
  );
  const previousGet = db.prepare('SELECT value FROM previous_rows WHERE identity=?');
  const match = db.prepare('UPDATE previous_rows SET matched=1 WHERE identity=?');
  const nextPut = db.prepare(
    'INSERT INTO next_rows(identity,value) VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET value=excluded.value',
  );
  const embeddingPut = db.prepare('INSERT OR IGNORE INTO embeddings(identity,value) VALUES(?,?)');
  const embeddingGet = db.prepare('SELECT value FROM embeddings WHERE identity=?');
  // The model, quantization, pooling and normalisation are part of cache identity.
  let modelIdentity: string = randomUUID();
  const embeddingIdentity = (text: string) =>
    createHash('sha256').update(`${modelIdentity}\0`).update(text).digest('hex');
  const decode = (entry: unknown): Row =>
    JSON.parse(String((entry as { value: string }).value)) as Row;
  const checkDisk = async (extraBytes = 0) => {
    const state = await statfs(root);
    if (state.bavail * state.bsize < Math.max(256 * 1024 ** 2, extraBytes * 2)) {
      throw new Error(
        'Insufficient free disk space to stage the import; the published collection was preserved.',
      );
    }
  };
  try {
    await checkDisk();
  } catch (error) {
    db.close();
    throw error;
  }
  let pending: { key: string; value?: string }[] = [];
  let pendingBytes = 0;
  const flushPending = () => {
    if (!pending.length) return;
    db.exec('BEGIN');
    try {
      for (const operation of pending) {
        if (operation.value === undefined) match.run(operation.key);
        else nextPut.run(operation.key, operation.value);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    pending = [];
    pendingBytes = 0;
  };
  const queue = (key: string, value?: string) => {
    const size = key.length * 2 + (value?.length ?? 0) * 2;
    if (pending.length && (pending.length >= 64 || pendingBytes + size > 8 * 1024 ** 2))
      flushPending();
    pending.push({ key, value });
    pendingBytes += size;
  };
  return {
    root,
    setEmbeddingIdentity(identity: string) {
      modelIdentity = identity || randomUUID();
    },
    putPrevious(row: Row) {
      previousPut.run(identity(row), JSON.stringify(row));
    },
    previous(sourceFile: string, conversationKey: string): Row | undefined {
      const entry = previousGet.get(JSON.stringify([sourceFile, conversationKey]));
      return entry ? decode(entry) : undefined;
    },
    matched(row: Row) {
      queue(identity(row));
    },
    *unmatched(): Generator<Row> {
      flushPending();
      for (const entry of db.prepare('SELECT value FROM previous_rows WHERE matched=0').iterate())
        yield decode(entry);
    },
    putNext(row: Row) {
      queue(
        identity(row),
        JSON.stringify({
          ...row,
          storageBytes:
            (String(row.turnsJson ?? '').length +
              String(row.rawJson ?? '').length +
              String(row.sourceIdentityJson ?? '').length) *
              2 +
            4096,
        }),
      );
    },
    *next(): Generator<Row> {
      flushPending();
      for (const entry of db.prepare('SELECT value FROM next_rows ORDER BY seq').iterate())
        yield decode(entry);
    },
    get count(): number {
      flushPending();
      return Number(db.prepare('SELECT COUNT(*) AS n FROM next_rows').get()?.n ?? 0);
    },
    cachedEmbedding(text: string): number[] | undefined {
      const entry = embeddingGet.get(embeddingIdentity(text));
      return entry ? (JSON.parse(String(entry.value)) as number[]) : undefined;
    },
    putEmbedding(text: string, vector: readonly number[]) {
      embeddingPut.run(embeddingIdentity(text), JSON.stringify(vector));
    },
    transaction<T>(fn: () => T): T {
      flushPending();
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    checkDisk,
    async close(success: boolean) {
      db.close();
      if (success || !retainedRoot) await rm(root, { recursive: true, force: true });
    },
  };
};
