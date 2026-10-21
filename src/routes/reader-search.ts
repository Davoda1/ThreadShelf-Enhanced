// Copyright (c) 2026 davoda1. MIT; see the ThreadShelf Local Suite notices.
import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import {
  readerSearchCollectionSnapshot,
  keywordResultComparator,
  type SearchResult,
} from '../store.js';
import { embedOne } from '../embedding.js';
import { getAllCollections } from '../services/collections.js';
import { searchResultComparator } from '../services/search.js';
import { abortOnDisconnect } from './stream-abort.js';
import {
  ValidationError,
  normalizeCollectionSelector,
  normalizeQuery,
  normalizeCount,
  normalizeRoles,
  normalizeBoolean,
  normalizeOptionalString,
  normalizeDateRange,
  normalizeSearchMode,
} from '../validation.js';

const TTL_MS = 15 * 60 * 1000;
const CACHE_BYTES = 128 * 1024 * 1024;
const CACHE_ENTRIES = 8;
interface Snapshot {
  key: string;
  results: SearchResult[];
  expires: number;
  bytes: number;
}
class PageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const tieBreak = (a: SearchResult, b: SearchResult): number => {
  const key = (row: SearchResult) =>
    JSON.stringify([
      row.metadata.collection,
      row.metadata.sourceFile,
      row.metadata.conversationKey,
      row.metadata.turnIndex,
      row.id,
    ]);
  const left = key(a),
    right = key(b);
  return left < right ? -1 : left > right ? 1 : 0;
};

/** Dependency injection is solely for deterministic native-store integration tests. */
export const createReaderSearchRouter = (embedQuery: typeof embedOne = embedOne): Router => {
  const router = Router();
  const snapshots = new Map<string, Snapshot>();
  let activeBuilds = 0;
  const prune = () => {
    for (const [id, snapshot] of snapshots)
      if (snapshot.expires <= Date.now()) snapshots.delete(id);
  };
  const cursorParts = (value: unknown): [string, number] => {
    if (typeof value !== 'string' || !/^[a-f0-9]{48}\.[0-9]{1,12}$/.test(value))
      throw new PageError(400, 'Invalid search cursor');
    const [id, offsetText] = value.split('.');
    const offset = Number(offsetText);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new PageError(400, 'Invalid search cursor');
    return [id!, offset];
  };

  router.get('/api/reader/capabilities', (_req, res) => {
    res.json({
      readerSearch: {
        version: 1,
        path: '/api/reader/search',
        maxPageSize: 50,
        modes: ['keyword', 'semantic'],
        cursor: true,
        providerFilter: true,
        snapshotTtlSeconds: TTL_MS / 1000,
        exactTotal: true,
      },
    });
  });

  router.get('/api/reader/search', async (req, res) => {
    const controller = abortOnDisconnect(req, res);
    let ownsBuild = false;
    try {
      const q = normalizeQuery(req.query.q);
      const collection = normalizeCollectionSelector(req.query.collection);
      const n = normalizeCount(req.query.n, { defaultValue: 50 });
      const mode = normalizeSearchMode(req.query.mode);
      const roles = (normalizeRoles(req.query.roles) ?? []).sort();
      const keywordBoost = normalizeBoolean(req.query.keywordBoost, { field: 'keywordBoost' });
      const model = normalizeOptionalString(req.query.model, { field: 'model' });
      const provider = normalizeOptionalString(req.query.provider, { field: 'provider' });
      const { from, to } = normalizeDateRange(req.query.from, req.query.to);
      const origin = normalizeOptionalString(req.query.origin, { field: 'origin' });
      if (origin && origin !== 'threadshelf' && origin !== 'archive')
        throw new ValidationError('Invalid origin: expected threadshelf or archive', {
          field: 'origin',
        });
      const key = createHash('sha256')
        .update(
          JSON.stringify({
            q,
            collection,
            mode,
            roles,
            keywordBoost,
            model,
            provider,
            from,
            to,
            origin,
          }),
        )
        .digest('hex');
      prune();
      let id: string,
        offset = 0,
        snapshot: Snapshot;
      if (req.query.cursor !== undefined) {
        [id, offset] = cursorParts(req.query.cursor);
        const cached = snapshots.get(id);
        if (!cached)
          throw new PageError(
            410,
            'Search session expired or was evicted. Start the search again.',
          );
        if (cached.key !== key)
          throw new PageError(400, 'Search cursor does not match the query or filters');
        if (offset > cached.results.length)
          throw new PageError(400, 'Search cursor offset is out of range');
        snapshot = cached;
        // LRU touch; the fixed lifetime is deliberately not extended.
        snapshots.delete(id);
        snapshots.set(id, snapshot);
      } else {
        if (activeBuilds >= 2)
          throw new PageError(503, 'Two searches are already running. Please retry shortly.');
        activeBuilds++;
        ownsBuild = true;
        const signal = controller.signal;
        signal.throwIfAborted();
        const embedding = mode === 'semantic' ? await embedQuery(q) : undefined;
        signal.throwIfAborted();
        const collections = collection === 'all' ? await getAllCollections() : [collection];
        const results: SearchResult[] = [];
        let bytes = 0;
        for (const name of collections) {
          signal.throwIfAborted();
          const rows = await readerSearchCollectionSnapshot(
            name,
            q,
            {
              mode,
              roles,
              keywordBoost,
              model,
              provider,
              from,
              to,
              origin: origin as 'threadshelf' | 'archive' | undefined,
              signal,
              onResult: (row) => {
                // Budget includes text/metadata, never embeddings. Do not truncate
                // a query and report it complete when resources are exhausted.
                bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
                if (bytes > CACHE_BYTES)
                  throw new PageError(
                    503,
                    'Search snapshot exceeds 128 MiB. Narrow the collection, query, date, or model filter. No partial result set was returned.',
                  );
              },
            },
            embedding,
          );
          for (const row of rows) results.push(row);
        }
        const compare =
          mode === 'keyword' ? keywordResultComparator(q) : searchResultComparator(q, keywordBoost);
        results.sort((a, b) => compare(a, b) || tieBreak(a, b));
        signal.throwIfAborted();
        prune();
        let used = [...snapshots.values()].reduce((sum, item) => sum + item.bytes, 0);
        while (snapshots.size && (snapshots.size >= CACHE_ENTRIES || used + bytes > CACHE_BYTES)) {
          const oldest = snapshots.keys().next().value!;
          used -= snapshots.get(oldest)!.bytes;
          snapshots.delete(oldest);
        }
        id = randomBytes(24).toString('hex');
        snapshot = { key, results, bytes, expires: Date.now() + TTL_MS };
        snapshots.set(id, snapshot);
      }
      const end = Math.min(offset + n, snapshot.results.length);
      res.json({
        results: snapshot.results.slice(offset, end),
        total: snapshot.results.length,
        hasMore: end < snapshot.results.length,
        nextCursor: end < snapshot.results.length ? `${id}.${end}` : null,
      });
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      const status =
        error instanceof ValidationError ? 400 : error instanceof PageError ? error.status : 500;
      res
        .status(status)
        .json({
          error: error instanceof Error ? error.message : 'Search failed',
          ...(error instanceof ValidationError ? { field: error.field } : {}),
        });
    } finally {
      if (ownsBuild) activeBuilds--;
    }
  });
  router.delete('/api/reader/search', (req, res) => {
    try {
      const [id] = cursorParts(req.query.cursor);
      snapshots.delete(id);
      res.status(204).end();
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid cursor' });
    }
  });
  return router;
};

export default createReaderSearchRouter();
