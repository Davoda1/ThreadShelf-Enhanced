import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { dataPath } from './paths.js';
import { embed, embedOne, getEmbeddingIdentity } from './embedding.js';
import { chunkTurns, isIndexableText } from './chunking.js';
import { validateTurns } from './validation.js';
import type { Provider } from './parser.js';
import { createHash, randomUUID } from 'node:crypto';
import { portableModelLabel } from './model-label.js';
import { join } from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { withInterprocessLock } from './interprocess-lock.js';
import { snapshotFingerprint } from './snapshot-fingerprint.js';
import {
  activeThreadFilter,
  registerStagedGeneration,
  listStagedGenerations,
  forgetStagedGeneration,
  withPublicationSnapshot,
  invalidatePublicationEmbeddings,
  forgetStoragePublication,
  getStoragePublication,
  listStoragePublications,
  publishStorageGeneration,
} from './storage-publication.js';
import { createImportStorageStage, createImportReplay } from './import-storage-stage.js';
import {
  IndexingBusyError,
  withCollectionMutationGuard,
  withIndexOperation,
} from './indexing-coordinator.js';
import { memoryCheckpoint, recommendedBatchSize, type MemoryStatus } from './memory-governor.js';
import { withStorageReadLease, withExclusiveStorageRetirement } from './storage-read-leases.js';

const DB_PATH = process.env.LANCEDB_PATH || dataPath('lancedb');
const EMBED_BATCH_SIZE = Math.max(1, Number(process.env.EMBED_BATCH_SIZE) || 25);

let db: Connection | null = null;
const tableCache = new Map<string, Table>();
const COLLECTION_STATS_CACHE_MS = 5_000;
const collectionStatsCache = new Map<
  string,
  { readonly expiresAt: number; readonly value: Promise<CollectionStats> }
>();

const invalidateCollectionStats = (collection: string): void => {
  collectionStatsCache.delete(collection);
};

const getDb = async (): Promise<Connection> => {
  if (!db) {
    try {
      // Server, MCP and CLI share one database. Cached table handles must see
      // each other's commits (pending index jobs, retry times, deletions).
      db = await connect(DB_PATH, { readConsistencyInterval: 0 });
    } catch (e) {
      const err = new Error((e as Error)?.message || 'LanceDB connect failed');
      err.cause = e;
      throw err;
    }
  }
  return db;
};

const openTable = async (collection: string): Promise<Table | null> => {
  const publication = collection.startsWith('__') ? undefined : getStoragePublication(collection);
  if (publication && !publication.indexTable) return null;
  const physical = publication?.indexTable ?? collection;
  const cached = tableCache.get(physical);
  if (cached) return cached;

  const database = await getDb();
  const names = await database.tableNames();
  if (!names.includes(physical)) return null;

  const opened = await database.openTable(physical);
  tableCache.set(physical, opened);
  return opened;
};

const escapeSqlString = (value: string): string => value.replace(/'/g, "''");

export interface ChunkRow {
  readonly id: string;
  readonly text: string;
  readonly sourceFile: string;
  readonly provider: string;
  readonly role: string;
  readonly turnIndex: number;
  readonly conversationKey?: string;
  readonly title?: string;
  readonly model?: string;
  readonly createdAt?: string;
  readonly createdInThreadShelf?: boolean;
  readonly generationProvider?: string;
}

interface ChunkWriteOptions {
  readonly signal?: AbortSignal;
  readonly stagingDirectory?: string;
  readonly onMemoryPressure?: (status: MemoryStatus) => void | Promise<void>;
  readonly onEmbeddingProgress?: (
    done: number,
    total: number,
    tokens: number,
  ) => void | Promise<void>;
}

interface EmbeddedChunkRow extends Record<string, unknown> {
  readonly id: string;
  readonly vector: number[];
  readonly document: string;
  readonly sourceFile: string;
  readonly provider: string;
  readonly conversationKey: string;
  readonly title: string;
  readonly role: string;
  readonly turnIndex: string;
  readonly model: string;
  readonly createdAt: string;
  readonly createdInThreadShelf: boolean;
  readonly generationProvider: string;
}

const ensureChunkMetadataSchema = async (tbl: Table, collection: string): Promise<void> => {
  const missingColumns = async () => {
    const schema = await tbl.schema();
    const existing = new Set(schema.fields.map((field) => field.name));
    return [
      ...['provider', 'conversationKey', 'title', 'model', 'createdAt', 'generationProvider'].map(
        (name) => ({ name, valueSql: "''" }),
      ),
      { name: 'createdInThreadShelf', valueSql: 'false' },
    ].filter((column) => !existing.has(column.name));
  };
  // Normal searches must keep reading published rows while another process
  // prepares embeddings under its collection lock. Only migration writes wait.
  if (!(await missingColumns()).length) return;
  await withInterprocessLock(collectionLockResource(collection), async () => {
    const missing = await missingColumns();
    if (missing.length) await tbl.addColumns(missing);
  });
};

// A merge is one LanceDB commit: an insertion failure cannot expose a delete.
const replaceEmbeddedRowsLocked = async (
  collection: string,
  where: string,
  rows: EmbeddedChunkRow[],
): Promise<void> => {
  const tbl = await openTable(collection);
  if (tbl) {
    await ensureChunkMetadataSchema(tbl, collection);
    if (!rows.length) await tbl.delete(where);
    else
      await tbl
        .mergeInsert('id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .whenNotMatchedBySourceDelete({ where })
        .execute(rows);
  } else if (rows.length) {
    const publication = getStoragePublication(collection);
    const name = publication
      ? `__index_${createHash('sha256').update(collection).digest('hex').slice(0, 32)}_${randomUUID().replaceAll('-', '')}`
      : collection;
    const created = await (await getDb()).createTable(name, rows, { mode: 'create' });
    tableCache.set(name, created);
    if (publication)
      publishStorageGeneration(
        collection,
        publication.generation,
        name,
        await getEmbeddingIdentity(),
      );
  }
  const publication = getStoragePublication(collection);
  if (
    rows.length &&
    publication?.embeddingIdentity &&
    publication.embeddingIdentity !== (await getEmbeddingIdentity())
  )
    invalidatePublicationEmbeddings(collection);
  invalidateCollectionStats(collection);
};

const embedChunks = async (
  chunks: ChunkRow[],
  signal?: AbortSignal,
  onProgress?: ChunkWriteOptions['onEmbeddingProgress'],
  onMemoryPressure?: ChunkWriteOptions['onMemoryPressure'],
): Promise<EmbeddedChunkRow[]> => {
  const tokens = chunks.reduce((sum, chunk) => sum + Math.ceil(chunk.text.length / 4), 0);
  await onProgress?.(0, chunks.length, tokens);
  if (chunks.length === 0) return [];
  const rows: EmbeddedChunkRow[] = [];

  for (let i = 0; i < chunks.length;) {
    await memoryCheckpoint({ signal, onPressure: onMemoryPressure });
    const batch = chunks.slice(i, i + recommendedBatchSize(EMBED_BATCH_SIZE));
    i += batch.length;
    const texts = batch.map((ch) => ch.text);
    const embeddings = await embed(texts);
    signal?.throwIfAborted();
    rows.push(
      ...batch.map((ch, j) => ({
        id: ch.id,
        vector: embeddings[j]!,
        document: ch.text,
        sourceFile: ch.sourceFile,
        provider: ch.provider,
        conversationKey: ch.conversationKey ?? '',
        title: ch.title ?? '',
        role: ch.role,
        turnIndex: String(ch.turnIndex),
        model: ch.model ?? '',
        createdAt: ch.createdAt ?? '',
        createdInThreadShelf: ch.createdInThreadShelf ?? false,
        generationProvider: ch.generationProvider ?? '',
      })),
    );
    await onProgress?.(rows.length, chunks.length, tokens);
  }
  return rows;
};

// --- Stored threads ---
//
// Normalized conversation turns are persisted at ingest time in a single
// internal table so the thread view no longer depends on the original export
// file staying in place (or unchanged — LM Studio rewrites its files). User
// collection names can never start with an underscore (normalizeCollectionName
// strips them), so the "__" prefix is reserved for internal tables.

const THREADS_TABLE = '__threads';

export interface ThreadConversationInput {
  readonly raw?: unknown;
  readonly sourceIdentity?: unknown;
  readonly provider?: string;
  readonly key: string;
  readonly title: string;
  readonly turns: readonly unknown[];
  readonly createdInThreadShelf?: boolean;
  readonly threadCreatedAt?: string;
}

export interface StoredThreadRow {
  readonly collection: string;
  readonly sourceFile: string;
  readonly conversationKey: string;
  readonly title: string;
  readonly provider: string;
  readonly ordinal: number;
  readonly turnCount: number;
  readonly turnsJson: string;
  readonly rawJson: string;
  readonly sourceIdentityJson: string;
  readonly ingestedAt: string;
  readonly lastTurnAt: string;
  readonly lastModel: string;
  readonly createdInThreadShelf: boolean;
  readonly threadCreatedAt: string;
  readonly hasThreadShelfTurns: boolean;
  readonly indexPending: string;
}

export interface ThreadSummaryRow {
  readonly sourceFile: string;
  readonly conversationKey: string;
  readonly title: string;
  readonly provider: string;
  readonly ordinal: number;
  readonly turnCount: number;
  readonly lastTurnAt: string;
  readonly lastModel: string;
  readonly createdInThreadShelf: boolean;
  readonly threadCreatedAt: string;
  readonly hasThreadShelfTurns: boolean;
}

export class StoredThreadWriteError extends Error {
  constructor(message = 'Stored thread changed or disappeared before it could be saved') {
    super(message);
    this.name = 'StoredThreadWriteError';
  }
}

const storedThreadRow = (row: Record<string, unknown>): StoredThreadRow => ({
  collection: (row.collection as string) ?? '',
  sourceFile: (row.sourceFile as string) ?? '',
  conversationKey: (row.conversationKey as string) ?? '',
  title: (row.title as string) ?? '',
  provider: (row.provider as string) ?? '',
  ordinal: Number(row.ordinal) || 0,
  turnCount: Number(row.turnCount) || 0,
  turnsJson: (row.turnsJson as string) ?? '',
  rawJson: (row.rawJson as string) ?? '',
  sourceIdentityJson: (row.sourceIdentityJson as string) ?? '',
  ingestedAt: (row.ingestedAt as string) ?? '',
  lastTurnAt: (row.lastTurnAt as string) ?? '',
  lastModel: (row.lastModel as string) ?? '',
  createdInThreadShelf: Boolean(row.createdInThreadShelf),
  threadCreatedAt: (row.threadCreatedAt as string) ?? '',
  hasThreadShelfTurns: Boolean(row.hasThreadShelfTurns || row.createdInThreadShelf),
  indexPending: String(row.indexPending || ''),
});

// Latest turn timestamp in a conversation — powers "sort by recent" in the
// browse list without re-reading turnsJson at query time.
const latestTurnTimestamp = (turns: readonly unknown[]): string => {
  let latest = '';
  for (const turn of turns) {
    const createdAt = (turn as { createdAt?: unknown })?.createdAt;
    if (typeof createdAt === 'string' && createdAt > latest) latest = createdAt;
  }
  return latest;
};

const latestTurnModel = (turns: readonly unknown[]): string => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const model = (turns[index] as { model?: unknown })?.model;
    if (typeof model === 'string' && model.trim()) return model.trim();
  }
  return '';
};

