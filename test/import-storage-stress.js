import { closeStoragePublication } from '../src/storage-publication.js';
// Opt-in full storage stress, synthetic data and deterministic embeddings only:
// node --import tsx --experimental-test-module-mocks --max-old-space-size=512 test/import-storage-stress.js
// Production embeddings are separately exercised by the ordinary integration suites.
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:buffer';
import { getHeapStatistics } from 'node:v8';

const count = Number(process.env.THREADSHELF_STRESS_ROWS ?? 4096);
const payloadBytes = Number(process.env.THREADSHELF_STRESS_ROW_BYTES ?? 262144);
const root = await mkdtemp(join(tmpdir(), 'threadshelf-storage-stress-'));
process.env.LANCEDB_PATH = join(root, 'db');
process.env.COLLECTIONS_PATH = join(root, 'collections.json');
let embedded = 0;
mock.module(new URL('../src/embedding.ts', import.meta.url).href, {
  namedExports: {
    embed: async (texts) => {
      embedded += texts.length;
      return texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)));
    },
    embedOne: async () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
    getDimension: () => 384,
    getEmbeddingIdentity: async () => 'synthetic-storage-stress-v1',
  },
});
const store = await import('../src/store.ts');
const { getStoragePublication } = await import('../src/storage-publication.ts');
const text = 'Synthetic repeated searchable conversation for bounded-memory testing.';
let logicalSerializedCharacters = 1;
let measureSource = true;
const records = async function* (changed = false) {
  const payload = 'x'.repeat(payloadBytes);
  for (let i = 0; i < count; i++) {
    const conversation = {
      key: `synthetic-${i}`,
      title: `Synthetic ${i}`,
      turns: [
        {
          user:
            changed && i === count - 1 ? 'Changed final synthetic searchable conversation.' : text,
        },
      ],
      raw: { payload },
    };
    if (measureSource) {
      const row = {
        turnsJson: JSON.stringify(conversation.turns),
        rawJson: JSON.stringify(conversation.raw),
      };
      logicalSerializedCharacters += JSON.stringify(JSON.stringify(row)).length + 1;
    }
    yield { sourceFile: '/synthetic/export.json', provider: 'openai', conversation };
  }
};
let peakRss = 0,
  peakHeap = 0;
const sample = () => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
};
const timer = setInterval(sample, 20);
const results = [];
try {
  for (const phase of ['fresh', 'repeat', 'changed']) {
    const started = performance.now();
    const before = embedded;
    const previous = getStoragePublication('stress');
    let checkedReader = false;
    const chunks = await store.replaceImportedStream('stress', records(phase === 'changed'), {
      clearFirst: true,
      sourceFiles: ['/synthetic/export.json'],
      onEmbeddingProgress: async (done, total) => {
        sample();
        if (previous && total && done === total && !checkedReader) {
          checkedReader = true;
          assert.equal(getStoragePublication('stress').generation, previous.generation);
          assert.equal(
            (
              await store.getStoredThreads(
                'stress',
                '/synthetic/export.json',
                `synthetic-${count - 1}`,
              )
            ).length,
            1,
          );
        }
      },
    });
    assert.equal(chunks, count);
    measureSource = false;
    assert.equal((await store.listThreadSummaries('stress')).length, count);
    results.push({
      phase,
      elapsedMs: Math.round(performance.now() - started),
      embeddedTexts: embedded - before,
      chunks,
    });
    if (phase === 'fresh') assert.equal(embedded - before, 1);
    if (phase === 'repeat') assert.equal(embedded - before, 0);
    if (phase === 'changed') assert.equal(embedded - before, 1);
  }
  assert.equal((await store.keywordSearchCollection('stress', 'Changed final')).length, 1);
  if (count * payloadBytes >= 1024 ** 3)
    assert.ok(logicalSerializedCharacters > constants.MAX_STRING_LENGTH);
  sample();
  console.log(
    JSON.stringify({
      rows: count,
      payloadBytes: count * payloadBytes,
      legacyFingerprintLowerBoundCharacters: logicalSerializedCharacters,
      singleStringLimit: constants.MAX_STRING_LENGTH,
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      peakRssBytes: peakRss,
      peakHeapBytes: peakHeap,
      results,
    }),
  );
} finally {
  clearInterval(timer);
  mock.restoreAll();
  closeStoragePublication();
  await rm(root, { recursive: true, force: true });
}
