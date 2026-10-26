#!/usr/bin/env tsx
import { stat } from 'fs/promises';
import { basename, resolve } from 'path';
import {
  createFolderImportJob,
  waitForImportJob,
  cancelImportJob,
  startImportJobs,
} from './import-jobs.js';
import { invocation } from './paths.js';
import { watchFolder } from './watch.js';
import { normalizeCollectionName } from './validation.js';
import { recoverPendingIndexes, startIndexRecovery } from './store.js';

const args = process.argv.slice(2);
const clearFirst = args.includes('--clear');
const watchMode = args.includes('--watch');

const readNumberFlag = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} expects a non-negative number of milliseconds`);
    process.exit(1);
  }
  return value;
};

const debounceMs = readNumberFlag('--debounce', 2000);

const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === undefined || arg === '--' || arg === '--clear' || arg === '--watch') continue;
  if (arg === '--debounce') {
    i++;
    continue;
  }
  positional.push(arg);
}

const folder = positional[0];
const collectionArg = positional[1] ?? 'chunks';

if (!folder || positional.length > 2) {
  console.error(
    `Usage: ${invocation('ingest')} <folder> [collection] -- [--clear] [--watch] [--debounce <ms>]`,
  );
  process.exit(1);
}

let collection: string;
try {
  collection = normalizeCollectionName(collectionArg);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const startedAt = Date.now();
const resolvedFolder = resolve(folder);
let lastLoggedFile = '';
let lastPhase = '';
let currentJobId: string | undefined;
let interrupted = false;
const stopJobs = startImportJobs();
const interruptImport = () => {
  interrupted = true;
  if (currentJobId) void cancelImportJob(currentJobId);
};
process.on('SIGINT', interruptImport);
process.on('SIGTERM', interruptImport);

try {
  const accepted = await createFolderImportJob({
    collection,
    folderPath: resolvedFolder,
    clearFirst,
  });
  currentJobId = accepted.id;
  if (interrupted) await cancelImportJob(accepted.id);
  console.error(`[ingest] job=${accepted.id} collection=${collection} folder=${resolvedFolder}`);
  const job = await waitForImportJob(accepted.id, {
    onProgress: (current) => {
      const event = current.progress;
      if (!event) return;
      const fileLabel = event.currentFile ? basename(event.currentFile) : '';
      if (fileLabel && fileLabel !== lastLoggedFile) {
        lastLoggedFile = fileLabel;
        console.error(`[ingest] ${event.processedFiles}/${event.totalFiles} ${fileLabel}`);
      }
      if (event.phase && event.phase !== lastPhase) {
        lastPhase = event.phase;
        console.error(`[ingest] ${event.phase}`);
      }
    },
  });
  currentJobId = undefined;
  if (job.state === 'cancelled') {
    console.error('[ingest] cancelled; completed data remains protected.');
    await stopJobs();
    process.exit(0);
  }
  if (!job.result) throw new Error(job.error || `Import ${job.state}`);
  const result = job.result;
  await recoverPendingIndexes({ collection });

  console.error(
    `[ingest] done files=${result.files.length} chunks=${result.ingested} errors=${result.errors.length} elapsedMs=${Date.now() - startedAt}`,
  );
  console.log(JSON.stringify({ collection, ...result }, null, 2));

  if (!watchMode || interrupted) {
    await stopJobs();
    process.exit(result.errors.length > 0 ? 2 : 0);
  }

  // fs.watch does not reliably reject a missing folder (recursive watching on
  // Linux under Node 24 returns quietly), so check before watching.
  if (!(await stat(resolvedFolder).catch(() => null))?.isDirectory()) {
    throw new Error(`cannot watch ${resolvedFolder}: not a folder`);
  }

  const stopRecovery = startIndexRecovery();
  const watcher = watchFolder(collection, resolvedFolder, {
    debounceMs,
    onBatch: (files, batchResult, error) => {
      if (error) {
        console.error(`[watch] re-index failed: ${error.message}`);
        return;
      }
      const names = files.map((file) => basename(file)).join(', ');
      console.error(
        `[watch] re-indexed ${files.length} file(s) (${names}) chunks=${batchResult?.ingested ?? 0} errors=${batchResult?.errors.length ?? 0}`,
      );
    },
  });

  console.error(`[watch] watching ${resolvedFolder} (debounce ${debounceMs}ms) — Ctrl+C to stop`);

  const shutdown = async () => {
    stopRecovery();
    console.error('[watch] stopping…');
    await watcher.close();
    await stopJobs();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (e) {
  await stopJobs();
  console.error(`[ingest] failed: ${(e as Error).message}`);
  process.exit(1);
}