const threadsSchemaMigrations = new WeakMap<Table, Promise<void>>();

// Schema upgrades on the request path must remain additive and bounded. In
// particular, do not backfill metadata by materializing turnsJson for every
// archived conversation: large databases would make the first request appear
// empty or hung. Existing rows use their normal ingestedAt fallbacks and gain
// the metadata naturally the next time they are written.
const migrateThreadsSchema = async (tbl: Table): Promise<void> => {
  let schema = await tbl.schema();
  if (!schema.fields.some((field) => field.name === 'lastTurnAt')) {
    try {
      await tbl.addColumns([{ name: 'lastTurnAt', valueSql: "''" }]);
    } catch (e) {
      // Another process may have added the column concurrently.
      const refreshed = await tbl.schema();
      if (!refreshed.fields.some((field) => field.name === 'lastTurnAt')) throw e;
    }
  }

  schema = await tbl.schema();
  const metadataColumns = [
    { name: 'rawJson', valueSql: "''" },
    { name: 'sourceIdentityJson', valueSql: "''" },
    { name: 'createdInThreadShelf', valueSql: 'false' },
    { name: 'threadCreatedAt', valueSql: "''" },
    { name: 'hasThreadShelfTurns', valueSql: 'false' },
    { name: 'lastModel', valueSql: "''" },
    { name: 'indexPending', valueSql: "''" },
    { name: 'indexAttempts', valueSql: '0.0' },
    { name: 'indexRetryAt', valueSql: '0.0' },
    { name: 'indexError', valueSql: "''" },
    { name: 'importGeneration', valueSql: "''" },
    { name: 'storageBytes', valueSql: '0.0' },
  ].filter((column) => !schema.fields.some((field) => field.name === column.name));
  if (metadataColumns.length) {
    try {
      await tbl.addColumns(metadataColumns);
    } catch (e) {
      // A second server/watch process may have performed the same additive
      // migration between our schema read and this write.
      const refreshed = await tbl.schema();
      if (metadataColumns.some((column) => !refreshed.fields.some((f) => f.name === column.name))) {
        throw e;
      }
    }
  }
};

const ensureThreadsSchema = async (tbl: Table): Promise<void> => {
  const knownMigration = threadsSchemaMigrations.get(tbl);
  if (knownMigration) return knownMigration;
  const schema = await tbl.schema();
  const names = new Set(schema.fields.map((field) => field.name));
  if (
    [
      'lastTurnAt',
      'rawJson',
      'sourceIdentityJson',
      'createdInThreadShelf',
      'threadCreatedAt',
      'hasThreadShelfTurns',
      'lastModel',
      'indexPending',
      'indexAttempts',
      'indexRetryAt',
      'indexError',
      'importGeneration',
      'storageBytes',
    ].every((name) => names.has(name))
  ) {
    threadsSchemaMigrations.set(tbl, Promise.resolve());
    return;
  }
  await withInterprocessLock(collectionLockResource(THREADS_TABLE), async () => {
    // Acquire first, then publish the promise. A getter must never publish a
    // migration that waits for a lock held by a writer awaiting that promise.
    let migration = threadsSchemaMigrations.get(tbl);
    if (!migration) {
      migration = migrateThreadsSchema(tbl).catch((error) => {
        threadsSchemaMigrations.delete(tbl);
        throw error;
      });
      threadsSchemaMigrations.set(tbl, migration);
    }
    await migration;
  });
};

export const replaceThreadsForFile = async (
  collection: string,
  sourceFile: string,
  provider: string,
  conversations: readonly ThreadConversationInput[],
): Promise<void> => {
  return withCollectionMutationGuard(collection, () =>
    withCollectionWriteLock(THREADS_TABLE, async () => {
      const rows = threadRows(collection, sourceFile, provider, conversations, 'local');
      await replaceThreadRowsLocked(threadFileFilter(collection, sourceFile), rows);
      invalidateCollectionStats(collection);
    }),
  );
};

const threadFileFilter = (collection: string, sourceFile: string): string =>
  `${activeThreadFilter(collection)} AND sourceFile = '${escapeSqlString(sourceFile)}'`;

const threadRows = (
  collection: string,
  sourceFile: string,
  provider: string,
  conversations: readonly ThreadConversationInput[],
  indexPending: string,
): Record<string, unknown>[] => {
  const ingestedAt = new Date().toISOString();
  return conversations
    .map((conversation, ordinal) => ({
      collection,
      importGeneration: getStoragePublication(collection)?.generation ?? '',
      sourceFile,
      conversationKey: conversation.key ?? '',
      title: conversation.title ?? '',
      provider: conversation.provider ?? provider,
      ordinal,
      turnCount: conversation.turns.length,
      turnsJson: JSON.stringify(conversation.turns),
      rawJson: conversation.raw === undefined ? '' : JSON.stringify(conversation.raw),
      sourceIdentityJson:
        conversation.sourceIdentity === undefined
          ? ''
          : JSON.stringify(conversation.sourceIdentity),
      ingestedAt,
      lastTurnAt: latestTurnTimestamp(conversation.turns),
      lastModel: latestTurnModel(conversation.turns),
      createdInThreadShelf: conversation.createdInThreadShelf ?? false,
      threadCreatedAt: conversation.threadCreatedAt ?? '',
      indexPending,
      indexAttempts: 0,
      indexRetryAt: 0,
      indexError: '',
      hasThreadShelfTurns:
        conversation.createdInThreadShelf === true ||
        conversation.turns.some(
          (turn) => (turn as { createdInThreadShelf?: unknown })?.createdInThreadShelf === true,
        ),
    }))
    .map((row) => ({
      ...row,
      storageBytes:
        (row.turnsJson.length + row.rawJson.length + row.sourceIdentityJson.length) * 2 + 4096,
    }));
};

const replaceThreadRowsLocked = async (
  where: string,
  rows: Record<string, unknown>[],
): Promise<void> => {
  const tbl = await openTable(THREADS_TABLE);
  if (tbl) {
    await ensureThreadsSchema(tbl);
    // Tombstones are durable deletion jobs. They contain no conversation text.
    const oldRows = await tbl.query().where(where).limit(Number.MAX_SAFE_INTEGER).toArray();
    const keys = new Set(
      rows.map((row) => JSON.stringify([row.collection, row.sourceFile, row.conversationKey])),
    );
    const tombstones = oldRows
      .filter(
        (row) => !keys.has(JSON.stringify([row.collection, row.sourceFile, row.conversationKey])),
      )
      .map((row) => ({
        ...row,
        title: '',
        turnsJson: '[]',
        rawJson: '',
        sourceIdentityJson: '',
        lastModel: '',
        turnCount: 0,
        indexPending: 'delete',
      }));
    const next = [...rows, ...tombstones];
    if (next.length)
      await tbl
        .mergeInsert(['collection', 'sourceFile', 'conversationKey', 'importGeneration'])
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .whenNotMatchedBySourceDelete({ where })
        .execute(next);
  } else if (rows.length) {
    const database = await getDb();
    const created = await database.createTable(THREADS_TABLE, rows, { mode: 'create' });
    tableCache.set(THREADS_TABLE, created);
  }
};

export const updateStoredThread = async (
  collection: string,
  sourceFile: string,
  provider: string,
  conversation: ThreadConversationInput,
): Promise<void> => {
  return withCollectionMutationGuard(collection, () =>
    withCollectionWriteLock(THREADS_TABLE, async () => {
      const tbl = await openTable(THREADS_TABLE);
      if (!tbl) throw new Error('Stored thread table is unavailable');
      await ensureThreadsSchema(tbl);
      const ingestedAt = new Date().toISOString();
      const where = [
        activeThreadFilter(collection),
        `sourceFile = '${escapeSqlString(sourceFile)}'`,
        `conversationKey = '${escapeSqlString(conversation.key)}'`,
        "indexPending != 'delete'",
      ].join(' AND ');
      const current = await tbl.query().where(where).limit(1).toArray();
      const result = await tbl.update({
        where,
        values: {
          title: conversation.title,
          provider,
          turnCount: conversation.turns.length,
          storageBytes: 0,
          turnsJson: JSON.stringify(conversation.turns),
          ingestedAt,
          indexPending: current[0]?.indexPending === 'all' ? 'all' : 'local',
          indexAttempts: 0,
          indexRetryAt: 0,
          indexError: '',
          lastTurnAt: latestTurnTimestamp(conversation.turns),
          lastModel: latestTurnModel(conversation.turns),
          createdInThreadShelf: conversation.createdInThreadShelf ?? false,
          threadCreatedAt: conversation.threadCreatedAt ?? '',
          hasThreadShelfTurns:
            conversation.createdInThreadShelf === true ||
            conversation.turns.some(
              (turn) => (turn as { createdInThreadShelf?: unknown })?.createdInThreadShelf === true,
            ),
        },
      });
      if (result.rowsUpdated !== 1) throw new StoredThreadWriteError();
      invalidateCollectionStats(collection);
    }),
  );
};

