import { createHash } from 'node:crypto';

/**
 * Compare unordered stored-row snapshots without serializing the whole archive.
 * Only one serialized row and fixed-size digests are retained while hashing.
 * Sorting digests preserves row-order independence and retains duplicate rows.
 * These fingerprints are transient change checks, never persisted identifiers.
 */
export const snapshotFingerprint = (rows: readonly Record<string, unknown>[]): string => {
  const digests = rows.map((row) => createHash('sha256').update(JSON.stringify(row)).digest('hex'));
  digests.sort();
  const hash = createHash('sha256').update(`threadshelf-snapshot-v2\0${rows.length}\0`);
  for (const digest of digests) hash.update(digest);
  return hash.digest('hex');
};
