import { readdir } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { iterateEnhancedFile, type EnhancedImportNotice } from './enhanced-import/index.js';
import { groupNativeBackupFiles } from './enhanced-import/venice-groups.js';
import { replaceImportedStream } from './store.js';
import { withIndexOperation } from './indexing-coordinator.js';
import { memoryCheckpoint, type MemoryStatus } from './memory-governor.js';
import {
  createImportStage,
  createSpoolWriter,
  inputFingerprint,
  readCheckpoint,
  readImportSpool,
  spoolPath,
  type ImportCheckpoint,
  type ImportSpoolRecord,
} from './enhanced-import/spool.js';

interface DirEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly fullPath: string;
}

const SKIP_FILES = new Set(
  [
    'users.json',
    'projects.json',
    'user.json',
    'message_feedback.json',
    'shared_conversations.json',
    'sora.json',
    'applet_access_history.json',
  ].map((n) => n.toLowerCase()),
);

// Name-level filter shared with watch mode (which only has a path, no dirent).
export const isExportFileName = (name: string): boolean => {
  const lowerName = name.toLowerCase();
  if (SKIP_FILES.has(lowerName)) return false;
  if (!/\.(?:json|html?|zip)$/.test(lowerName) && /^file[-_]/.test(lowerName)) return false;
  return /\.(?:json|html?|zip)$/.test(lowerName) || !name.includes('.');
};

const isPotentialExportFile = (entry: { name: string; isFile: () => boolean }): boolean => {
  return entry.isFile() && isExportFileName(entry.name);
};

const getCanonicalExportKey = (fileName: string): string => {
  const lower = fileName.replace(/\\/g, '/').toLowerCase();
  return lower.endsWith('.json') ? lower.slice(0, -5) : lower;
};

const collectExportEntries = async (
  folderPath: string,
  signal?: AbortSignal,
  skipped?: EnhancedImportNotice[],
): Promise<DirEntry[]> => {
  const entries: DirEntry[] = [];

  const walk = async (currentDir: string, depth = 0): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > 64) throw new Error('Folder nesting exceeds import depth limit.');
    const dirEntries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (isPotentialExportFile(entry)) {
        if (entries.length >= 100000) throw new Error('Too many export files in selected folder.');
        entries.push({
          name: entry.name,
          relativePath: relative(folderPath, fullPath),
          fullPath,
        });
      } else if (entry.isFile() && skipped && skipped.length < 1000) {
        skipped.push({
          sourceFile: fullPath,
          code: 'unsupported',
          message: 'Unrelated file or account metadata skipped.',
        });
      }
    }
  };

  await walk(folderPath);
  return entries;
};

const chooseExportFiles = (entries: DirEntry[]): string[] => {
  const byKey = new Map<string, DirEntry>();

  for (const entry of entries) {
    const key = getCanonicalExportKey(entry.relativePath || entry.name);
    const existing = byKey.get(key);
    const isJson = entry.name.toLowerCase().endsWith('.json');

    if (!existing || (isJson && !existing.name.toLowerCase().endsWith('.json'))) {
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()].map((entry) => entry.fullPath);
};

export const listExportFiles = async (folderPath: string): Promise<string[]> => {
  const resolved = resolve(folderPath);
  const entries = await collectExportEntries(resolved);
  return chooseExportFiles(entries);
};

export interface ProgressEvent {
  readonly status: string;
  readonly phase?: string;
  readonly progressPercent?: number;
  readonly embeddingDone?: number;
  readonly embeddingTotal?: number;
  readonly totalFiles: number;
  readonly processedFiles: number;
  readonly currentFile?: string;
  readonly totalChunks: number;
  readonly totalTokens: number;
  readonly elapsedMs: number;
  readonly errorsCount?: number;
  readonly providers?: Record<string, number>;
  readonly conversations?: number;
  readonly skippedCount?: number;
  readonly memoryPressure?: MemoryStatus;
}

export interface IngestResult {
  readonly conversations: number;
  readonly ingested: number;
  readonly totalTokens: number;
  readonly files: string[];
  /** Every physical input in committed backup groups, including companion parts. */
  readonly completedSourceFiles?: readonly string[];
  readonly errors: string[];
  readonly skippedFiles?: readonly string[];
  readonly warnings?: readonly EnhancedImportNotice[];
  readonly replacementSkipped?: boolean;
  readonly providers: Record<string, number>;
  readonly elapsedMs: number;
}

export interface IngestOptions {
  readonly clearFirst?: boolean;
  readonly onProgress?: (data: ProgressEvent) => void;
  readonly signal?: AbortSignal;
  /** Immutable job snapshots map back to stable archive identities. */
  readonly sourceRoot?: string;
  readonly sourceFiles?: Readonly<Record<string, string>>;
  /** A durable job owns this directory; completed parse checkpoints can be reused. */
  readonly stagingDirectory?: string;
}

export const ingestFolder = async (
  collection: string,
  folderPath: string,
  opts: IngestOptions = {},
): Promise<IngestResult> =>
  withIndexOperation(
    collection,
    opts.clearFirst === true,
    async () => {
      const resolved = resolve(folderPath);
      opts.signal?.throwIfAborted();
      const skipped: EnhancedImportNotice[] = [];
      let entries: DirEntry[];
      try {
        entries = await collectExportEntries(resolved, opts.signal, skipped);
      } catch (error) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (
          ['MEMORY_PRESSURE', 'ENOSPC', 'EDQUOT'].includes(
            String((error as NodeJS.ErrnoException).code),
          )
        )
          throw error;
        return {
          conversations: 0,
          ingested: 0,
          totalTokens: 0,
          files: [],
          errors: [`Folder error: ${(error as Error).message}`],
          providers: {},
          elapsedMs: 0,
          ...(opts.clearFirst ? { replacementSkipped: true } : {}),
        };
      }
      const sourceFiles = { ...opts.sourceFiles };
      if (opts.sourceRoot) {
        for (const entry of entries)
          sourceFiles[entry.fullPath] = resolve(opts.sourceRoot, entry.relativePath);
        for (let index = 0; index < skipped.length; index++) {
          const notice = skipped[index]!;
          skipped[index] = {
            ...notice,
            sourceFile: resolve(opts.sourceRoot, relative(resolved, notice.sourceFile)),
          };
        }
      }
      return ingestFilesInternal(
        collection,
        chooseExportFiles(entries),
        { ...opts, sourceFiles },
        opts.clearFirst === true,
        skipped,
      );
    },
    { signal: opts.signal },
  );