export const updateStoredThreadFromCurrent = async (
  collection: string,
  sourceFile: string,
  conversationKey: string,
  update: (current: StoredThreadRow) => {
    readonly provider: string;
    readonly conversation: ThreadConversationInput;
  },
): Promise<ThreadConversationInput> => {
  return withCollectionMutationGuard(collection, () =>
    withCollectionWriteLock(THREADS_TABLE, async () => {
      const tbl = await openTable(THREADS_TABLE);
      if (!tbl) throw new StoredThreadWriteError('Stored thread table is unavailable');
      await ensureThreadsSchema(tbl);
      const where = [
        activeThreadFilter(collection),
        `sourceFile = '${escapeSqlString(sourceFile)}'`,
        `conversationKey = '${escapeSqlString(conversationKey)}'`,
        "indexPending != 'delete'",
      ].join(' AND ');
      const rows = await tbl.query().where(where).limit(2).toArray();
      if (rows.length !== 1) throw new StoredThreadWriteError();
      const next = update(storedThreadRow(rows[0] as Record<string, unknown>));
      const conversation = next.conversation;
      const result = await tbl.update({
        where,
        values: {
          title: conversation.title,
          provider: next.provider,
          turnCount: conversation.turns.length,
          storageBytes: 0,
          turnsJson: JSON.stringify(conversation.turns),
          ingestedAt: new Date().toISOString(),
          indexPending: rows[0].indexPending === 'all' ? 'all' : 'local',
          indexAttempts: 0,
          indexRetryAt: 0,
          indexError: '',
          lastTurnAt: latestTurnTimestamp(conversation.turns),
          lastModel: latestTurnModel(conversation.turns),
          createdInThreadShelf: conversation.createdInThreadShelf ?? false,
          threadCreatedAt: conversation.threadCreatedAt ?? '',
          hasThreadShelfTurns:
            conversation.createdInThreadShelf === true ||
            conversation.turns.some(
              (turn) => (turn as { createdInThreadShelf?: unknown })?.createdInThreadShelf === true,
            ),
        },
      });
      if (result.rowsUpdated !== 1) throw new StoredThreadWriteError();
      invalidateCollectionStats(collection);
      return conversation;
    }),
  );
};

const getStoredThreadsInternal = async (
  collection: string | null,
  sourceFile: string,
  conversationKey?: string,
): Promise<StoredThreadRow[]> => {
  try {
    const tbl = await openTable(THREADS_TABLE);
    if (!tbl) return [];
    await ensureThreadsSchema(tbl);
    const fileFilter = `sourceFile = '${escapeSqlString(sourceFile)}' AND indexPending NOT IN ('delete', 'reset')`;
    const where = `${activeThreadFilter(collection)} AND ${fileFilter}${conversationKey === undefined ? '' : ` AND conversationKey = '${escapeSqlString(conversationKey)}'`}`;
    const rows = await tbl.query().where(where).limit(Number.MAX_SAFE_INTEGER).toArray();
    return rows
      .map((row) => storedThreadRow(row as Record<string, unknown>))
      .sort((a, b) => a.ordinal - b.ordinal);
  } catch (error) {
    console.warn('[store:getStoredThreads]', error);
    return [];
  }
};

const listThreadSummariesInternal = async (collection: string): Promise<ThreadSummaryRow[]> => {
  try {
    const tbl = await openTable(THREADS_TABLE);
    if (!tbl) return [];
    await ensureThreadsSchema(tbl);
    const baseColumns = [
      'sourceFile',
      'conversationKey',
      'title',
      'provider',
      'ordinal',
      'turnCount',
      'createdInThreadShelf',
      'threadCreatedAt',
      'hasThreadShelfTurns',
      'lastModel',
    ];
    const fetch = (columns: string[]) =>
      tbl
        .query()
        .where(`${activeThreadFilter(collection)} AND indexPending NOT IN ('delete', 'reset')`)
        .select(columns)
        .limit(Number.MAX_SAFE_INTEGER)
        .toArray();

    let rows: Record<string, unknown>[];
    try {
      rows = await fetch([...baseColumns, 'lastTurnAt']);
    } catch (e) {
      // __threads created before the lastTurnAt column existed.
      if (!String((e as Error)?.message || '').includes('lastTurnAt')) throw e;
      rows = await fetch(baseColumns);
    }
    return rows.map((row) => ({
      sourceFile: (row.sourceFile as string) ?? '',
      conversationKey: (row.conversationKey as string) ?? '',
      title: (row.title as string) ?? '',
      provider: (row.provider as string) ?? '',
      ordinal: Number(row.ordinal) || 0,
      turnCount: Number(row.turnCount) || 0,
      lastTurnAt: (row.lastTurnAt as string) ?? '',
      lastModel: (row.lastModel as string) ?? '',
      createdInThreadShelf: Boolean(row.createdInThreadShelf),
      threadCreatedAt: (row.threadCreatedAt as string) ?? '',
      hasThreadShelfTurns: Boolean(row.hasThreadShelfTurns || row.createdInThreadShelf),
    }));
  } catch (error) {
    console.warn('[store:listThreadSummaries]', error);
    return [];
  }
};

export const deleteThreadsForCollection = async (collection: string): Promise<void> => {
  return withCollectionMutationGuard(collection, () =>
    withCollectionWriteLock(THREADS_TABLE, async () => {
      const tbl = await openTable(THREADS_TABLE);
      if (!tbl) return;
      await ensureThreadsSchema(tbl);
      await tbl.delete(`collection = '${escapeSqlString(collection)}'`);
      invalidateCollectionStats(collection);
    }),
  );
};

export interface ImportedFile {
  readonly sourceFile: string;
  readonly provider: string;
  readonly conversations: readonly ThreadConversationInput[];
}

const conversationFromRow = (
  row: Record<string, unknown>,
  includeOriginal = true,
): ThreadConversationInput | undefined => {
  try {
    return {
      key: String(row.conversationKey),
      title: String(row.title),
      turns: validateTurns(JSON.parse(String(row.turnsJson))),
      raw: includeOriginal && row.rawJson ? JSON.parse(String(row.rawJson)) : undefined,
      sourceIdentity:
        row.sourceIdentityJson && includeOriginal
          ? JSON.parse(String(row.sourceIdentityJson))
          : undefined,
      provider: String(row.provider || ''),
      createdInThreadShelf: Boolean(row.createdInThreadShelf),
      threadCreatedAt: String(row.threadCreatedAt || ''),
    };
  } catch {
    return undefined;
  }
};

const chunksFromThreadRows = (
  rows: Record<string, unknown>[],
): { chunks: ChunkRow[]; invalid: Record<string, unknown>[] } => {
  const invalid: Record<string, unknown>[] = [];
  const chunks = rows.flatMap((row) => {
    if (row.indexPending === 'delete' || row.indexPending === 'reset') return [];
    const conversation = conversationFromRow(row, false);
    if (!conversation) {
      invalid.push(row);
      return [];
    }
    const turns = validateTurns(conversation.turns);
    return chunkTurns(turns, {
      sourceFile: String(row.sourceFile),
      provider: row.provider as Provider | 'threadshelf',
      conversationKey: String(row.conversationKey),
      title: String(row.title),
    }).map((chunk, index) => ({
      ...chunk,
      provider: chunk.createdInThreadShelf ? 'threadshelf' : chunk.provider,
      id: `${row.sourceFile}|${row.conversationKey}|${chunk.turnIndex}|${index}`,
    }));
  });
  return { chunks, invalid };
};

const readThreadScope = async (where: string): Promise<Record<string, unknown>[]> => {
  const tbl = await openTable(THREADS_TABLE);
  if (!tbl) return [];
  await ensureThreadsSchema(tbl);
  return tbl
    .query()
    .where(`(${activeThreadFilter()}) AND (${where})`)
    .limit(Number.MAX_SAFE_INTEGER)
    .toArray();
};

/** One bounded record from the validated import spool. */
export interface ImportedConversationRecord {
  readonly sourceFile: string;
  readonly provider: string;
  readonly conversation: ThreadConversationInput;
}

const scanRows = async function* (
  table: Table,
  where = '',
  columns?: readonly string[],
  batchSize = 32,
): AsyncGenerator<Record<string, unknown>> {
  // A dedicated checked-out handle prevents offset pagination from observing a
  // moving table. Each result materialisation is bounded, including raw JSON.
  if (!columns) {
    // Project only size hints/row IDs first. Legacy or edited rows without a
    // trustworthy hint are fetched individually; one large row never gets
    // multiplied by a fixed 32-row payload page.
    for (let offset = 0; ; offset += 256) {
      let query = table.query().select(['storageBytes']).withRowId().limit(256).offset(offset);
      if (where) query = query.where(where);
      const metadata = await query.toArray();
      let ids: (number | bigint)[] = [];
      let bytes = 0;
      const fetch = async () => {
        const rows = await table.takeRowIds(ids).toArray({ maxBatchLength: ids.length });
        ids = [];
        bytes = 0;
        return rows as Record<string, unknown>[];
      };
      for (const item of metadata) {
        const size = Number(item.storageBytes);
        if (
          ids.length &&
          (!Number.isFinite(size) || size <= 0 || ids.length >= 32 || bytes + size > 8 * 1024 ** 2)
        )
          for (const row of await fetch()) yield row;
        ids.push(item._rowid as number | bigint);
        bytes += Number.isFinite(size) && size > 0 ? size : 8 * 1024 ** 2;
        if (!Number.isFinite(size) || size <= 0 || size >= 8 * 1024 ** 2)
          for (const row of await fetch()) yield row;
      }
      if (ids.length) for (const row of await fetch()) yield row;
      if (metadata.length < 256) return;
    }
  }
  for (let offset = 0; ; offset += batchSize) {
    let query = table.query().limit(batchSize).offset(offset);
    if (where) query = query.where(where);
    if (columns) query = query.select([...columns]);
    const rows = await query.toArray({ maxBatchLength: batchSize });
    for (const row of rows) yield row as Record<string, unknown>;
    if (rows.length < batchSize) return;
  }
};

const snapshotTable = async (name: string): Promise<Table | null> => {
  const publication = name.startsWith('__') ? undefined : getStoragePublication(name);
  if (publication && !publication.indexTable) return null;
  const physical = publication?.indexTable ?? name;
  const database = await getDb();
  if (!(await database.tableNames()).includes(physical)) return null;
  const table = await database.openTable(physical);
  if (name === THREADS_TABLE) await ensureThreadsSchema(table);
  await table.checkout(await table.version());
  return table;
};

