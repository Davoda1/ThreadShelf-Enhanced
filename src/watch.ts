import { watch, type FSWatcher } from 'fs';
import { stat } from 'fs/promises';
import { basename, join, resolve } from 'path';
import { isExportFileName, type IngestResult } from './ingest.js';
import { createFolderImportJob, waitForImportJob, cancelImportJob } from './import-jobs.js';

// Watch-folder mode: keep a collection indexed as export files change (LM
// Studio rewrites its conversation files as you chat; AI Studio folders grow).
// Deletions are deliberately ignored — ThreadShelf is an archive, and stored
// chunks/threads are designed to outlive their source files.

export interface ChangeBatcher {
  readonly add: (path: string) => void;
  readonly settle: () => Promise<void>;
  readonly close: () => void;
}

export interface ChangeBatcherOptions {
  readonly debounceMs: number;
  readonly onFlush: (paths: string[]) => Promise<void>;
}

// Collects change events and flushes a deduplicated batch once the folder has
// been quiet for debounceMs. Flushes never overlap: changes arriving while a
// flush runs queue up for the next one.
export const createChangeBatcher = ({
  debounceMs,
  onFlush,
}: ChangeBatcherOptions): ChangeBatcher => {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> = Promise.resolve();

  const flush = (): void => {
    timer = null;
    const batch = [...pending];
    pending.clear();
    if (!batch.length) return;
    running = running.then(() => onFlush(batch)).catch(() => {});
  };

  return {
    add(path: string) {
      pending.add(path);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    async settle() {
      if (timer) {
        clearTimeout(timer);
        flush();
      }
      await running;
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
};

export interface WatchFolderOptions {
  readonly debounceMs?: number;
  // Injectable for tests; defaults to the real per-file ingest pipeline.
  readonly ingest?: (files: string[]) => Promise<IngestResult>;
  readonly onBatch?: (files: string[], result: IngestResult | null, error?: Error) => void;
}

export interface FolderWatcher {
  readonly close: () => Promise<void>;
}

export const watchFolder = (
  collection: string,
  folderPath: string,
  opts: WatchFolderOptions = {},
): FolderWatcher => {
  const resolved = resolve(folderPath);
  let currentJobId: string | undefined;
  let closing = false;
  const runIngest =
    opts.ingest ??
    (async (files: string[]) => {
      const accepted = await createFolderImportJob({ collection, folderPath: resolved, files });
      currentJobId = accepted.id;
      if (closing) await cancelImportJob(accepted.id);
      try {
        const job = await waitForImportJob(accepted.id);
        if (!job.result) throw new Error(job.error || `Import ${job.state}`);
        return job.result;
      } finally {
        currentJobId = undefined;
      }
    });

  const batcher = createChangeBatcher({
    debounceMs: opts.debounceMs ?? 2000,
    onFlush: async (paths) => {
      const files: string[] = [];
      for (const path of paths) {
        try {
          const info = await stat(path);
          if (info.isFile()) files.push(path);
        } catch {
          // Deleted or unreadable between event and flush — keep the index as-is.
        }
      }
      if (!files.length) return;
      try {
        const result = await runIngest(files);
        opts.onBatch?.(files, result);
      } catch (e) {
        opts.onBatch?.(files, null, e as Error);
      }
    },
  });

  const watcher: FSWatcher = watch(resolved, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (!isExportFileName(basename(filename))) return;
    batcher.add(join(resolved, filename));
  });

  return {
    close: async () => {
      closing = true;
      watcher.close();
      if (currentJobId) await cancelImportJob(currentJobId);
      await batcher.settle();
    },
  };
};
