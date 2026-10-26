import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rm, stat, statfs } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { IngestResult, ProgressEvent } from './ingest.js';
import type { EnhancedImportNotice } from './enhanced-import/index.js';
import { withInterprocessLock } from './interprocess-lock.js';
import {
  indexingDataPath,
  IndexingBusyError,
  CollectionBusyError,
  withIndexOperation,
  withCollectionJobLifecycle,
  withExclusiveCollectionMutation,
} from './indexing-coordinator.js';

export type ImportJobState =
  'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface ImportJob {
  readonly id: string;
  readonly collection: string;
  readonly kind: 'folder' | 'upload' | 'watch';
  readonly state: ImportJobState;
  readonly clearFirst: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly progress?: ProgressEvent;
  readonly result?: IngestResult;
  readonly error?: string;
  readonly cancelRequested: boolean;
  readonly attempts: number;
  readonly safeToClose: true;
  readonly collectionLocked: boolean;
  /** True once this attempt has published at least one source into the archive. */
  readonly archivePublished?: boolean;
}

interface StoredJob extends ImportJob {
  readonly sourceRoot: string;
  readonly inputReady: boolean;
  readonly selectedFiles?: readonly string[];
  readonly inputSkipped?: readonly EnhancedImportNotice[];
}

interface InputFile {
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
}

export interface UploadedJobFile {
  readonly path: string;
  readonly relativePath: string;
}

const terminal = new Set<ImportJobState>(['completed', 'failed', 'cancelled']);
let database: DatabaseSync | undefined;
let databasePath = '';
let openingDatabase: Promise<DatabaseSync> | undefined;
let pumping: Promise<void> | undefined;
let runnerTimer: NodeJS.Timeout | undefined;
let stopping = false;
let historyCleanup: Promise<void> | undefined;
const activeControllers = new Map<string, AbortController>();
const listeners = new Map<string, Set<(job: ImportJob) => void>>();

const jobRoot = (id: string): string => indexingDataPath('.import-jobs', id);
const inputRoot = (id: string): string => join(jobRoot(id), 'input');
/** Source cleanup cannot race durable acceptance or retry, even across collections. */
const withInputMaintenance = <T>(fn: () => Promise<T>): Promise<T> =>
  withInterprocessLock(indexingDataPath('.coordination', 'import-inputs'), fn);

const getDatabase = async (): Promise<DatabaseSync> => {
  const path = indexingDataPath('.import-jobs', 'jobs.sqlite');
  if (database && databasePath === path) return database;
  if (openingDatabase) {
    await openingDatabase;
    return getDatabase();
  }
  const pending = (async () => {
    if (database) database.close();
    database = undefined;
    databasePath = '';
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const next = new DatabaseSync(path);
    try {
      next.exec(`
    PRAGMA busy_timeout = 2000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      clearFirst INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_by_state ON jobs(state, createdAt);
    CREATE INDEX IF NOT EXISTS jobs_by_collection ON jobs(collection, createdAt);
    CREATE TABLE IF NOT EXISTS input_files (
      jobId TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY(jobId, relativePath)
    );
    CREATE TABLE IF NOT EXISTS job_history_cleanup (id TEXT PRIMARY KEY);
  `);
      if (
        !next
          .prepare('PRAGMA table_info(jobs)')
          .all()
          .some((column) => column.name === 'clearFirst')
      ) {
        next.exec('ALTER TABLE jobs ADD COLUMN clearFirst INTEGER NOT NULL DEFAULT 0');
        next.exec("UPDATE jobs SET clearFirst = COALESCE(json_extract(value, '$.clearFirst'), 0)");
      }

      next.exec('COMMIT');
      await chmod(path, 0o600);
      database = next;
      databasePath = path;
      return next;
    } catch (error) {
      next.close();
      throw error;
    }
  })();
  openingDatabase = pending;
  try {
    return await pending;
  } finally {
    if (openingDatabase === pending) openingDatabase = undefined;
  }
};

const publicJob = (stored: StoredJob): ImportJob => {
  return {
    id: stored.id,
    collection: stored.collection,
    kind: stored.kind,
    state: stored.state,
    clearFirst: stored.clearFirst,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    startedAt: stored.startedAt,
    finishedAt: stored.finishedAt,
    progress: stored.progress,
    result: stored.result,
    error: stored.error,
    cancelRequested: stored.cancelRequested,
    attempts: stored.attempts,
    archivePublished: stored.archivePublished,
    safeToClose: true,
    collectionLocked:
      stored.clearFirst && ['running', 'paused', 'interrupted'].includes(stored.state),
  };
};