const embeddedRow = (chunk: ChunkRow, vector: readonly number[]): EmbeddedChunkRow => ({
  id: chunk.id,
  vector: [...vector],
  document: chunk.text,
  sourceFile: chunk.sourceFile,
  provider: chunk.provider,
  conversationKey: chunk.conversationKey ?? '',
  title: chunk.title ?? '',
  role: chunk.role,
  turnIndex: String(chunk.turnIndex),
  model: chunk.model ?? '',
  createdAt: chunk.createdAt ?? '',
  createdInThreadShelf: chunk.createdInThreadShelf ?? false,
  generationProvider: chunk.generationProvider ?? '',
});

/**
 * Stage a complete collection generation in bounded batches, then publish one
 * durable pointer for both archive rows and vectors. No delete precedes commit;
 * cancellation, ENOSPC and process death retain the previously published data.
 * Existing generations are retained for in-flight readers and explicit recovery.
 */
const replaceImportedStreamAttempt = async (
  collection: string,
  records: AsyncIterable<ImportedConversationRecord>,
  options: ChunkWriteOptions & {
    readonly clearFirst?: boolean;
    readonly sourceFiles?: readonly string[];
    /** Internal recovery receives complete stored turns, including local turns. */
    readonly reindexOnly?: boolean;
  } = {},
): Promise<number> =>
  withIndexOperation(
    collection,
    false,
    () =>
      withCollectionMutationGuard(collection, () =>
        withCollectionWriteLock(collection, async () => {
          const database = await getDb();
          const stage = await createImportStorageStage(DB_PATH, options.stagingDirectory);
          let embeddingIdentity = '';
          const generation = randomUUID();
          const indexName = `__index_${createHash('sha256').update(collection).digest('hex').slice(0, 32)}_${generation.replaceAll('-', '')}`;
          const previousGeneration = getStoragePublication(collection)?.generation ?? '';
          const scope = activeThreadFilter(collection);
          const sources = new Set(options.sourceFiles ?? []);
          let totalChunks = 0;
          let importedChunks = 0;
          let totalTokens = 0;
          let done = 0;
          let success = false;
          let stagedIndex: Table | undefined;
          let stagedThreads = false;
          try {
            registerStagedGeneration(collection, generation, indexName);
            await memoryCheckpoint({
              signal: options.signal,
              onPressure: options.onMemoryPressure,
            });
            const oldThreads = await snapshotTable(THREADS_TABLE);
            if (oldThreads) {
              let previousBatch: Record<string, unknown>[] = [];
              let previousBytes = 0;
              const writePrevious = () => {
                stage.transaction(() => previousBatch.forEach((row) => stage.putPrevious(row)));
                previousBatch = [];
                previousBytes = 0;
              };
              for await (const row of scanRows(oldThreads, scope)) {
                await memoryCheckpoint({
                  signal: options.signal,
                  onPressure: options.onMemoryPressure,
                });
                const size =
                  String(row.turnsJson).length * 2 + String(row.rawJson).length * 2 + 4096;
                if (
                  previousBatch.length &&
                  (previousBatch.length >= 32 || previousBytes + size > 8 * 1024 ** 2)
                )
                  writePrevious();
                previousBatch.push(row);
                previousBytes += size;
              }
              if (previousBatch.length) writePrevious();
            }
            const ordinals = new Map<string, number>();
            for await (const record of records) {
              await memoryCheckpoint({
                signal: options.signal,
                onPressure: options.onMemoryPressure,
              });
              sources.add(record.sourceFile);
              let conversation = record.conversation;
              const old = stage.previous(record.sourceFile, conversation.key);
              if (old && old.indexPending !== 'delete' && old.indexPending !== 'reset') {
                stage.matched(old);
                const previous = conversationFromRow(old);
                if (!previous) {
                  stage.putNext({
                    ...old,
                    conversationKey: `${conversation.key}:unreadable:${createHash('sha256').update(String(old.turnsJson)).digest('hex').slice(0, 16)}`,
                    importGeneration: generation,
                    indexPending: 'invalid',
                  });
                } else if (!options.reindexOnly) {
                  const local = previous.turns.filter(
                    (turn) => (turn as { createdInThreadShelf?: boolean }).createdInThreadShelf,
                  );
                  const imported = previous.turns.filter(
                    (turn) => !(turn as { createdInThreadShelf?: boolean }).createdInThreadShelf,
                  );
                  const text = (turn: unknown) => {
                    const t = turn as { user?: string; ai?: string; thinking?: string };
                    return [t.user, t.ai, t.thinking];
                  };
                  const sharedPrefix =
                    imported.length > 0 &&
                    conversation.turns.length > 0 &&
                    imported
                      .slice(0, Math.min(imported.length, conversation.turns.length))
                      .every(
                        (turn, index) =>
                          JSON.stringify(text(turn)) ===
                          JSON.stringify(text(conversation.turns[index])),
                      );
                  if (local.length && /:\d+$/.test(conversation.key) && !sharedPrefix) {
                    stage.putNext({
                      ...old,
                      conversationKey: `${conversation.key}:threadshelf:${createHash('sha256').update(String(old.turnsJson)).digest('hex').slice(0, 16)}`,
                      importGeneration: generation,
                      indexPending: '',
                    });
                  } else
                    conversation = { ...conversation, turns: [...conversation.turns, ...local] };
                }
              }
              const ordinal = ordinals.get(record.sourceFile) ?? 0;
              ordinals.set(record.sourceFile, ordinal + 1);
              const [row] = threadRows(
                collection,
                record.sourceFile,
                record.provider,
                [conversation],
                '',
              );
              stage.putNext({ ...row, ordinal, importGeneration: generation });
            }
            // For additive imports retain untouched files. Rewritten/removed imported
            // keys retain locally authored branches and any unreadable original rows.
            for (const old of stage.unmatched()) {
              options.signal?.throwIfAborted();
              if (['delete', 'reset'].includes(String(old.indexPending))) continue;
              const previous = conversationFromRow(old);
              const untouched = !options.clearFirst && !sources.has(String(old.sourceFile));
              if (
                !untouched &&
                previous &&
                !previous.turns.some(
                  (turn) => (turn as { createdInThreadShelf?: boolean }).createdInThreadShelf,
                )
              )
                continue;
              stage.putNext({
                ...old,
                importGeneration: generation,
                indexPending: previous ? '' : 'invalid',
              });
            }
            // Count without retaining chunks; a second linear pass streams inference.
            for (const row of stage.next()) {
              const { chunks, invalid } = chunksFromThreadRows([row]);
              totalChunks += chunks.length;
              if (options.clearFirst || sources.has(String(row.sourceFile)))
                importedChunks += chunks.length;
              totalTokens += chunks.reduce(
                (sum, chunk) => sum + Math.ceil(chunk.text.length / 4),
                0,
              );
              if (invalid.length)
                stage.putNext({
                  ...row,
                  indexPending: 'invalid',
                  indexError: 'Stored turns could not be decoded; original data retained',
                  indexAttempts: 1,
                  indexRetryAt: 0,
                });
            }
            if (totalChunks) {
              embeddingIdentity = await getEmbeddingIdentity();
              stage.setEmbeddingIdentity(embeddingIdentity);
              // Reusing identical text is safe: the embedding cache key includes model,
              // quantization, pooling, dimension and normalization. Metadata is rebuilt.
              const oldVectors = await snapshotTable(collection);
              if (
                oldVectors &&
                embeddingIdentity &&
                getStoragePublication(collection)?.embeddingIdentity === embeddingIdentity
              ) {
                let cachedBatch: { text: string; vector: number[] }[] = [];
                const writeCache = () => {
                  stage.transaction(() =>
                    cachedBatch.forEach(({ text, vector }) => stage.putEmbedding(text, vector)),
                  );
                  cachedBatch = [];
                };
                for await (const row of scanRows(oldVectors, '', ['document', 'vector'], 256)) {
                  options.signal?.throwIfAborted();
                  const vector = Array.from(row.vector as Iterable<number>);
                  if (vector.length === 384 && vector.every(Number.isFinite))
                    cachedBatch.push({ text: String(row.document), vector });
                  if (cachedBatch.length >= 256) writeCache();
                }
                if (cachedBatch.length) writeCache();
              }
            }
            await options.onEmbeddingProgress?.(0, totalChunks, totalTokens);
            let batch: ChunkRow[] = [];
            let pendingVectors: EmbeddedChunkRow[] = [];
            let pendingVectorBytes = 0;
            const writeVectors = async () => {
              if (!pendingVectors.length) return;
              await memoryCheckpoint({
                signal: options.signal,
                onPressure: options.onMemoryPressure,
              });
              await stage.checkDisk(pendingVectorBytes);
              if (stagedIndex) await stagedIndex.add(pendingVectors);
              else
                stagedIndex = await database.createTable(indexName, pendingVectors, {
                  mode: 'create',
                });
              pendingVectors = [];
              pendingVectorBytes = 0;
            };
            const flush = async () => {
              if (!batch.length) return;
              await memoryCheckpoint({
                signal: options.signal,
                onPressure: options.onMemoryPressure,
              });
              await stage.checkDisk(batch.reduce((size, chunk) => size + chunk.text.length * 2, 0));
              const vectors = batch.map((chunk) => stage.cachedEmbedding(chunk.text));
              const missing = new Map<string, number[]>();
              batch.forEach((chunk, index) => {
                if (!vectors[index])
                  missing.set(chunk.text, [...(missing.get(chunk.text) ?? []), index]);
              });
              if (missing.size) {
                const texts = [...missing.keys()];
                const computed = await embed(texts);
                options.signal?.throwIfAborted();
                stage.transaction(() =>
                  texts.forEach((text, index) => {
                    const vector = computed[index]!;
                    for (const target of missing.get(text)!) vectors[target] = vector;
                    stage.putEmbedding(text, vector);
                  }),
                );
              }
              const rows = batch.map((chunk, index) => embeddedRow(chunk, vectors[index]!));
              pendingVectors.push(...rows);
              pendingVectorBytes += rows.reduce(
                (size, row) => size + row.document.length * 2 + row.vector.length * 8 + 2048,
                0,
              );
              if (pendingVectors.length >= 512 || pendingVectorBytes >= 4 * 1024 ** 2)
                await writeVectors();
              done += batch.length;
              batch = [];
              await options.onEmbeddingProgress?.(done, totalChunks, totalTokens);
            };
            for (const row of stage.next()) {
              const { chunks } = chunksFromThreadRows([row]);
              for (const chunk of chunks) {
                batch.push(chunk);
                if (batch.length >= recommendedBatchSize(EMBED_BATCH_SIZE)) await flush();
              }
            }
            await flush();
            await writeVectors();
            options.signal?.throwIfAborted();
            // Archive records are appended under the short table lock in byte-bounded
            // batches. They remain invisible until the publication transaction.
            let rows: Record<string, unknown>[] = [];
            let bytes = 0;
            const flushThreads = async () => {
              if (!rows.length) return;
              await memoryCheckpoint({
                signal: options.signal,
                onPressure: options.onMemoryPressure,
              });
              await stage.checkDisk(bytes);
              await withCollectionWriteLock(THREADS_TABLE, async () => {
                const table = await openTable(THREADS_TABLE);
                if (table) {
                  await ensureThreadsSchema(table);
                  await table.add(rows);
                } else
                  tableCache.set(
                    THREADS_TABLE,
                    await database.createTable(THREADS_TABLE, rows, { mode: 'create' }),
                  );
              });
              stagedThreads = true;
              rows = [];
              bytes = 0;
            };
            for (const row of stage.next()) {
              const size = String(row.turnsJson).length * 2 + String(row.rawJson).length * 2 + 4096;
              if (rows.length && (rows.length >= 32 || bytes + size > 8 * 1024 ** 2))
                await flushThreads();
              rows.push(row);
              bytes += size;
            }
            await flushThreads();
            await withCollectionWriteLock(THREADS_TABLE, async () => {
              options.signal?.throwIfAborted();
              if ((getStoragePublication(collection)?.generation ?? '') !== previousGeneration)
                throw new StoredThreadWriteError(
                  'Collection publication changed while importing; retry the job',
                );
              // Guard ownership prevents cooperating writers. Still validate the old
              // snapshot so direct database changes never cause silent lost updates.
              const current = await snapshotTable(THREADS_TABLE);
              let count = 0;
              if (current)
                for await (const row of scanRows(current, scope)) {
                  const old = stage.previous(String(row.sourceFile), String(row.conversationKey));
                  if (!old || JSON.stringify(row) !== JSON.stringify(old))
                    throw new StoredThreadWriteError(
                      'Archived conversation changed while importing; retry the job',
                    );
                  count++;
                }
              if (oldThreads && count !== (await oldThreads.countRows(scope)))
                throw new StoredThreadWriteError(
                  'Archived conversations changed while importing; retry the job',
                );
              publishStorageGeneration(
                collection,
                generation,
                stagedIndex ? indexName : null,
                embeddingIdentity,
              );
              success = true;
              invalidateCollectionStats(collection);
              readyIndexCache.delete(collection);
            });
            await retireStorageGenerations().catch((error) =>
              console.warn('[store:retirement]', error),
            );
            // Additive folder ingestion sums one result per input file. Retained
            // files are rebuilt for atomic publication, but are not newly imported.
            return importedChunks;
          } finally {
            // Failed uncommitted generations can be removed immediately: no reader
            // ever saw them. A killed process leaves harmless hidden staging rows.
            if (!success) {
              if (stagedIndex) await database.dropTable(indexName).catch(() => undefined);
              if (stagedThreads)
                await withCollectionWriteLock(THREADS_TABLE, async () => {
                  const table = await openTable(THREADS_TABLE);
                  await table?.delete(
                    `collection = '${escapeSqlString(collection)}' AND importGeneration = '${generation}'`,
                  );
                }).catch(() => undefined);
            }
            await stage.close(success);
          }
        }),
      ),
    { signal: options.signal },
  );

