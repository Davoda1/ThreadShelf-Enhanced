#!/usr/bin/env node
/** Reproducible synthetic scaling check. Run: node --import tsx --expose-gc scripts/benchmark-search.mjs */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '@lancedb/lancedb';
import { fuseSearchResults } from '../src/search-ranking.ts';
const count = Number(process.env.SEARCH_BENCHMARK_ROWS || 100000);
if (!Number.isSafeInteger(count) || count < 1000 || count > 500000)
  throw new Error('Use 1000–500000 rows');
const temp = await mkdtemp(join(tmpdir(), 'threadshelf-search-benchmark-'));
process.env.LANCEDB_PATH = join(temp, 'lancedb');
process.env.COLLECTIONS_PATH = join(temp, 'collections.json');
const {
  searchCollection,
  keywordSearchCollection,
  lexicalSearchCollection,
  hybridSearchCollectionCandidates,
} = await import('../src/store.ts');
const { closeStoragePublication } = await import('../src/storage-publication.ts');
const dimensions = 384,
  queryVector = [1, ...Array(dimensions - 1).fill(0)];
const measurements = [];
const run = async (name, task) => {
  const started = performance.now();
  const value = await task();
  measurements.push({
    name,
    milliseconds: Math.round(performance.now() - started),
    rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2),
  });
  return value;
};
try {
  const database = await connect(process.env.LANCEDB_PATH);
  const record = (i) => {
    const special = i >= count - 3;
    return {
      id: `synthetic-${String(i).padStart(7, '0')}`,
      vector: special ? [0, 1, ...Array(dimensions - 2).fill(0)] : queryVector,
      document:
        i === count - 3
          ? 'Recovery steps for ERR_CACHE_MISS in the archive tool.'
          : i === count - 2
            ? 'Az árvíztűrő tükörfúrógép működése és javítása.'
            : i === count - 1
              ? 'fixture '.repeat(40)
              : `A synthetic fixture discussing project planning and code example ${i}.`,
      sourceFile: `fixture-${Math.floor(i / 100)}.json`,
      conversationKey: `thread-${Math.floor(i / 100)}`,
      title: i === count - 1 ? 'Unique title lookup' : `Project note ${Math.floor(i / 100)}`,
      provider: i % 2 ? 'openai' : 'anthropic',
      role: i % 3 ? 'ai' : 'user',
      turnIndex: String(i % 100),
      model: special ? 'rare-model' : 'ordinary-model',
      createdAt: '2026-01-01T12:00:00Z',
      createdInThreadShelf: false,
      generationProvider: '',
    };
  };
  await run('build synthetic 384-dimensional LanceDB', async () => {
    let table;
    for (let offset = 0; offset < count; offset += 2000) {
      const rows = Array.from({ length: Math.min(2000, count - offset) }, (_, i) =>
        record(offset + i),
      );
      if (!table) table = await database.createTable('benchmark', rows);
      else await table.add(rows);
    }
  });
  global.gc?.();
  const rare = await run('complete semantic with rare model after rank 200', () =>
    searchCollection('benchmark', 'fixture', { n: 50, model: 'rare-model' }, queryVector),
  );
  assert.equal(rare.length, 3);
  const exact = await run('complete exact scan and top-50 ranking', () =>
    keywordSearchCollection('benchmark', 'fixture', { n: 50 }),
  );
  assert.equal(exact[0].id, record(count - 1).id);
  const cold = await run('cold hybrid: cosine + lexical cache build', () =>
    hybridSearchCollectionCandidates('benchmark', 'ERR_CACHE_MISS', { n: 200 }, queryVector),
  );
  assert.ok(!cold.semantic.some((r) => r.id === record(count - 3).id));
  assert.equal(
    fuseSearchResults(cold.semantic, cold.lexical, 'ERR_CACHE_MISS', 15)[0].id,
    record(count - 3).id,
  );
  const warm = await run('warm hybrid: cosine + lexical lookup', () =>
    hybridSearchCollectionCandidates('benchmark', 'ERR_CACHE_MISS', { n: 200 }, queryVector),
  );
  assert.deepEqual(
    warm.lexical.map((r) => r.id),
    cold.lexical.map((r) => r.id),
  );
  const hu = await run('warm accent-folded Hungarian lexical lookup', () =>
    lexicalSearchCollection('benchmark', 'arvizturo tukorfurogep', { n: 15 }),
  );
  assert.equal(hu[0].id, record(count - 2).id);
  const title = await run('warm title lexical lookup', () =>
    lexicalSearchCollection('benchmark', 'unique title lookup', { n: 15 }),
  );
  assert.equal(title[0].id, record(count - 1).id);
  let cacheBytes = 0;
  const cacheDir = join(process.env.LANCEDB_PATH, '.threadshelf-search');
  for (const file of await readdir(cacheDir)) cacheBytes += (await stat(join(cacheDir, file))).size;
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        rows: count,
        dimensions,
        casesPassed: 6,
        cacheMiB: Math.round((cacheBytes / 1024 ** 2) * 10) / 10,
        peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
        measurements,
        scope:
          'Synthetic correctness/scaling only. Query vectors are supplied; embedding inference excluded. Not a real-archive relevance benchmark or an upstream comparison.',
      },
      null,
      2,
    ),
  );
} finally {
  closeStoragePublication();
  await rm(temp, { recursive: true, force: true });
}