const readStoredJob = async (id: string): Promise<StoredJob | null> => {
  const row = (await getDatabase()).prepare('SELECT value FROM jobs WHERE id = ?').get(id);
  return row ? (JSON.parse(String(row.value)) as StoredJob) : null;
};

const saveJob = async (job: StoredJob): Promise<StoredJob> => {
  const updated = { ...job, updatedAt: Date.now() };
  (await getDatabase())
    .prepare(
      `INSERT INTO jobs(id,collection,clearFirst,state,createdAt,updatedAt,value) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state, updatedAt=excluded.updatedAt, value=excluded.value`,
    )
    .run(
      updated.id,
      updated.collection,
      updated.clearFirst ? 1 : 0,
      updated.state,
      updated.createdAt,
      updated.updatedAt,
      JSON.stringify(updated),
    );
  for (const listener of listeners.get(updated.id) ?? []) {
    try {
      listener(publicJob(updated));
    } catch {
      /* Observers cannot fail a durable job. */
    }
  }
  return updated;
};

const updateJob = async (
  id: string,
  changes: Partial<StoredJob> | ((current: StoredJob) => Partial<StoredJob>),
): Promise<StoredJob> => {
  const db = await getDatabase();
  // Read-modify-write is synchronous while this connection owns the transaction.
  db.exec('BEGIN IMMEDIATE');
  let updated: StoredJob;
  try {
    const row = db.prepare('SELECT value FROM jobs WHERE id = ?').get(id);
    if (!row) throw new Error('Import job not found');
    const current = JSON.parse(String(row.value)) as StoredJob;
    updated = {
      ...current,
      ...(typeof changes === 'function' ? changes(current) : changes),
      updatedAt: Date.now(),
    };
    db.prepare('UPDATE jobs SET state=?, updatedAt=?, value=? WHERE id=?').run(
      updated.state,
      updated.updatedAt,
      JSON.stringify(updated),
      id,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  for (const listener of listeners.get(id) ?? []) {
    try {
      listener(publicJob(updated));
    } catch {
      /* Observers are independent. */
    }
  }
  return updated;
};

export const getImportJob = async (id: string): Promise<ImportJob | null> => {
  const job = await readStoredJob(id);
  return job ? publicJob(job) : null;
};

export const listImportJobs = async (collection?: string): Promise<ImportJob[]> => {
  const db = await getDatabase();
  const rows = collection
    ? db
        .prepare('SELECT value FROM jobs WHERE collection = ? ORDER BY createdAt DESC LIMIT 100')
        .all(collection)
    : db.prepare('SELECT value FROM jobs ORDER BY createdAt DESC LIMIT 100').all();
  return rows.map((row) => publicJob(JSON.parse(String(row.value))));
};

/** Retry only job-owned garbage, including cleanup interrupted by a process exit. */
const cleanupRemovedImportJobs = (): Promise<void> => {
  if (historyCleanup) return historyCleanup;
  historyCleanup = (async () => {
    const db = await getDatabase();
    const pending = db.prepare('SELECT id FROM job_history_cleanup LIMIT 100').all();
    for (const row of pending) {
      const id = String(row.id);
      // Never turn a damaged metadata identifier into a filesystem traversal.
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) continue;
      try {
        await rm(jobRoot(id), { recursive: true, force: true });
        db.prepare('DELETE FROM job_history_cleanup WHERE id=?').run(id);
      } catch (error) {
        // History removal has committed. Keep the tombstone for a later retry.
        console.warn('[import:history-cleanup]', error);
      }
    }
  })().finally(() => {
    historyCleanup = undefined;
  });
  return historyCleanup;
};

const removeTerminalJob = async (
  id: string,
  collection: string,
): Promise<'deleted' | 'missing' | 'protected'> =>
  withCollectionJobLifecycle(collection, async () => {
    const db = await getDatabase();
    // Claiming and retrying use this same lock. Recheck after acquiring it.
    const current = db.prepare('SELECT state FROM jobs WHERE id=?').get(id);
    if (!current) return 'missing';
    if (!terminal.has(String(current.state) as ImportJobState)) return 'protected';
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO job_history_cleanup(id) VALUES(?)').run(id);
      db.prepare('DELETE FROM input_files WHERE jobId=?').run(id);
      db.prepare('DELETE FROM jobs WHERE id=?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return 'deleted';
  });

/** Remove terminal history and retry inputs, never published source files or archive data. */
export const deleteImportJob = async (id: string): Promise<boolean> => {
  const current = await readStoredJob(id);
  if (!current) return false;
  const result = await removeTerminalJob(id, current.collection);
  if (result === 'protected')
    throw Object.assign(
      new Error('Only completed, failed or cancelled import history can be removed'),
      {
        status: 409,
      },
    );
  if (result === 'deleted') await cleanupRemovedImportJobs();
  return result === 'deleted';
};

export const clearFinishedImportJobs = async (collection?: string): Promise<number> => {
  const db = await getDatabase();
  const upper = Number(
    db.prepare('SELECT COALESCE(MAX(rowid),0) AS cursor FROM jobs').get()!.cursor,
  );
  let cursor = 0,
    deleted = 0;
  // Bound memory independently of the visible/listed history length.
  while (cursor < upper) {
    const rows = db
      .prepare(
        `SELECT rowid AS cursor,id,collection FROM jobs
      WHERE rowid>? AND rowid<=? AND state IN ('completed','failed','cancelled')
      ${collection ? 'AND collection=?' : ''} ORDER BY rowid LIMIT 100`,
      )
      .all(cursor, upper, ...(collection ? [collection] : []));
    if (!rows.length) break;
    for (const row of rows) {
      cursor = Number(row.cursor);
      if ((await removeTerminalJob(String(row.id), String(row.collection))) === 'deleted')
        deleted++;
    }
    await cleanupRemovedImportJobs();
  }
  return deleted;
};

/** Subscribe is only an optimization. Polling the durable record works across processes. */
export const observeImportJob = (id: string, listener: (job: ImportJob) => void): (() => void) => {
  const set = listeners.get(id) ?? new Set();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(id);
  };
};

const safeRelativePath = (path: string): string => {
  const value = path.replace(/\\/g, '/');
  if (
    !value ||
    isAbsolute(value) ||
    value.split('/').some((part) => !part || part === '..' || part === '.') ||
    value.includes('\0')
  ) {
    throw new Error('Unsafe import input path');
  }
  return value;
};

const copyVerifiedFile = async (
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<InputFile> => {
  signal?.throwIfAborted();
  const before = await lstat(source);
  if (!before.isFile()) throw new Error(`Import input is not a regular file: ${basename(source)}`);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const space = await statfs(dirname(destination));
  if (space.bavail * space.bsize < before.size + 256 * 1024 ** 2) {
    throw new Error(
      'Insufficient free disk space to copy import files. Free disk space before retrying.',
    );
  }
  const digest = createHash('sha256');
  let size = 0;
  const hashing = new Transform({
    transform(chunk, _encoding, callback) {
      digest.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(source),
    hashing,
    createWriteStream(destination, { flags: 'wx', mode: 0o600, flush: true }),
    { signal },
  );
  const after = await lstat(source);
  if (
    !after.isFile() ||
    size !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    after.ino !== before.ino
  ) {
    throw new Error(`Import input changed while being copied: ${basename(source)}`);
  }
  return { relativePath: '', size, sha256: digest.digest('hex') };
};

const syncDirectory = async (path: string): Promise<void> => {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Windows does not expose portable directory fsync through Node; every
    // copied file is still flushed before its manifest can become ready.
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    )
      throw error;
  }
};

const syncInputDirectories = async (id: string): Promise<void> => {
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory()) await visit(join(path, entry.name));
    await syncDirectory(path);
  };
  await visit(inputRoot(id));
  await syncDirectory(jobRoot(id));
  await syncDirectory(dirname(jobRoot(id)));
};