/** Retry changed snapshots using disk replay and already-computed embeddings. */
export const replaceImportedStream = (
  collection: string,
  records: AsyncIterable<ImportedConversationRecord>,
  options: ChunkWriteOptions & {
    readonly clearFirst?: boolean;
    readonly sourceFiles?: readonly string[];
    readonly reindexOnly?: boolean;
  } = {},
): Promise<number> =>
  withIndexOperation(
    collection,
    options.clearFirst === true && !options.reindexOnly,
    async () => {
      const replay = await createImportReplay(DB_PATH, records, options.stagingDirectory);
      try {
        for (let attempt = 0; ; attempt++) {
          options.signal?.throwIfAborted();
          try {
            return await replaceImportedStreamAttempt(collection, replay.records(), {
              ...options,
              stagingDirectory: replay.stagingDirectory,
            });
          } catch (error) {
            if (!(error instanceof StoredThreadWriteError) || attempt >= 2) throw error;
          }
        }
      } finally {
        await replay.close();
      }
    },
    { signal: options.signal },
  );

/** Compatibility API; streaming ingestion uses replaceImportedStream directly. */
export const replaceImportedFiles = (
  collection: string,
  files: readonly ImportedFile[],
  options: ChunkWriteOptions & { readonly clearFirst?: boolean } = {},
): Promise<number> =>
  replaceImportedStream(
    collection,
    (async function* () {
      for (const file of files)
        for (const conversation of file.conversations)
          yield { sourceFile: file.sourceFile, provider: file.provider, conversation };
    })(),
    { ...options, sourceFiles: files.map((file) => file.sourceFile) },
  );

const acknowledgeIndexLocked = async (
  where: string,
  invalid: Record<string, unknown>[] = [],
): Promise<void> => {
  const tbl = await openTable(THREADS_TABLE);
  if (!tbl) return;
  for (const row of invalid) {
    await tbl.update({
      where: `${threadFileFilter(String(row.collection), String(row.sourceFile))} AND conversationKey = '${escapeSqlString(String(row.conversationKey))}'`,
      values: {
        indexPending: 'invalid',
        indexError: 'Stored turns could not be decoded; original data retained',
        indexAttempts: 1,
        indexRetryAt: 0,
      },
    });
  }
  if (invalid.length)
    console.error(
      `[index:recovery] Preserved ${invalid.length} unreadable archive row(s); healthy conversations remain searchable.`,
    );
  await tbl.delete(`(${where}) AND indexPending IN ('delete', 'reset')`);
  await tbl.update({
    where: `(${where}) AND indexPending NOT IN ('', 'invalid')`,
    values: { indexPending: '', indexAttempts: 0, indexRetryAt: 0, indexError: '' },
  });
};

const indexScope = async (collection: string, sourceFile: string) => {
  const collectionWhere = activeThreadFilter(collection);
  const table = await openTable(THREADS_TABLE);
  if (!table)
    return {
      where: threadFileFilter(collection, sourceFile),
      reset: false,
      full: false,
      rows: [] as Record<string, unknown>[],
    };
  await ensureThreadsSchema(table);
  const reset = (await table.countRows(`${collectionWhere} AND indexPending = 'reset'`)) > 0;
  const base = reset ? collectionWhere : threadFileFilter(collection, sourceFile);
  const full =
    reset || (await table.countRows(`(${base}) AND indexPending IN ('all','delete')`)) > 0;
  // Full-file/collection recovery uses the streamed publisher below. Local
  // continuations only need the pending conversations, never every conversation
  // from their original multi-conversation source file.
  if (full) return { where: base, reset, full, rows: [] as Record<string, unknown>[] };
  const pending = `(${base}) AND indexPending = 'local'`;
  const rows = await table.query().where(pending).limit(16).toArray();
  const keys = rows.map((row) => `'${escapeSqlString(String(row.conversationKey))}'`).join(',');
  const where = rows.length ? `${pending} AND conversationKey IN (${keys})` : pending;
  return { where, reset, full, rows };
};

export const indexStoredFile = async (
  collection: string,
  sourceFile: string,
  options: ChunkWriteOptions = {},
): Promise<number> =>
  withIndexOperation(
    collection,
    false,
    () =>
      withCollectionMutationGuard(collection, () =>
        withCollectionWriteLock(collection, async () => {
          let totalIndexed = 0;
          let attempt = 0;
          for (;;) {
            if (attempt >= 3)
              throw new StoredThreadWriteError(
                'Archive changed repeatedly while embedding; indexing remains pending',
              );
            const snapshot = await withCollectionWriteLock(THREADS_TABLE, () =>
              indexScope(collection, sourceFile),
            );
            const { where, reset, full, rows } = snapshot;
            if (full) {
              try {
                const table = await snapshotTable(THREADS_TABLE);
                const records = (async function* (): AsyncGenerator<ImportedConversationRecord> {
                  if (!table) return;
                  for await (const row of scanRows(table, where)) {
                    options.signal?.throwIfAborted();
                    if (['delete', 'reset'].includes(String(row.indexPending))) continue;
                    const conversation = conversationFromRow(row);
                    if (conversation)
                      yield {
                        sourceFile: String(row.sourceFile),
                        provider: String(row.provider),
                        conversation,
                      };
                  }
                })();
                return await replaceImportedStream(collection, records, {
                  ...options,
                  clearFirst: reset,
                  sourceFiles: [sourceFile],
                  reindexOnly: true,
                });
              } catch (error) {
                await withCollectionWriteLock(THREADS_TABLE, async () => {
                  const table = await openTable(THREADS_TABLE);
                  // Increment in the database, without bringing the failed scope into JS.
                  await table?.update({
                    where: `(${where}) AND indexPending NOT IN ('','invalid')`,
                    valuesSql: {
                      indexAttempts: 'indexAttempts + 1',
                      indexRetryAt: `${Date.now() + 60_000}`,
                      indexError: `'${escapeSqlString((error instanceof Error ? error.message : 'Indexing failed').slice(0, 500))}'`,
                    },
                  });
                });
                throw error;
              }
            }
            if (!rows.length) return totalIndexed;
            try {
              const prepared = chunksFromThreadRows(rows);
              const chunks = prepared.chunks.filter((chunk) => chunk.createdInThreadShelf);
              const embedded = await embedChunks(
                chunks,
                options.signal,
                options.onEmbeddingProgress,
                options.onMemoryPressure,
              );
              const committed = await withCollectionWriteLock(THREADS_TABLE, async () => {
                const current = await indexScope(collection, sourceFile);
                if (
                  where !== current.where ||
                  current.full ||
                  snapshotFingerprint(rows) !== snapshotFingerprint(current.rows)
                )
                  return false;
                const keys = rows
                  .map((row) => `'${escapeSqlString(String(row.conversationKey))}'`)
                  .join(',');
                await replaceEmbeddedRowsLocked(
                  collection,
                  `sourceFile = '${escapeSqlString(sourceFile)}' AND createdInThreadShelf = true AND conversationKey IN (${keys})`,
                  embedded,
                );
                await acknowledgeIndexLocked(where, prepared.invalid);
                return true;
              });
              if (committed) {
                totalIndexed += chunks.length;
                attempt = 0;
              } else attempt++;
            } catch (error) {
              await withCollectionWriteLock(THREADS_TABLE, async () => {
                if (snapshotFingerprint(rows) !== snapshotFingerprint(await readThreadScope(where)))
                  return;
                const attempts =
                  rows.reduce((max, row) => Math.max(max, Number(row.indexAttempts) || 0), 0) + 1;
                const table = await openTable(THREADS_TABLE);
                await table?.update({
                  where: `(${where}) AND indexPending NOT IN ('','invalid')`,
                  values: {
                    indexAttempts: attempts,
                    indexRetryAt: Date.now() + Math.min(15_000 * 2 ** (attempts - 1), 3_600_000),
                    indexError: (error instanceof Error ? error.message : 'Indexing failed').slice(
                      0,
                      500,
                    ),
                  },
                });
              });
              throw error;
            }
          }
        }),
      ),
    { signal: options.signal, timeoutMs: 0 },
  );

