import {
  searchCollection,
  keywordSearchCollection,
  hybridSearchCollectionCandidates,
  keywordResultComparator,
  type SearchResult,
  type SearchOptions,
} from '../store.js';
import { embedOne } from '../embedding.js';
import { getAllCollections } from './collections.js';
import type { EnhancedSearchMode } from '../validation.js';
import {
  fuseSearchResults,
  lexicalResultComparator,
  stableSearchTie,
  TopResults,
} from '../search-ranking.js';
import { withStorageReadLease } from '../storage-read-leases.js';
import { withPublicationSnapshot } from '../storage-publication.js';

export interface MultiSearchOptions extends SearchOptions {
  readonly mode?: EnhancedSearchMode;
}

/** One publication snapshot for every collection and both hybrid branches. */
export const searchAcrossCollections = async (
  query: string,
  collection: string,
  opts: MultiSearchOptions = {},
): Promise<SearchResult[]> =>
  withStorageReadLease(() =>
    withPublicationSnapshot(async () => {
      opts.signal?.throwIfAborted();
      const n = opts.n ?? 15;
      const collections = collection === 'all' ? await getAllCollections() : [collection];
      if (opts.mode === 'keyword') {
        const best = new TopResults<SearchResult>(n, keywordResultComparator(query));
        for (const name of collections) {
          opts.signal?.throwIfAborted();
          for (const row of await keywordSearchCollection(name, query, opts)) best.add(row);
        }
        return best.values();
      }

      // A single local embedding regardless of collection count or hybrid branches.
      const embedding = await embedOne(query);
      opts.signal?.throwIfAborted();
      if (opts.mode === 'hybrid') {
        const candidateCount = Math.max(200, n * 8);
        const semantic = new TopResults<SearchResult>(
          candidateCount,
          searchResultComparator(query, false),
        );
        const lexical = new TopResults<SearchResult>(
          candidateCount,
          lexicalResultComparator(query),
        );
        for (const name of collections) {
          opts.signal?.throwIfAborted();
          const candidates = await hybridSearchCollectionCandidates(
            name,
            query,
            { ...opts, n: candidateCount },
            embedding,
          );
          for (const row of candidates.semantic) semantic.add(row);
          for (const row of candidates.lexical) lexical.add(row);
        }
        return fuseSearchResults(semantic.values(), lexical.values(), query, n);
      }

      const best = new TopResults<SearchResult>(
        n,
        searchResultComparator(query, opts.keywordBoost === true),
      );
      for (const name of collections) {
        opts.signal?.throwIfAborted();
        for (const row of await searchCollection(name, query, opts, embedding)) best.add(row);
      }
      return best.values();
    }),
  );

export const searchResultComparator =
  (query: string, keywordBoost: boolean) =>
  (a: SearchResult, b: SearchResult): number => {
    if (keywordBoost) {
      const needle = query.trim().toLowerCase();
      const aHas = needle.length > 0 && a.document.toLowerCase().includes(needle);
      const bHas = needle.length > 0 && b.document.toLowerCase().includes(needle);
      if (aHas !== bHas) return aHas ? -1 : 1;
    }
    return (
      (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY) ||
      stableSearchTie(a, b)
    );
  };