const addManifestFile = async (id: string, entry: InputFile): Promise<void> => {
  (await getDatabase())
    .prepare('INSERT INTO input_files(jobId,relativePath,size,sha256) VALUES (?,?,?,?)')
    .run(id, entry.relativePath, entry.size, entry.sha256);
};

const baseJob = (
  collection: string,
  kind: StoredJob['kind'],
  sourceRoot: string,
  clearFirst: boolean,
  id = randomUUID(),
): StoredJob => ({
  id,
  collection,
  kind,
  sourceRoot: resolve(sourceRoot),
  clearFirst,
  state: 'queued',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  cancelRequested: false,
  attempts: 0,
  inputReady: false,
  safeToClose: true,
  collectionLocked: false,
});

const containsDirectory = (parent: string, child: string): boolean => {
  const part = relative(parent, child);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
};

const validateSourceLocation = async (source: string): Promise<string> => {
  const jobs = indexingDataPath('.import-jobs');
  await mkdir(jobs, { recursive: true, mode: 0o700 });
  const [canonicalSource, canonicalJobs] = await Promise.all([realpath(source), realpath(jobs)]);
  if (
    containsDirectory(canonicalSource, canonicalJobs) ||
    containsDirectory(canonicalJobs, canonicalSource)
  ) {
    throw new Error('Import source and import job storage must be separate directories');
  }
  return canonicalSource;
};