export const deleteStoredFile = async (collection: string, sourceFile: string): Promise<void> =>
  withCollectionMutationGuard(collection, () =>
    withCollectionWriteLock(collection, () =>
      withCollectionWriteLock(THREADS_TABLE, async () => {
        const where = threadFileFilter(collection, sourceFile);
        await replaceThreadRowsLocked(where, []);
        await replaceEmbeddedRowsLocked(
          collection,
          `sourceFile = '${escapeSqlString(sourceFile)}'`,
          [],
        );
        await acknowledgeIndexLocked(where);
      }),
    ),
  );

let recoveringIndexes: Promise<void> | undefined;
export const recoverPendingIndexes = (
  options: { readonly collection?: string; readonly retryFailed?: boolean } = {},
): Promise<void> => {
  if (recoveringIndexes) return recoveringIndexes.then(() => recoverPendingIndexes(options));
  recoveringIndexes = withIndexOperation(
    undefined,
    false,
    async () => {
      const table = await snapshotTable(THREADS_TABLE);
      if (!table) return;
      const collection =
        options.collection && options.collection !== 'all' ? options.collection : undefined;
      const where = `(${activeThreadFilter(collection)}) AND indexPending NOT IN ('', 'invalid')`;
      const jobs = new Map<
        string,
        { collection: string; sourceFile: string; attempts: number; retryAt: number }
      >();
      const resets = new Map<
        string,
        { collection: string; sourceFile: string; attempts: number; retryAt: number }
      >();
      for await (const row of scanRows(
        table,
        where,
        ['collection', 'sourceFile', 'indexPending', 'indexAttempts', 'indexRetryAt'],
        256,
      )) {
        const col = String(row.collection);
        const source = String(row.sourceFile);
        const key = JSON.stringify([col, source]);
        const previous = jobs.get(key);
        const job = {
          collection: col,
          sourceFile: source,
          attempts: Math.max(previous?.attempts ?? 0, Number(row.indexAttempts) || 0),
          retryAt: Math.max(previous?.retryAt ?? 0, Number(row.indexRetryAt) || 0),
        };
        jobs.set(key, job);
        if (row.indexPending === 'reset') resets.set(col, job);
      }
      for (const job of [...resets.values(), ...jobs.values()]) {
        if (resets.has(job.collection) && resets.get(job.collection) !== job) continue;
        if (!options.retryFailed && (job.attempts >= 8 || job.retryAt > Date.now())) continue;
        try {
          await indexStoredFile(job.collection, job.sourceFile);
        } catch (error) {
          console.error('[index:recovery]', error);
        }
      }
      await retireStorageGenerations({ cleanupTemporary: true });
    },
    { timeoutMs: 0 },
  )
    .catch((error: unknown) => {
      if (!(error instanceof IndexingBusyError)) throw error;
    })
    .finally(() => {
      recoveringIndexes = undefined;
    });
  return recoveringIndexes;
};

export const startIndexRecovery = (): (() => void) => {
  const run = () => {
    void recoverPendingIndexes().catch((error) => console.warn('[index:recovery]', error));
  };
  run();
  const timer = setInterval(run, 15_000);
  timer.unref();
  return () => clearInterval(timer);
};

export interface SearchResult {
  readonly id: string;
  readonly document: string;
  readonly metadata: {
    readonly sourceFile: string;
    readonly provider?: string;
    readonly conversationKey?: string;
    readonly title?: string;
    readonly role: string;
    readonly turnIndex: string;
    readonly model?: string;
    readonly createdAt?: string;
    readonly createdInThreadShelf?: boolean;
    readonly generationProvider?: string;
    readonly collection?: string;
  };
  readonly distance?: number;
}

// A pending full replacement may have different turn offsets from its old
// vectors. Hide those files until recovery publishes their matching index.
const readyIndexCache = new Map<string, { version: number; generation: string; filter: string }>();
const readyIndexFilter = async (collection: string): Promise<string> => {
  const tbl = await openTable(THREADS_TABLE);
  if (!tbl) return '';
  await ensureThreadsSchema(tbl);
  const version = await tbl.version();
  const generation = getStoragePublication(collection)?.generation ?? '';
  const cached = readyIndexCache.get(collection);
  if (cached?.version === version && cached.generation === generation) return cached.filter;
  const query = tbl
    .query()
    .where(
      `${activeThreadFilter(collection)} AND indexPending IN ('all', 'delete', 'reset', 'invalid')`,
    )
    .select(['sourceFile', 'conversationKey', 'indexPending']);
  const excluded = new Set<string>();
  let characters = 0;
  let reset = false;
  for await (const batch of query) {
    for (const row of batch.toArray()) {
      if (row.indexPending === 'reset') {
        reset = true;
        break;
      }
      const condition =
        row.indexPending === 'invalid'
          ? `(sourceFile = '${escapeSqlString(String(row.sourceFile))}' AND conversationKey = '${escapeSqlString(String(row.conversationKey))}')`
          : `sourceFile = '${escapeSqlString(String(row.sourceFile))}'`;
      if (!excluded.has(condition)) {
        characters += condition.length + 4;
        if (characters > 64 * 1024) {
          const error = new Error(
            'This collection has too many pending or invalid index entries to search safely. Finish index recovery or reimport the collection, then retry.',
          );
          Object.assign(error, { code: 'INDEX_RECOVERY_REQUIRED' });
          throw error;
        }
        excluded.add(condition);
      }
    }
    if (reset) break;
  }
  const filter = reset ? 'false' : excluded.size ? `NOT (${[...excluded].join(' OR ')})` : '';
  readyIndexCache.set(collection, { version, generation, filter });
  return filter;
};

export const renameStoredThread = async (
  collection: string,
  sourceFile: string,
  conversationKey: string,
  title: string,
): Promise<StoredThreadRow> =>
  withCollectionMutationGuard(collection, () =>
    withCollectionWriteLock(THREADS_TABLE, async () => {
      const tbl = await openTable(THREADS_TABLE);
      if (!tbl) throw new StoredThreadWriteError();
      await ensureThreadsSchema(tbl);
      const where = `${threadFileFilter(collection, sourceFile)} AND conversationKey = '${escapeSqlString(conversationKey)}' AND indexPending NOT IN ('delete', 'reset')`;
      const result = await tbl.update({ where, values: { title } });
      if (result.rowsUpdated !== 1) throw new StoredThreadWriteError();
      invalidateCollectionStats(collection);
      const [row] = await tbl.query().where(where).limit(1).toArray();
      return storedThreadRow(row);
    }),
  );

export interface SearchOptions {
  readonly n?: number;
  readonly roles?: string[];
  readonly keywordBoost?: boolean;
  readonly model?: string;
  readonly from?: string;
  readonly to?: string;
  readonly origin?: 'threadshelf' | 'archive';
}

const searchCollectionInternal = async (
  collection: string,
  query: string,
  opts: SearchOptions = {},
  queryEmbedding?: number[],
): Promise<SearchResult[]> => {
  const n = opts.n ?? 15;
  const roles = opts.roles?.length ? opts.roles : null;
  const modelFilter = normalizeModelFilter(opts.model);
  const dateFilter = buildCreatedAtFilter(opts.from, opts.to);
  const keywordBoost = opts.keywordBoost === true;
  const needsPostFilter = roles || modelFilter || keywordBoost;
  const limit = needsPostFilter ? Math.min(Math.max(n * 8, 80), 200) : n;
  const embedding = queryEmbedding ?? (await embedOne(query));

  const tbl = await openTable(collection);
  if (!tbl) return [];
  await ensureChunkMetadataSchema(tbl, collection);

  const filters = [
    dateFilter,
    await readyIndexFilter(collection),
    opts.origin ? `createdInThreadShelf = ${opts.origin === 'threadshelf'}` : '',
  ].filter(Boolean);
  const results = await vectorSearchRows(tbl, embedding, limit, filters.join(' AND '));

  let rows: SearchResult[] = results.map((row) => ({
    id: row.id as string,
    document: (row.document as string) ?? '',
    metadata: {
      sourceFile: row.sourceFile as string,
      provider: (row.provider as string) || undefined,
      conversationKey: (row.conversationKey as string) || undefined,
      title: (row.title as string) || undefined,
      role: row.role as string,
      turnIndex: row.turnIndex as string,
      model: portableModelLabel((row.model as string) || undefined) || undefined,
      createdAt: (row.createdAt as string) || undefined,
      createdInThreadShelf: Boolean(row.createdInThreadShelf),
      generationProvider: (row.generationProvider as string) || undefined,
    },
    distance: row._distance as number | undefined,
  }));

  if (roles?.length) {
    const roleSet = new Set(roles);
    rows = rows.filter((r) => roleSet.has(r.metadata.role));
  }

  if (opts.origin) {
    const expected = opts.origin === 'threadshelf';
    rows = rows.filter((row) => row.metadata.createdInThreadShelf === expected);
  }

  rows = rows.filter((r) => isSearchableDocument(r.document));

  if (modelFilter) {
    rows = rows.filter((r) => normalizeModelFilter(r.metadata.model)?.includes(modelFilter));
  }

  if (keywordBoost && query.trim()) {
    const q = query.trim().toLowerCase();
    rows.sort((a, b) => {
      const aHas = a.document.toLowerCase().includes(q);
      const bHas = b.document.toLowerCase().includes(q);
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      return (a.distance ?? 0) - (b.distance ?? 0);
    });
  }

  return rows.slice(0, n);
};

