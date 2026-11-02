# Search in Enhanced 1.4.0

Existing conversation IDs, normalized turns, LanceDB schemas, vector dimensions,
embedding model and Reader APIs remain compatible. No reimport or re-embedding
is required.

| Mode | Retrieval | Ranking |
| --- | --- | --- |
| Semantic | Exact cosine over every eligible indexed chunk | Distance, optional existing exact-phrase boost, deterministic identity ties |
| Exact (`keyword`) | Case-insensitive literal substring across the complete collection | Occurrence count, date, deterministic identity ties |
| Hybrid | Independent complete lexical and cosine retrieval branches | Reciprocal rank fusion with phrase/title/identifier signals, then conversation diversity |

Roles, date, origin, model and pending-index exclusions are applied before each
branch selects its candidates. A rare matching model beyond the former 200-row
window is no longer omitted. All-collection search embeds its query once and
shares one publication snapshot. Native scans stream their results; bounded
heaps retain only the best candidate rows in JavaScript. Each hybrid branch
keeps `max(200, 8 × n)` globally ranked candidates. Its lexical branch is not
restricted to results found by semantic retrieval.

The enhanced `/api/search` and search CLI accept `mode=hybrid`. The existing
response remains `{results}` and the request limit remains 50. Semantic remains
the API default. A lexical-only hybrid hit may omit `distance`; do not display an
invented similarity score for that result.

The unchanged Reader v1 endpoint continues advertising only `keyword` and
`semantic`, full exact totals, stable immutable result snapshots, and the same
48-hex-character cursor plus numeric offset. Existing clients' smart-search
option continues using semantic search with `keywordBoost`. Hybrid diversity
does not alter Reader pages or remove their results.

## Disposable lexical cache

Hybrid retrieval builds a local SQLite FTS cache under
`<configured LanceDB directory>/.threadshelf-search/`. It contains derived text
and metadata, so it is private archive data, not source-release content. It is
keyed by publication generation, physical table, table version, dataset file
identity and pending-index exclusions. It never changes an archive or embedding.
Two completed snapshots per collection are retained; superseded cache files are
removed on a later successful build. Missing, busy, corrupt or oversized caches
fall back to a complete scan with identical lexical normalization and scoring.
No partial cache result is returned after an error.

The cache's build budget is 256 MiB of serialized source rows, not a disk-size
promise; SQLite indexes add overhead. `THREADSHELF_LEXICAL_CACHE=0` disables its
use and selects the full-scan fallback. Token keys encode normalized Unicode
words in ASCII so SQLite's Unicode tokenizer version cannot silently omit a
word recognized by the scan path. Query words are accent-folded for hybrid
retrieval, including Hungarian; Exact retains literal substring semantics.

## Validation and measured scope

`test/search-enhanced.test.js` covers rare filters beyond rank 200, independent
identifier retrieval, Hungarian accents, title retrieval, fallback parity,
whole-file and partial-payload corruption, table-version invalidation,
cancellation, repeated text and conversation diversity, and a bounded heap
against a full sort of 100,000 values. Existing Reader pagination regressions
continue to cover exact counts, stable cursors, filter mismatches, expiry and
legacy response shape.

Run the larger synthetic scaling check with:

```sh
node --import tsx --expose-gc scripts/benchmark-search.mjs
```

The recorded Linux x64 / Node 26.13.0 run used 100,000 actual LanceDB rows with
384-dimensional vectors. Six correctness cases passed. It measured 1.74 seconds
for rare-model exact semantic retrieval, 1.63 seconds for complete Exact search,
4.24 seconds for cold hybrid including cache creation, and 1.74 seconds for warm
hybrid. Warm Hungarian/title lexical-only lookups took 5–7 milliseconds. The
cache occupied 63 MiB. Peak process RSS was 911 MiB including synthetic dataset
construction; reported post-query RSS ranged from 538 to 616 MiB. Raw timings
are in `benchmarks/search-1.4.0-synthetic-100k.json`.

These are synthetic correctness/scaling results with supplied query vectors;
embedding inference is excluded. They are not a real-archive relevance benchmark
or a measured accuracy comparison with upstream. Native exact cosine search
still computes distances over all eligible vectors, so larger archives need
more time and native memory even though JavaScript retains a bounded top-k.