export const createFolderImportJob = async (options: {
  readonly collection: string;
  readonly folderPath: string;
  readonly clearFirst?: boolean;
  readonly files?: readonly string[];
  readonly autoStart?: boolean;
}): Promise<ImportJob> =>
  withInputMaintenance(async () => {
    const source = resolve(options.folderPath);
    if (!(await stat(source)).isDirectory()) throw new Error('Import source is not a directory');
    await validateSourceLocation(source);
    const selectedFiles = options.files?.map((file) =>
      safeRelativePath(relative(source, resolve(file))),
    );
    const job = await withCollectionJobLifecycle(options.collection, () =>
      saveJob({
        ...baseJob(
          options.collection,
          selectedFiles ? 'watch' : 'folder',
          source,
          options.clearFirst === true,
        ),
        ...(selectedFiles ? { selectedFiles } : {}),
      }),
    );
    if (options.autoStart !== false) kickImportJobs();
    return publicJob(job);
  });

/** Acceptance occurs only after every fully-uploaded file is durably copied. */
export const createUploadedImportJob = async (options: {
  readonly collection: string;
  readonly sourceRoot: string;
  readonly clearFirst?: boolean;
  readonly files: readonly UploadedJobFile[];
  readonly autoStart?: boolean;
}): Promise<ImportJob> => {
  if (!options.files.length) throw new Error('No files uploaded');
  const job = baseJob(
    options.collection,
    'upload',
    options.sourceRoot,
    options.clearFirst === true,
  );
  const seen = new Set<string>();
  try {
    await mkdir(inputRoot(job.id), { recursive: true, mode: 0o700 });
    for (const file of options.files) {
      const name = safeRelativePath(file.relativePath);
      const identity = process.platform === 'win32' ? name.toLowerCase() : name;
      if (seen.has(identity)) throw new Error(`Duplicate upload path: ${name}`);
      seen.add(identity);
      const copied = await copyVerifiedFile(file.path, join(inputRoot(job.id), name));
      await addManifestFile(job.id, { ...copied, relativePath: name });
    }
    await syncInputDirectories(job.id);
    const accepted = await withInputMaintenance(() =>
      withCollectionJobLifecycle(job.collection, () => saveJob({ ...job, inputReady: true })),
    );
    if (options.autoStart !== false) kickImportJobs();
    return publicJob(accepted);
  } catch (error) {
    (await getDatabase()).prepare('DELETE FROM input_files WHERE jobId=?').run(job.id);
    await rm(jobRoot(job.id), { recursive: true, force: true });
    throw error;
  }
};

const emptyProgress = (phase: string): ProgressEvent => ({
  status: 'progress',
  phase,
  totalFiles: 0,
  processedFiles: 0,
  totalChunks: 0,
  totalTokens: 0,
  elapsedMs: 0,
});