// Exact-match (keyword) search: a case-insensitive substring scan pushed down
// to LanceDB as a LIKE filter. Complements vector search for identifiers,
// error strings, and code fragments the embedding model blurs away.

const escapeLikePattern = (value: string): string =>
  escapeSqlString(value).replace(/[\\%_]/g, '\\$&');

const countOccurrences = (haystack: string, needle: string): number => {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

export const keywordResultComparator =
  (query: string) =>
  (a: SearchResult, b: SearchResult): number => {
    const needle = query.trim().toLowerCase();
    const diff =
      countOccurrences(b.document.toLowerCase(), needle) -
      countOccurrences(a.document.toLowerCase(), needle);
    if (diff !== 0) return diff;
    return (b.metadata.createdAt ?? '').localeCompare(a.metadata.createdAt ?? '');
  };

const keywordSearchCollectionInternal = async (
  collection: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> => {
  const n = opts.n ?? 15;
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const tbl = await openTable(collection);
  if (!tbl) return [];
  await ensureChunkMetadataSchema(tbl, collection);

  const clauses = [`lower(document) LIKE '%${escapeLikePattern(needle)}%'`];
  const ready = await readyIndexFilter(collection);
  if (ready) clauses.push(ready);
  if (opts.roles?.length) {
    clauses.push(`role IN (${opts.roles.map((role) => `'${escapeSqlString(role)}'`).join(', ')})`);
  }
  const dateFilter = buildCreatedAtFilter(opts.from, opts.to);
  if (dateFilter) clauses.push(dateFilter);
  if (opts.origin) clauses.push(`createdInThreadShelf = ${opts.origin === 'threadshelf'}`);

  // Cap the scan the same way post-filtered vector search does; ranking picks
  // the best n from that window.
  const limit = Math.min(Math.max(n * 8, 80), 200);

  let results: Record<string, unknown>[];
  try {
    results = await tbl.query().where(clauses.join(' AND ')).limit(limit).toArray();
  } catch (e) {
    if (dateFilter && String((e as Error)?.message || '').includes('createdAt')) return [];
    throw e;
  }

  const modelFilter = normalizeModelFilter(opts.model);
  let rows: SearchResult[] = results.map((row) => ({
    id: row.id as string,
    document: (row.document as string) ?? '',
    metadata: {
      sourceFile: row.sourceFile as string,
      provider: (row.provider as string) || undefined,
      conversationKey: (row.conversationKey as string) || undefined,
      title: (row.title as string) || undefined,
      role: row.role as string,
      turnIndex: row.turnIndex as string,
      model: portableModelLabel((row.model as string) || undefined) || undefined,
      createdAt: (row.createdAt as string) || undefined,
      createdInThreadShelf: Boolean(row.createdInThreadShelf),
      generationProvider: (row.generationProvider as string) || undefined,
    },
  }));

  rows = rows.filter((r) => isSearchableDocument(r.document));
  if (modelFilter) {
    rows = rows.filter((r) => normalizeModelFilter(r.metadata.model)?.includes(modelFilter));
  }

  rows.sort(keywordResultComparator(query));
  return rows.slice(0, n);
};

export interface ChunkMetaRow {
  readonly createdAt: string;
  readonly model: string;
  readonly role: string;
}

// Lightweight metadata scan powering the insights dashboard: three small
// string columns, no vectors and no document text.
const scanChunkMetaInternal = async (collection: string): Promise<ChunkMetaRow[]> => {
  try {
    const tbl = await openTable(collection);
    if (!tbl) return [];
    const fetch = (columns: string[]) =>
      tbl.query().select(columns).limit(Number.MAX_SAFE_INTEGER).toArray();

    let rows: Record<string, unknown>[];
    try {
      rows = await fetch(['createdAt', 'model', 'role']);
    } catch (e) {
      // Tables indexed before model/createdAt existed.
      if (!String((e as Error)?.message || '').includes('No field named')) throw e;
      rows = await fetch(['role']);
    }
    return rows.map((row) => ({
      createdAt: (row.createdAt as string) ?? '',
      model: portableModelLabel((row.model as string) ?? ''),
      role: (row.role as string) ?? '',
    }));
  } catch (error) {
    console.warn(`[store:scanChunkMeta:${collection}]`, error);
    return [];
  }
};

const listSourceFilesInCollectionInternal = async (collection: string): Promise<string[]> => {
  try {
    const tbl = await openTable(collection);
    if (!tbl) return [];
    const rows = await tbl.query().select(['sourceFile']).limit(Number.MAX_SAFE_INTEGER).toArray();
    const files = new Set<string>();
    for (const row of rows) {
      if (row.sourceFile) files.add(row.sourceFile as string);
    }
    return [...files].sort();
  } catch (error) {
    console.warn(`[store:listSourceFiles:${collection}]`, error);
    return [];
  }
};

export interface CollectionStats {
  readonly collection: string;
  readonly files: number;
  readonly conversations: number;
  readonly chunks: number;
  readonly roles: { user: number; thinking: number; ai: number };
  readonly isEmpty: boolean;
}

const computeCollectionStats = async (collection: string): Promise<CollectionStats> => {
  try {
    const tbl = await openTable(collection);
    const conversations = (await listThreadSummaries(collection)).length;
    if (!tbl) {
      return {
        collection,
        files: 0,
        conversations,
        chunks: 0,
        roles: { user: 0, thinking: 0, ai: 0 },
        isEmpty: true,
      };
    }

    // Counts run natively in LanceDB; only the distinct-file scan materializes
    // rows (a single column) in JS.
    const [chunks, user, thinking, ai, sourceFiles] = await Promise.all([
      tbl.countRows(),
      tbl.countRows("role = 'user'"),
      tbl.countRows("role = 'thinking'"),
      tbl.countRows("role = 'ai'"),
      listSourceFilesInCollection(collection),
    ]);

    return {
      collection,
      files: sourceFiles.length,
      conversations,
      chunks,
      roles: { user, thinking, ai },
      isEmpty: chunks === 0,
    };
  } catch (error) {
    console.warn(`[store:getCollectionStats:${collection}]`, error);
    return {
      collection,
      files: 0,
      conversations: 0,
      chunks: 0,
      roles: { user: 0, thinking: 0, ai: 0 },
      isEmpty: true,
    };
  }
};

const getCollectionStatsInternal = async (collection: string): Promise<CollectionStats> => {
  const cached = collectionStatsCache.get(collection);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = computeCollectionStats(collection).catch((error) => {
    collectionStatsCache.delete(collection);
    throw error;
  });
  collectionStatsCache.set(collection, {
    expiresAt: Date.now() + COLLECTION_STATS_CACHE_MS,
    value,
  });
  return value;
};

const listCollectionsInternal = async (): Promise<string[]> => {
  try {
    const database = await getDb();
    const names = await database.tableNames();
    // "__"-prefixed tables are internal (e.g. __threads), never user collections.
    return [...new Set([...names, ...listStoragePublications().map((entry) => entry.collection)])]
      .filter((name) => name !== 'Default' && !name.startsWith('__'))
      .sort();
  } catch (error) {
    console.warn('[store:listCollections]', error);
    return [];
  }
};

// Drop runs under the per-collection write lock so a reset cannot interleave
// with a concurrent ingest's delete+add on the same collection.
export const dropCollection = async (name: string): Promise<void> => {
  return withCollectionMutationGuard(name, () =>
    withCollectionWriteLock(name, async () => {
      const deadline = performance.now() + 30_000;
      for (;;) {
        const removed = await withCollectionWriteLock(THREADS_TABLE, () =>
          withExclusiveStorageRetirement(async () => {
            const database = await getDb();
            const prefix = `__index_${createHash('sha256').update(name).digest('hex').slice(0, 32)}_`;
            for (const tableName of await database.tableNames()) {
              if (tableName === name || tableName.startsWith(prefix)) {
                await database.dropTable(tableName);
                tableCache.delete(tableName);
              }
            }
            forgetStoragePublication(name);
            for (const staged of listStagedGenerations())
              if (staged.collection === name) forgetStagedGeneration(staged.generation);
            tableCache.delete(name);
            readyIndexCache.delete(name);
            invalidateCollectionStats(name);
            await deleteThreadsForCollection(name);
          }),
        );
        if (removed) return;
        if (performance.now() >= deadline)
          throw new StoredThreadWriteError(
            'Collection is still being read; retry deletion when its readers finish',
          );
        await delay(25);
      }
    }),
  );
};

// --- internals ---

const vectorSearchRows = async (
  tbl: Table,
  queryEmbedding: number[],
  limit: number,
  rowFilter = '',
): Promise<Record<string, unknown>[]> => {
  const base = () => {
    const query = tbl.vectorSearch(queryEmbedding).distanceType('cosine');
    const filtered = rowFilter ? query.where(rowFilter) : query;
    return filtered.limit(limit);
  };

  try {
    return await base()
      .select([
        'id',
        'document',
        'sourceFile',
        'provider',
        'conversationKey',
        'title',
        'role',
        'turnIndex',
        'model',
        'createdAt',
        'createdInThreadShelf',
        'generationProvider',
        '_distance',
      ])
      .toArray();
  } catch (e) {
    if (rowFilter && String((e as Error)?.message || '').includes('createdAt')) return [];
    if (!String((e as Error)?.message || '').includes('No field named')) throw e;
    try {
      return await base()
        .select([
          'id',
          'document',
          'sourceFile',
          'provider',
          'conversationKey',
          'title',
          'role',
          'turnIndex',
          '_distance',
        ])
        .toArray();
    } catch (inner) {
      if (!String((inner as Error)?.message || '').includes('No field named')) throw inner;
      try {
        return await base()
          .select(['id', 'document', 'sourceFile', 'provider', 'role', 'turnIndex', '_distance'])
          .toArray();
      } catch (legacy) {
        if (!String((legacy as Error)?.message || '').includes('No field named')) throw legacy;
        return base()
          .select(['id', 'document', 'sourceFile', 'role', 'turnIndex', '_distance'])
          .toArray();
      }
    }
  }
};

const buildCreatedAtFilter = (from: string | undefined, to: string | undefined): string => {
  const clauses = ["createdAt != ''"];
  if (from) clauses.push(`createdAt >= '${escapeSqlString(from)}'`);
  if (to) clauses.push(`createdAt <= '${escapeSqlString(to)}'`);
  return clauses.length > 1 ? clauses.join(' AND ') : '';
};

const normalizeModelFilter = (value: string | undefined): string => {
  if (value === undefined || value === null) return '';
  return portableModelLabel(String(value)).toLowerCase();
};

const isSearchableDocument = (text: string): boolean => {
  if (!isIndexableText(text)) return false;
  return text.trim().length >= 8;
};

const collectionLockResource = (collection: string): string =>
  join(DB_PATH, '.threadshelf-locks', createHash('sha256').update(collection).digest('hex'));

/** Keep the active and one previous generation; release older data only with no readers. */
export const retireStorageGenerations = async (
  options: { cleanupTemporary?: boolean } = {},
): Promise<void> => {
  try {
    await withIndexOperation(
      undefined,
      false,
      async () => {
        await withExclusiveStorageRetirement(async () => {
          // Never wait for a writer holding __threads and about to acquire a read
          // lease (legacy compound mutations). Defer this maintenance instead.
          try {
            await withInterprocessLock(
              collectionLockResource(THREADS_TABLE),
              async () => {
                const database = await getDb();
                const names = await database.tableNames();
                const threads = await openTable(THREADS_TABLE);
                if (threads) await ensureThreadsSchema(threads);
                let removedRows = false;
                for (const staged of listStagedGenerations()) {
                  const publication = getStoragePublication(staged.collection);
                  if (
                    publication?.generation !== staged.generation &&
                    publication?.previousGeneration !== staged.generation
                  ) {
                    if (names.includes(staged.indexTable)) {
                      await database.dropTable(staged.indexTable);
                      tableCache.delete(staged.indexTable);
                      names.splice(names.indexOf(staged.indexTable), 1);
                    }
                    const where = `collection = '${escapeSqlString(staged.collection)}' AND importGeneration = '${escapeSqlString(staged.generation)}'`;
                    if (threads && (await threads.countRows(where))) {
                      await threads.delete(where);
                      removedRows = true;
                    }
                  }
                  forgetStagedGeneration(staged.generation);
                }
                for (const publication of listStoragePublications()) {
                  const keep = new Set([publication.indexTable, publication.previousIndexTable]);
                  const prefix = `__index_${createHash('sha256').update(publication.collection).digest('hex').slice(0, 32)}_`;
                  for (const name of names) {
                    if (
                      (name === publication.collection || name.startsWith(prefix)) &&
                      !keep.has(name)
                    ) {
                      await database.dropTable(name);
                      tableCache.delete(name);
                    }
                  }
                  const retired = `collection = '${escapeSqlString(publication.collection)}' AND importGeneration NOT IN ('${escapeSqlString(publication.generation)}','${escapeSqlString(publication.previousGeneration)}')`;
                  if (threads && (await threads.countRows(retired))) {
                    await threads.delete(retired);
                    removedRows = true;
                  }
                }
                if (options.cleanupTemporary) {
                  const parent = join(DB_PATH, '.threadshelf-staging');
                  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
                  for (const entry of entries)
                    if (entry.isDirectory() && /^(replay|import)-/.test(entry.name))
                      await rm(join(parent, entry.name), { recursive: true, force: true });
                }
                // No reader or writer can still use an old fragment/version.
                if (threads && removedRows)
                  await threads.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true });
              },
              { timeoutMs: 0 },
            );
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== 'Timed out waiting for another process to finish a storage write'
            )
              throw error;
          }
        });
      },
      { timeoutMs: 0 },
    );
  } catch (error) {
    if (!(error instanceof IndexingBusyError)) throw error;
  }
};