// Watch mode replaces only the named sources; clearing belongs to whole folders.
export const ingestFiles = async (
  collection: string,
  files: readonly string[],
  opts: IngestOptions = {},
): Promise<IngestResult> =>
  withIndexOperation(collection, false, () => ingestFilesInternal(collection, files, opts, false), {
    signal: opts.signal,
  });

const ingestFilesInternal = async (
  collection: string,
  files: readonly string[],
  opts: IngestOptions,
  clearFirst: boolean,
  initialWarnings: readonly EnhancedImportNotice[] = [],
): Promise<IngestResult> => {
  const { onProgress = () => {} } = opts;
  opts.signal?.throwIfAborted();
  const errors: string[] = [];
  const warnings: EnhancedImportNotice[] = [...initialWarnings];
  const skippedFiles = new Set(initialWarnings.map((warning) => warning.sourceFile));
  const totalFiles = files.length;
  let processedFiles = 0,
    totalChunks = 0,
    totalTokens = 0,
    totalConversations = 0;
  const ingestedFiles: string[] = [];
  const completedSourceFiles: string[] = [];
  const providers: Record<string, number> = {};
  const startTime = Date.now();
  const logicalPath = (path: string): string => opts.sourceFiles?.[resolve(path)] ?? resolve(path);
  const progress = (extra: Partial<ProgressEvent> = {}) =>
    onProgress({
      status: 'progress',
      totalFiles,
      processedFiles,
      totalChunks,
      totalTokens,
      elapsedMs: Date.now() - startTime,
      errorsCount: errors.length,
      providers,
      conversations: totalConversations,
      skippedCount: skippedFiles.size,
      ...extra,
    });
  let previousPressure: MemoryStatus['pressure'] | undefined;
  const reportMemoryPressure = (memoryPressure: MemoryStatus): void => {
    if (previousPressure === memoryPressure.pressure) return;
    const wasPaused = previousPressure === 'paused';
    previousPressure = memoryPressure.pressure;
    if (memoryPressure.pressure !== 'normal' || wasPaused)
      progress({
        phase:
          memoryPressure.pressure === 'normal'
            ? 'memory-resumed'
            : `memory-${memoryPressure.pressure}`,
        memoryPressure,
      });
  };
  const checkpointMemory = () =>
    memoryCheckpoint({
      signal: opts.signal,
      onPressure: reportMemoryPressure,
    });
  progress({ status: 'starting' });
  await checkpointMemory();
  const stage = await createImportStage(opts.stagingDirectory);
  const stagedFiles: {
    path: string;
    checkpoint: ImportCheckpoint;
    sourceFiles: readonly string[];
  }[] = [];
  let published = false;
  const report = (notice: EnhancedImportNotice) => {
    if (warnings.length < 1000) warnings.push(notice);
    if (notice.code === 'unsupported' || notice.code === 'empty')
      skippedFiles.add(notice.sourceFile);
  };
  const readStage = async function* (
    selected: typeof stagedFiles,
  ): AsyncGenerator<ImportSpoolRecord> {
    for (const entry of selected) yield* readImportSpool(entry.path, opts.signal);
  };
  const publish = async (selected: typeof stagedFiles, clear: boolean) => {
    const previousTokens = totalTokens;
    const chunks = await replaceImportedStream(collection, readStage(selected), {
      clearFirst: clear,
      sourceFiles: selected.map((entry) => entry.checkpoint.sourceFile),
      stagingDirectory: opts.stagingDirectory,
      signal: opts.signal,
      onMemoryPressure: reportMemoryPressure,
      onEmbeddingProgress: (done, total, tokens) => {
        totalTokens = previousTokens + tokens;
        progress({
          phase: 'embedding',
          embeddingDone: done,
          embeddingTotal: total,
          totalChunks: totalChunks + done,
          progressPercent: clear
            ? 20 + (75 * done) / Math.max(total, 1)
            : (95 * (processedFiles + done / Math.max(total, 1))) / Math.max(totalFiles, 1),
        });
      },
    });
    totalChunks += chunks;
    ingestedFiles.push(...selected.map((entry) => entry.checkpoint.sourceFile));
    for (const entry of selected) completedSourceFiles.push(...entry.sourceFiles);
  };
  try {
    const grouped = await groupNativeBackupFiles(files, opts.signal);
    errors.push(...grouped.diagnostics);
    for (const fileGroup of grouped.groups) {
      const filePath = fileGroup[0]!;
      const sourceFile = logicalPath(filePath);
      opts.signal?.throwIfAborted();
      progress({ phase: 'reading', currentFile: sourceFile });
      try {
        const path = spoolPath(stage.directory, sourceFile);
        const sourcePaths = Object.fromEntries(
          fileGroup.map((file) => [resolve(file), logicalPath(file)]),
        );
        const inputHash = stage.persistent
          ? await inputFingerprint(fileGroup, sourcePaths, opts.signal)
          : '';
        let checkpoint = stage.persistent
          ? await readCheckpoint(path, sourceFile, inputHash, opts.signal)
          : undefined;
        if (!checkpoint) {
          const writer = await createSpoolWriter(path, opts.signal);
          const fileProviders = new Set<string>();
          const fileWarnings: EnhancedImportNotice[] = [];
          let count = 0,
            invalid = false;
          try {
            for await (const event of iterateEnhancedFile(filePath, {
              signal: opts.signal,
              companionPaths: fileGroup.slice(1),
              sourcePathMap: sourcePaths,
              checkpoint: checkpointMemory,
              onProgress: (event) =>
                progress({ phase: event.phase, currentFile: event.sourceFile ?? sourceFile }),
            })) {
              opts.signal?.throwIfAborted();
              if (event.type === 'error') {
                errors.push(`${event.notice.sourceFile}: ${event.notice.message}`);
                invalid = true;
              } else if (event.type !== 'conversation') {
                report(event.notice);
                if (fileWarnings.length < 1000) fileWarnings.push(event.notice);
              } else {
                await checkpointMemory();
                await writer.append({
                  sourceFile,
                  provider: event.conversation.provider,
                  conversation: event.conversation,
                });
                fileProviders.add(event.conversation.provider);
                count++;
              }
            }
            if (!invalid && count) {
              checkpoint = await writer.finish({
                sourceFile,
                inputHash,
                count,
                providers: [...fileProviders],
                warnings: fileWarnings,
              });
            } else if (!invalid && !skippedFiles.has(sourceFile)) {
              report({ sourceFile, code: 'empty', message: 'No readable conversation turns.' });
            }
          } finally {
            await writer.discard();
          }
        } else {
          for (const warning of checkpoint.warnings) report(warning);
          progress({ phase: 'checkpoint', currentFile: sourceFile });
        }
        if (checkpoint) {
          totalConversations += checkpoint.count;
          for (const provider of checkpoint.providers)
            providers[provider] = (providers[provider] ?? 0) + 1;
          const entry = { path, checkpoint, sourceFiles: fileGroup.map(logicalPath) };
          if (clearFirst) stagedFiles.push(entry);
          else await publish([entry], false);
        }
      } catch (error) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (
          ['MEMORY_PRESSURE', 'ENOSPC', 'EDQUOT'].includes(
            String((error as NodeJS.ErrnoException).code),
          )
        )
          throw error;
        errors.push(`${sourceFile}: ${(error as Error).message}`);
      }
      processedFiles += fileGroup.length;
      progress({
        phase: clearFirst ? 'reading' : undefined,
        currentFile: sourceFile,
        progressPercent: ((clearFirst ? 20 : 95) * processedFiles) / Math.max(totalFiles, 1),
      });
    }
    const replacementSkipped = clearFirst && (errors.length > 0 || stagedFiles.length === 0);
    if (clearFirst && !replacementSkipped) {
      try {
        await publish(stagedFiles, true);
      } catch (error) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (
          ['MEMORY_PRESSURE', 'ENOSPC', 'EDQUOT'].includes(
            String((error as NodeJS.ErrnoException).code),
          )
        )
          throw error;
        errors.push(`Collection replacement: ${(error as Error).message}`);
      }
    }
    published = errors.length === 0 && !replacementSkipped;
    return {
      conversations: replacementSkipped ? 0 : totalConversations,
      ingested: totalChunks,
      totalTokens,
      files: ingestedFiles,
      completedSourceFiles,
      errors,
      ...(skippedFiles.size ? { skippedFiles: [...skippedFiles] } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(replacementSkipped ? { replacementSkipped: true } : {}),
      providers,
      elapsedMs: Date.now() - startTime,
    };
  } finally {
    await stage.dispose(published);
  }
};