const snapshotFolder = async (job: StoredJob, signal: AbortSignal): Promise<void> => {
  const { isExportFileName } = await import('./ingest.js');
  const { isClearlyUnsupportedExportPrefix } = await import('./enhanced-import/index.js');
  // Resolve again immediately before walking: a queued source alias may have
  // changed since the request was accepted.
  const canonicalSource = await validateSourceLocation(job.sourceRoot);
  await rm(inputRoot(job.id), { recursive: true, force: true });
  await mkdir(inputRoot(job.id), { recursive: true, mode: 0o700 });
  (await getDatabase()).prepare('DELETE FROM input_files WHERE jobId=?').run(job.id);
  let count = 0;
  const skipped: EnhancedImportNotice[] = [];
  const skip = (sourceFile: string, message: string) => {
    if (skipped.length < 1000) skipped.push({ sourceFile, code: 'unsupported', message });
  };
  const selected = job.selectedFiles ? new Set(job.selectedFiles) : undefined;
  const mediaParents = job.selectedFiles?.map((name) => dirname(name).replace(/\\/g, '/'));
  const mediaCandidate = (name: string): boolean =>
    !mediaParents || mediaParents.some((parent) => parent === '.' || name.startsWith(parent + '/'));
  const walk = async (folder: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > 64) throw new Error('Folder nesting exceeds import depth limit');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      signal.throwIfAborted();
      const source = join(folder, entry.name);
      if (entry.isDirectory()) await walk(source, depth + 1);
      else if (entry.isFile()) {
        const name = safeRelativePath(relative(canonicalSource, source));
        // Copy supported export candidates and bounded raster companions only.
        // Unrelated videos, installers, checksum sidecars and other large files
        // must neither consume staging space nor prevent valid imports.
        const raster = /\.(?:png|jpe?g|gif|webp)$/i.test(entry.name);
        if (selected && !selected.has(name) && !(raster && mediaCandidate(name))) continue;
        if (!isExportFileName(entry.name) && !raster) {
          skip(source, 'Unrelated or unsupported file was skipped.');
          continue;
        }
        if (raster && (await stat(source)).size > 5 * 1024 ** 2) {
          skip(source, 'Image companion exceeds the 5 MiB image limit and was skipped.');
          continue;
        }
        if (!raster) {
          const handle = await open(source, 'r');
          let unsupported: boolean;
          try {
            const prefix = Buffer.alloc(8192);
            const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
            unsupported = isClearlyUnsupportedExportPrefix(prefix.subarray(0, bytesRead), source);
          } finally {
            await handle.close();
          }
          if (unsupported) {
            skip(source, 'Unrelated or unsupported file was skipped.');
            continue;
          }
        }
        if (++count > 100000) throw new Error('Too many files in import folder');
        const copied = await copyVerifiedFile(source, join(inputRoot(job.id), name), signal);
        await addManifestFile(job.id, { ...copied, relativePath: name });
        if (count % 25 === 0)
          await updateJob(job.id, {
            progress: { ...emptyProgress('staging'), processedFiles: count },
          });
      } else if (entry.isSymbolicLink())
        skip(source, 'Symbolic links are not followed during import.');
    }
  };
  await walk(canonicalSource, 0);
  await syncInputDirectories(job.id);
  await updateJob(job.id, { inputReady: true, inputSkipped: skipped });
};

const verifySnapshot = async (job: StoredJob, signal: AbortSignal): Promise<void> => {
  const db = await getDatabase();
  const rows = db
    .prepare('SELECT relativePath,size,sha256 FROM input_files WHERE jobId=? ORDER BY relativePath')
    .iterate(job.id);
  for (const row of rows) {
    signal.throwIfAborted();
    const path = join(inputRoot(job.id), safeRelativePath(String(row.relativePath)));
    const digest = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(path, { signal })) {
      digest.update(chunk);
      size += chunk.length;
    }
    if (size !== Number(row.size) || digest.digest('hex') !== row.sha256)
      throw new Error(
        'A staged import file failed its checksum verification. Retry using the original files.',
      );
  }
};

const publishUploadedSources = async (
  job: StoredJob,
  result: IngestResult,
  signal: AbortSignal,
): Promise<void> => {
  if (job.kind !== 'upload' || result.replacementSkipped || !result.files.length) return;
  const accepted = new Set(
    (result.completedSourceFiles ?? result.files).map((path) => resolve(path)),
  );
  const mediaParents = [...accepted].map(dirname);
  // Archive rows preserve the historical .uploads/<collection>/file identities.
  // Only the owning global job publishes inputs, after a successful import.
  const db = await getDatabase();
  for (const row of db
    .prepare('SELECT relativePath FROM input_files WHERE jobId=? ORDER BY relativePath')
    .iterate(job.id)) {
    signal.throwIfAborted();
    const name = safeRelativePath(String(row.relativePath));
    const destination = join(job.sourceRoot, name);
    // Unsupported input is ignored, including its original-file copy. It must
    // never overwrite an earlier valid export with the same source identity.
    const raster = /\.(?:png|jpe?g|gif|webp)$/i.test(name);
    if (
      !accepted.has(resolve(destination)) &&
      !(raster && mediaParents.some((parent) => containsDirectory(parent, destination)))
    )
      continue;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const { rename } = await import('node:fs/promises');
    const temporary = `${destination}.import-${job.id}`;
    await rm(temporary, { force: true });
    try {
      await copyVerifiedFile(join(inputRoot(job.id), name), temporary, signal);
      await rename(temporary, destination);
      await syncDirectory(dirname(destination));
    } finally {
      await rm(temporary, { force: true });
    }
  }
};