const withCollectionWriteLock = async <T>(collection: string, fn: () => Promise<T>): Promise<T> =>
  withInterprocessLock(collectionLockResource(collection), async () => {
    // Another process may have dropped and recreated a collection while this
    // process waited. A fresh handle avoids writing through the deleted table.
    tableCache.delete(collection);
    return fn();
  });

/** Short compound thread mutations; never hold this lock while embedding. */
export const withStoredThreadWriteLock = <T>(
  fn: () => Promise<T>,
  collections: readonly string[] = [],
): Promise<T> => {
  const ordered = [...new Set(collections)].sort();
  const next = (index: number): Promise<T> =>
    index === ordered.length
      ? withCollectionWriteLock(THREADS_TABLE, fn)
      : withCollectionMutationGuard(ordered[index]!, () => next(index + 1));
  return next(0);
};

// ThreadShelf Local Reader pagination extension v1. Upstream MIT attribution is
// retained in ThreadShelf Local Suite server-patch/THIRD-PARTY-NOTICES.md. Existing APIs are unchanged.
export interface ReaderSnapshotOptions extends SearchOptions {
  readonly mode: 'keyword' | 'semantic';
  readonly provider?: string;
  readonly signal?: AbortSignal;
  readonly onResult?: (row: SearchResult) => void;
}

/** All eligible indexed chunks, before a page is selected. No 50/200-row cutoff. */
const readerSearchCollectionSnapshotInternal = async (
  collection: string,
  query: string,
  opts: ReaderSnapshotOptions,
  embedding?: number[],
): Promise<SearchResult[]> => {
  opts.signal?.throwIfAborted();
  const tbl = await openTable(collection);
  if (!tbl) return [];
  await ensureChunkMetadataSchema(tbl, collection);
  const clauses = [
    buildCreatedAtFilter(opts.from, opts.to),
    await readyIndexFilter(collection),
  ].filter(Boolean);
  if (opts.roles?.length)
    clauses.push(`role IN (${opts.roles.map((role) => `'${escapeSqlString(role)}'`).join(', ')})`);
  if (opts.origin) clauses.push(`createdInThreadShelf = ${opts.origin === 'threadshelf'}`);
  if (opts.provider) clauses.push(`provider = '${escapeSqlString(opts.provider)}'`);
  const needle = query.trim().toLowerCase();
  if (opts.mode === 'keyword')
    clauses.push(`lower(document) LIKE '%${escapeLikePattern(needle)}%'`);
  opts.signal?.throwIfAborted();
  // Use the native backend's cosine implementation, but bypass any approximate
  // vector index so a small ANN candidate window cannot hide later pages.
  const count = await tbl.countRows();
  if (!count) return [];
  const base =
    opts.mode === 'semantic'
      ? tbl
          .vectorSearch(embedding ?? (await embedOne(query)))
          .distanceType('cosine')
          .bypassVectorIndex()
      : tbl.query();
  const filtered = clauses.length ? base.where(clauses.join(' AND ')) : base;
  const columns = [
    'id',
    'document',
    'sourceFile',
    'provider',
    'conversationKey',
    'title',
    'role',
    'turnIndex',
    'model',
    'createdAt',
    'createdInThreadShelf',
    'generationProvider',
  ];
  if (opts.mode === 'semantic') columns.push('_distance');
  const scan = filtered.select(columns).limit(count);
  const model = normalizeModelFilter(opts.model);
  const rows: SearchResult[] = [];
  for await (const batch of scan) {
    opts.signal?.throwIfAborted();
    const raw = batch.toArray();
    for (let i = 0; i < raw.length; i++) {
      // Allow socket-close/cancel events to run during a large materialization.
      if (i % 256 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        opts.signal?.throwIfAborted();
      }
      const row = raw[i]!;
      const document = String(row.document ?? '');
      const rowModel = portableModelLabel(String(row.model ?? '')) || undefined;
      if (!isSearchableDocument(document)) continue;
      if (model && !normalizeModelFilter(rowModel).includes(model)) continue;
      const result: SearchResult = {
        id: String(row.id),
        document,
        metadata: {
          collection,
          sourceFile: String(row.sourceFile ?? ''),
          provider: String(row.provider ?? '') || undefined,
          conversationKey: String(row.conversationKey ?? '') || undefined,
          title: String(row.title ?? '') || undefined,
          role: String(row.role ?? ''),
          turnIndex: String(row.turnIndex ?? ''),
          model: rowModel,
          createdAt: String(row.createdAt ?? '') || undefined,
          createdInThreadShelf: Boolean(row.createdInThreadShelf),
          generationProvider: String(row.generationProvider ?? '') || undefined,
        },
        ...(opts.mode === 'semantic' ? { distance: Number(row._distance) } : {}),
      };
      opts.onResult?.(result);
      rows.push(result);
    }
  }
  return rows;
};

const leaseRead =
  <Args extends unknown[], T>(fn: (...args: Args) => Promise<T>) =>
  (...args: Args): Promise<T> =>
    withStorageReadLease(() => withPublicationSnapshot(() => fn(...args)));
export const getStoredThreads = leaseRead(getStoredThreadsInternal);
export const listThreadSummaries = leaseRead(listThreadSummariesInternal);
export const searchCollection = leaseRead(searchCollectionInternal);
export const keywordSearchCollection = leaseRead(keywordSearchCollectionInternal);
export const scanChunkMeta = leaseRead(scanChunkMetaInternal);
export const listSourceFilesInCollection = leaseRead(listSourceFilesInCollectionInternal);
export const getCollectionStats = leaseRead(getCollectionStatsInternal);
export const listCollections = leaseRead(listCollectionsInternal);
export const readerSearchCollectionSnapshot = leaseRead(readerSearchCollectionSnapshotInternal);
