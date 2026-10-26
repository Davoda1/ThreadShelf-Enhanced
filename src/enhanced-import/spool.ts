import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dataPath } from '../paths.js';
import type { EnhancedConversation, EnhancedImportNotice } from './index.js';

/** Each frame is bounded independently; the folder is never one JSON value. */
const MAX_FRAME_BYTES = 128 * 1024 ** 2;
const CHECKPOINT_VERSION = 1;

export interface ImportSpoolRecord {
  readonly sourceFile: string;
  readonly provider: string;
  readonly conversation: EnhancedConversation;
}

export interface ImportCheckpoint {
  readonly version: number;
  readonly inputHash: string;
  readonly recordHash: string;
  readonly sourceFile: string;
  readonly count: number;
  readonly providers: readonly string[];
  readonly warnings: readonly EnhancedImportNotice[];
}

export const createImportStage = async (persistentDirectory?: string) => {
  const persistent = Boolean(persistentDirectory);
  const parent = persistentDirectory
    ? join(resolve(persistentDirectory), 'normalized')
    : join(resolve(process.env.LANCEDB_PATH || dataPath('lancedb')), '.import-staging');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = persistent ? parent : await mkdtemp(join(parent, 'run-'));
  return {
    directory,
    persistent,
    async dispose(success: boolean) {
      if (!persistent || success) await rm(directory, { recursive: true, force: true });
    },
  };
};

export const hashFile = async (filename: string, signal?: AbortSignal): Promise<string> => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename)) {
    signal?.throwIfAborted();
    hash.update(bytes);
  }
  signal?.throwIfAborted();
  return hash.digest('hex');
};

export const inputFingerprint = async (
  filenames: readonly string[],
  sourcePaths: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<string> => {
  const hash = createHash('sha256');
  hash.update(`threadshelf-normalized-input-v${CHECKPOINT_VERSION}\0`);
  for (const filename of filenames) {
    signal?.throwIfAborted();
    hash.update(JSON.stringify([resolve(filename), sourcePaths[resolve(filename)] ?? filename]));
    hash.update(await hashFile(filename, signal));
  }
  return hash.digest('hex');
};

export const spoolPath = (directory: string, sourceFile: string): string =>
  join(directory, createHash('sha256').update(sourceFile).digest('hex') + '.records');

export const readCheckpoint = async (
  filename: string,
  sourceFile: string,
  inputHash: string,
  signal?: AbortSignal,
): Promise<ImportCheckpoint | undefined> => {
  try {
    const checkpointPath = filename + '.complete.json';
    const stat = await lstat(checkpointPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return undefined;
    const value = JSON.parse(await readFile(checkpointPath, 'utf8')) as ImportCheckpoint;
    if (
      value.version !== CHECKPOINT_VERSION ||
      value.inputHash !== inputHash ||
      value.sourceFile !== sourceFile ||
      !Number.isSafeInteger(value.count) ||
      value.count < 1 ||
      !Array.isArray(value.providers) ||
      !value.providers.every((provider) => typeof provider === 'string') ||
      !Array.isArray(value.warnings) ||
      value.warnings.length > 1000
    )
      return undefined;
    const recordsStat = await lstat(filename);
    if (!recordsStat.isFile() || recordsStat.isSymbolicLink()) return undefined;
    if ((await hashFile(filename, signal)) !== value.recordHash) return undefined;
    return value;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
};

export const createSpoolWriter = async (filename: string, signal?: AbortSignal) => {
  const partial = filename + '.partial';
  // A previous partial belongs to this job and never counted as a checkpoint.
  await rm(partial, { force: true });
  const file = await open(partial, 'wx', 0o600);
  const hash = createHash('sha256');
  let closed = false;
  return {
    async append(record: ImportSpoolRecord) {
      signal?.throwIfAborted();
      const json = JSON.stringify(record);
      const length = Buffer.byteLength(json);
      if (length > MAX_FRAME_BYTES)
        throw new Error(
          `Normalized conversation exceeds the ${MAX_FRAME_BYTES / 1024 ** 2} MiB staging limit. Export a smaller conversation; the existing collection has not been replaced.`,
        );
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(length);
      await file.writeFile(header);
      await file.writeFile(json, 'utf8');
      hash.update(header).update(json);
    },
    async finish(checkpoint: Omit<ImportCheckpoint, 'version' | 'recordHash'>) {
      signal?.throwIfAborted();
      await file.sync();
      await file.close();
      closed = true;
      await rename(partial, filename);
      const value: ImportCheckpoint = {
        ...checkpoint,
        version: CHECKPOINT_VERSION,
        recordHash: hash.digest('hex'),
      };
      const checkpointPartial = filename + '.checkpoint.partial';
      await writeFile(checkpointPartial, JSON.stringify(value), { mode: 0o600 });
      const checkpointFile = await open(checkpointPartial, 'r');
      try {
        await checkpointFile.sync();
      } finally {
        await checkpointFile.close();
      }
      await rename(checkpointPartial, filename + '.complete.json');
      return value;
    },
    async discard() {
      if (!closed) {
        await file.close();
        closed = true;
      }
      await rm(partial, { force: true });
    },
  };
};

export async function* readImportSpool(
  filename: string,
  signal?: AbortSignal,
): AsyncGenerator<ImportSpoolRecord> {
  const file = await open(filename, 'r');
  let offset = 0;
  const readExactly = async (buffer: Buffer): Promise<number> => {
    let read = 0;
    while (read < buffer.length) {
      signal?.throwIfAborted();
      const next = await file.read(buffer, read, buffer.length - read, offset);
      if (!next.bytesRead) break;
      read += next.bytesRead;
      offset += next.bytesRead;
    }
    return read;
  };
  try {
    for (;;) {
      const header = Buffer.allocUnsafe(4);
      const headerBytes = await readExactly(header);
      if (!headerBytes) return;
      if (headerBytes !== 4) throw new Error('Truncated import checkpoint header.');
      const length = header.readUInt32BE();
      if (!length || length > MAX_FRAME_BYTES) throw new Error('Invalid import checkpoint frame.');
      const bytes = Buffer.allocUnsafe(length);
      if ((await readExactly(bytes)) !== length)
        throw new Error('Truncated import checkpoint record.');
      const record = JSON.parse(bytes.toString('utf8')) as ImportSpoolRecord;
      if (
        typeof record.sourceFile !== 'string' ||
        typeof record.provider !== 'string' ||
        typeof record.conversation?.key !== 'string' ||
        !Array.isArray(record.conversation.turns)
      )
        throw new Error('Invalid normalized conversation in import checkpoint.');
      yield record;
    }
  } finally {
    await file.close();
  }
}