const runJob = async (initial: StoredJob): Promise<void> => {
  const claimed = await withCollectionJobLifecycle(initial.collection, async () => {
    const current = await readStoredJob(initial.id);
    if (!current || current.cancelRequested || !['queued', 'interrupted'].includes(current.state))
      return null;
    const updated = await updateJob(current.id, (latest) =>
      latest.cancelRequested || !['queued', 'interrupted'].includes(latest.state)
        ? {}
        : {
            state: 'running',
            startedAt: latest.startedAt ?? Date.now(),
            finishedAt: undefined,
            attempts: latest.attempts + 1,
            archivePublished: false,
            error: undefined,
            result: undefined,
            progress: emptyProgress(latest.inputReady ? 'verifying' : 'staging'),
          },
    );
    return updated.state === 'running' && !updated.cancelRequested ? updated : null;
  });
  if (!claimed) return;
  const controller = new AbortController();
  activeControllers.set(initial.id, controller);
  let progressTail = Promise.resolve();
  const cancelTimer = setInterval(() => {
    void readStoredJob(initial.id)
      .then((job) => {
        if (job?.cancelRequested || stopping)
          controller.abort(
            new Error(
              stopping
                ? 'Server is stopping; import can be resumed.'
                : 'Import cancelled by the user.',
            ),
          );
      })
      .catch((error) => controller.abort(error));
  }, 250);
  cancelTimer.unref();
  try {
    let job = claimed;
    await withIndexOperation(
      job.collection,
      job.clearFirst,
      async () => {
        if (!job.inputReady) {
          await snapshotFolder(job, controller.signal);
          job = (await readStoredJob(job.id))!;
        }
        await verifySnapshot(job, controller.signal);
        const { ingestFolder, ingestFiles } = await import('./ingest.js');
        const onProgress = (progress: ProgressEvent): void => {
          progressTail = progressTail
            .then(() =>
              updateJob(job.id, {
                progress,
                state: progress.phase === 'memory-paused' ? 'paused' : 'running',
              }),
            )
            .then(() => {});
          void progressTail.catch((error) => controller.abort(error));
        };
        const options = {
          clearFirst: job.clearFirst,
          signal: controller.signal,
          onProgress,
          sourceRoot: job.sourceRoot,
          stagingDirectory: join(jobRoot(job.id), 'stage'),
        };
        const present = new Set(
          (await getDatabase())
            .prepare('SELECT relativePath FROM input_files WHERE jobId=?')
            .all(job.id)
            .map((row) => String(row.relativePath)),
        );
        const selectedFiles = job.selectedFiles?.filter((name) => present.has(name));
        const imported = job.selectedFiles
          ? await ingestFiles(
              job.collection,
              selectedFiles!.map((name) => join(inputRoot(job.id), name)),
              {
                ...options,
                sourceFiles: Object.fromEntries(
                  selectedFiles!.map((name) => [
                    join(inputRoot(job.id), name),
                    join(job.sourceRoot, name),
                  ]),
                ),
              },
            )
          : await ingestFolder(job.collection, inputRoot(job.id), options);
        const result: IngestResult = job.inputSkipped?.length
          ? {
              ...imported,
              skippedFiles: [
                ...new Set([
                  ...(imported.skippedFiles ?? []),
                  ...job.inputSkipped.map((entry) => entry.sourceFile),
                ]),
              ],
              warnings: [...(imported.warnings ?? []), ...job.inputSkipped].slice(0, 1000),
            }
          : imported;
        await progressTail;
        await updateJob(job.id, {
          result,
          archivePublished: result.files.length > 0 && !result.replacementSkipped,
          progress: {
            ...((await readStoredJob(job.id))?.progress ?? emptyProgress('publishing')),
            phase: 'publishing-sources',
          },
        });
        // The archive has already committed. Finish installing its source files
        // even if Cancel arrives now; reporting a cancelled pre-commit import at
        // this point would misrepresent the published data.
        await publishUploadedSources(job, result, new AbortController().signal);
        await updateJob(job.id, (current) => ({
          state: result.errors.length || result.replacementSkipped ? 'failed' : 'completed',
          result,
          error: result.errors.length
            ? result.errors.join('\n')
            : result.replacementSkipped
              ? 'Collection replacement was skipped; existing data was preserved.'
              : undefined,
          finishedAt: Date.now(),
          ...(!result.errors.length && !result.replacementSkipped
            ? {
                progress: {
                  ...(current.progress ?? emptyProgress('completed')),
                  phase: 'completed',
                  progressPercent: 100,
                },
              }
            : {}),
        }));
        if (!result.errors.length && !result.replacementSkipped) {
          try {
            await rm(inputRoot(job.id), { recursive: true, force: true });
            await rm(join(jobRoot(job.id), 'stage'), { recursive: true, force: true });
            (await getDatabase()).prepare('DELETE FROM input_files WHERE jobId=?').run(job.id);
          } catch (error) {
            // A cleanup failure cannot undo an already published archive. Keep
            // its durable completion record and report the maintenance issue.
            console.warn('[import:cleanup]', error);
          }
        }
      },
      { signal: controller.signal },
    );
  } catch (error) {
    await progressTail.catch(() => {});
    const current = await readStoredJob(initial.id);
    const message = error instanceof Error ? error.message : String(error);
    await updateJob(initial.id, {
      state: current?.cancelRequested ? 'cancelled' : stopping ? 'interrupted' : 'failed',
      error: current?.archivePublished
        ? `Archive data was saved, but finalization failed: ${message}`
        : message,
      ...(current?.result
        ? { result: { ...current.result, errors: [...current.result.errors, message] } }
        : {}),
      finishedAt: Date.now(),
    });
  } finally {
    clearInterval(cancelTimer);
    activeControllers.delete(initial.id);
  }
};

