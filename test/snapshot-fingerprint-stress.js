// Opt-in, dependency-free regression:
//   node test/snapshot-fingerprint-stress.js
// Each child is restricted to 96 MiB of old-space. This intentionally reproduces
// the legacy allocation failure, so disable OS core dumps before running when
// enabled by the host (for example, `ulimit -c 0` on Linux).
// No database, embedding model, or private data is used.
import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { snapshotFingerprint } from '../src/snapshot-fingerprint.ts';

const mode = process.argv[2];
if (mode === 'legacy' || mode === 'bounded') {
  // Shared input keeps the fixture itself small. The legacy map still creates
  // one distinct serialized string per row and then one collection-wide string.
  const row = { rawJson: 'x'.repeat(256 * 1024), title: 'Synthetic stress fixture' };
  const serializedLength = JSON.stringify(JSON.stringify(row)).length;
  const count = Math.ceil((constants.MAX_STRING_LENGTH + 1) / (serializedLength + 1));
  const logicalLength = 1 + count * (serializedLength + 1);
  assert.ok(logicalLength > constants.MAX_STRING_LENGTH);
  const rows = Array(count).fill(row);
  const fingerprint =
    mode === 'legacy'
      ? createHash('sha256')
          .update(JSON.stringify(rows.map((item) => JSON.stringify(item)).sort()))
          .digest('hex')
      : snapshotFingerprint(rows);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  console.log(
    JSON.stringify({
      mode,
      rows: count,
      logicalLength,
      maximumStringLength: constants.MAX_STRING_LENGTH,
      fingerprint,
    }),
  );
} else {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const script = fileURLToPath(import.meta.url);
  const run = (workerMode) =>
    spawnSync(process.execPath, ['--max-old-space-size=96', script, workerMode], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  const bounded = run('bounded');
  assert.ifError(bounded.error);
  assert.equal(bounded.status, 0, bounded.stderr);
  const result = JSON.parse(bounded.stdout);
  assert.ok(result.logicalLength > result.maximumStringLength);
  const legacy = run('legacy');
  assert.ifError(legacy.error);
  assert.notEqual(legacy.status, 0, 'The legacy implementation unexpectedly passed');
  assert.match(legacy.stderr, /heap out of memory|Invalid string length/);
  console.log(JSON.stringify({ ...result, oldSpaceMiB: 96, legacyFailed: true }));
}