const pump = async (): Promise<void> => {
  if (stopping) return;
  try {
    await cleanupRemovedImportJobs();
    await withIndexOperation(
      undefined,
      false,
      async () => {
        const db = await getDatabase();
        // Owning the global OS lock proves that any previous running owner is gone.
        // Immutable checksummed inputs are retained; the pipeline revalidates its
        // disk checkpoints rather than trusting a stale percentage.
        for (const row of db
          .prepare("SELECT value FROM jobs WHERE state IN ('running','paused')")
          .all()) {
          const job = JSON.parse(String(row.value)) as StoredJob;
          await updateJob(job.id, {
            state: job.cancelRequested ? 'cancelled' : 'interrupted',
            error:
              'The previous indexing process stopped. Validating its saved inputs before resuming.',
          });
        }
        while (!stopping) {
          const row = db
            .prepare(
              "SELECT value FROM jobs WHERE state IN ('queued','interrupted') ORDER BY createdAt LIMIT 1",
            )
            .get();
          if (!row) break;
          const job = JSON.parse(String(row.value)) as StoredJob;
          if (job.cancelRequested) {
            await updateJob(job.id, { state: 'cancelled', finishedAt: Date.now() });
            continue;
          }
          if (job.attempts >= 3) {
            await updateJob(job.id, {
              state: 'failed',
              error:
                'This import was interrupted repeatedly. Review its error and retry explicitly.',
              finishedAt: Date.now(),
            });
            continue;
          }
          await runJob(job);
        }
      },
      { timeoutMs: 0 },
    );
  } catch (error) {
    if (!(error instanceof IndexingBusyError)) console.warn('[import:jobs]', error);
  }
};

export const kickImportJobs = (): void => {
  if (pumping || stopping) return;
  pumping = pump().finally(() => {
    pumping = undefined;
  });
};

export const startImportJobs = (): (() => Promise<void>) => {
  stopping = false;
  if (!runnerTimer) {
    runnerTimer = setInterval(kickImportJobs, 1000);
    runnerTimer.unref();
  }
  kickImportJobs();
  return async () => {
    stopping = true;
    if (runnerTimer) clearInterval(runnerTimer);
    runnerTimer = undefined;
    for (const controller of activeControllers.values())
      controller.abort(new Error('Server is stopping; import can be resumed.'));
    await pumping;
  };
};

export const cancelImportJob = async (id: string): Promise<ImportJob | null> => {
  const current = await readStoredJob(id);
  if (!current) return null;
  if (terminal.has(current.state)) return publicJob(current);
  const job = await updateJob(id, (latest) =>
    terminal.has(latest.state)
      ? {}
      : {
          cancelRequested: true,
          ...(['queued', 'interrupted'].includes(latest.state)
            ? { state: 'cancelled' as const, finishedAt: Date.now() }
            : {}),
        },
  );
  if (job.cancelRequested)
    activeControllers.get(id)?.abort(new Error('Import cancelled by the user.'));
  return publicJob(job);
};

const collectionJobBlockReason = async (
  collection: string,
  sourceDirectory?: string,
): Promise<'active' | 'retry-input' | undefined> => {
  const canonical = async (path: string): Promise<string> =>
    realpath(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return resolve(path);
      throw error;
    });
  const db = await getDatabase();
  if (
    db
      .prepare(
        "SELECT 1 FROM jobs WHERE collection=? AND state IN ('queued','running','paused','interrupted') LIMIT 1",
      )
      .get(collection)
  )
    return 'active';
  const target = sourceDirectory ? await canonical(sourceDirectory) : undefined;
  const pending =
    db.prepare(`SELECT state,json_extract(value,'$.sourceRoot') AS sourceRoot FROM jobs
    WHERE ${target ? '' : 'collection=? AND'} state IN ('queued','running','paused','interrupted','failed','cancelled')
      AND COALESCE(json_extract(value,'$.inputReady'),0)=0`);
  for (const row of pending.iterate(...(target ? [] : [collection]))) {
    const reason = terminal.has(String(row.state) as ImportJobState) ? 'retry-input' : 'active';
    if (!target) return 'retry-input';
    const sourceRoot = String(row.sourceRoot || '');
    if (!sourceRoot) return reason;
    const source = await canonical(sourceRoot);
    if (containsDirectory(source, target) || containsDirectory(target, source)) return reason;
  }
  return undefined;
};

/** Advisory display check; mutations must use the serialized guard below. */
export const hasBlockingCollectionJobs = async (
  collection: string,
  sourceDirectory?: string,
): Promise<boolean> => (await collectionJobBlockReason(collection, sourceDirectory)) !== undefined;

/** Serialize source maintenance with acceptance, claiming and retrying jobs. */
export const withInactiveCollectionJobs = <T>(
  collection: string,
  fn: () => Promise<T>,
  sourceDirectory?: string,
): Promise<T> =>
  withInputMaintenance(() =>
    withCollectionJobLifecycle(collection, async () => {
      const reason = await collectionJobBlockReason(collection, sourceDirectory);
      if (reason === 'active') throw new CollectionBusyError(collection);
      if (reason === 'retry-input')
        throw Object.assign(
          new Error(
            'Finished import history still needs these source files for retry. Remove that history entry before deleting uploaded files.',
          ),
          { status: 409, code: 'COLLECTION_BUSY', collection },
        );
      return fn();
    }),
  );

/** A deleted/cleared collection cannot be recreated by an already queued job. */
export const withCollectionJobDeletion = <T>(
  collection: string,
  fn: () => Promise<T>,
): Promise<T> =>
  withCollectionJobLifecycle(collection, async () => {
    const db = await getDatabase();
    const active = db
      .prepare(
        "SELECT 1 FROM jobs WHERE collection=? AND state IN ('running','paused','interrupted') LIMIT 1",
      )
      .get(collection);
    if (active) throw new CollectionBusyError(collection);
    return withExclusiveCollectionMutation(collection, async () => {
      for (const row of db
        .prepare("SELECT id FROM jobs WHERE collection=? AND state='queued'")
        .all(collection)) {
        await updateJob(String(row.id), {
          state: 'cancelled',
          cancelRequested: true,
          finishedAt: Date.now(),
          error: 'Import cancelled because its collection was deleted or cleared.',
        });
      }
      return fn();
    });
  });

export const retryImportJob = async (id: string): Promise<ImportJob | null> => {
  const current = await readStoredJob(id);
  if (!current) return null;
  if (!['failed', 'cancelled', 'interrupted'].includes(current.state))
    throw new Error('Only a failed, cancelled or interrupted import can be retried');
  const job = await withInputMaintenance(() =>
    withCollectionJobLifecycle(current.collection, () =>
      updateJob(id, (latest) => {
        if (!['failed', 'cancelled', 'interrupted'].includes(latest.state))
          throw new Error('Only a failed, cancelled or interrupted import can be retried');
        return {
          state: 'queued',
          cancelRequested: false,
          error: undefined,
          result: undefined,
          attempts: 0,
          archivePublished: false,
          startedAt: undefined,
          finishedAt: undefined,
          progress: undefined,
        };
      }),
    ),
  );
  kickImportJobs();
  return publicJob(job);
};

export const waitForImportJob = async (
  id: string,
  options: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (job: ImportJob) => void;
  } = {},
): Promise<ImportJob> => {
  let updatedAt = -1;
  while (true) {
    options.signal?.throwIfAborted();
    const job = await getImportJob(id);
    if (!job) throw new Error('Import job not found');
    if (job.updatedAt !== updatedAt) {
      options.onProgress?.(job);
      updatedAt = job.updatedAt;
    }
    if (terminal.has(job.state)) return job;
    kickImportJobs();
    await delay(250, undefined, { signal: options.signal });
  }
};
