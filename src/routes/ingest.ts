import { Router } from 'express';
import multer from 'multer';
import { join, basename, normalize, resolve, relative, isAbsolute } from 'path';
import { chmodSync, mkdirSync } from 'fs';
import { rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { uploadsPath } from '../paths.js';
import { listExportFiles } from '../ingest.js';
import {
  createFolderImportJob,
  createUploadedImportJob,
  listImportJobs,
  getImportJob,
  cancelImportJob,
  retryImportJob,
  waitForImportJob,
  deleteImportJob,
  clearFinishedImportJobs,
} from '../import-jobs.js';
import { listSourceFilesInCollection } from '../store.js';
import {
  ValidationError,
  normalizeCollectionName,
  normalizeCollectionSelector,
  normalizeBoolean,
} from '../validation.js';

const router = Router();

const UPLOADS_DIR = uploadsPath();
const INCOMING_DIR = join(UPLOADS_DIR, '.incoming');
// Disk-backed uploads remain bounded; large local archives can also be indexed by folder path.
const MAX_UPLOAD_SIZE = 4 * 1024 ** 3; // 4 GiB per file
const MAX_UPLOAD_FILES = 1000;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      try {
        mkdirSync(INCOMING_DIR, { recursive: true, mode: 0o700 });
        chmodSync(INCOMING_DIR, 0o700);
        callback(null, INCOMING_DIR);
      } catch (error) {
        callback(error as Error, '');
      }
    },
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  }),
  limits: {
    fileSize: MAX_UPLOAD_SIZE,
    files: MAX_UPLOAD_FILES,
    fields: 10,
    parts: MAX_UPLOAD_FILES + 10,
    fieldNameSize: 4096,
  },
});

const tryNormalizeCollectionName = (value: unknown): string => {
  try {
    return normalizeCollectionName(value);
  } catch {
    return '';
  }
};

const safeUploadRelativePath = (rawPath: string): string | null => {
  const normalized = normalize(String(rawPath || '').replace(/\\/g, '/'));
  if (!normalized || isAbsolute(normalized) || normalized.startsWith('..')) return null;
  return normalized;
};

const isInsideDirectory = (parentDir: string, childPath: string): boolean => {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

const getUploadedFiles = (files: unknown): Express.Multer.File[] => {
  return Array.isArray(files) ? (files as Express.Multer.File[]) : [];
};

const cleanupUploadedTemps = async (files: readonly Express.Multer.File[]): Promise<void> => {
  await Promise.all(
    files.map((file) => (file.path ? rm(file.path, { force: true }) : Promise.resolve())),
  );
};

const getUploadTarget = (
  files: readonly Express.Multer.File[],
  requestedCollection: string,
): {
  collectionName: string;
  targetDir: string;
} => {
  const firstPath = (files[0]?.fieldname ?? '').replace(/\\/g, '/');
  const topDir = firstPath.split('/').filter(Boolean)[0];
  const collectionName =
    requestedCollection || tryNormalizeCollectionName(topDir || 'upload') || 'upload';

  return {
    collectionName,
    targetDir: join(UPLOADS_DIR, collectionName),
  };
};

const uploadRelativePath = (fieldname: string): { rel: string; relativePath: string | null } => {
  const rel = fieldname.replace(/\\/g, '/');
  const parts = rel.split('/').filter(Boolean);
  const pathInsideFolder = parts.length > 1 ? join(...parts.slice(1)) : parts[0];

  return {
    rel,
    relativePath: safeUploadRelativePath(pathInsideFolder ?? ''),
  };
};

const writeEvent = (res: import('express').Response, payload: unknown): void => {
  if (res.destroyed || res.writableEnded) return;
  res.write(`${JSON.stringify(payload)}\n`);
};

const canonicalSourcePath = (filePath: string): string => {
  const canonical = resolve(filePath).replace(/\\/g, '/');
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};

router.get('/api/ingest-preview', async (req, res) => {
  const folderPath = req.query.folderPath;
  let collection: string;
  try {
    collection = normalizeCollectionSelector(req.query.collection);
  } catch (e) {
    if (e instanceof ValidationError) {
      return res.status(400).json({ error: e.message, field: e.field });
    }
    throw e;
  }

  if (!folderPath || typeof folderPath !== 'string' || folderPath.trim().length === 0) {
    return res.status(400).json({ error: 'Missing folderPath' });
  }
  if ((folderPath as string).length > 4096) {
    return res.status(400).json({ error: 'folderPath too long' });
  }

  try {
    const files = await listExportFiles(folderPath as string);
    const existingFiles = collection === 'all' ? [] : await listSourceFilesInCollection(collection);
    const existingPaths = new Set(existingFiles.map(canonicalSourcePath));
    const duplicates = files
      .map((filePath) => ({
        sourceFile: filePath,
        name: basename(filePath),
        canonicalPath: canonicalSourcePath(filePath),
      }))
      .filter((file) => existingPaths.has(file.canonicalPath));

    res.json({ collection, files, duplicates });
  } catch (e) {
    console.error('[/api/ingest-preview]', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

const jobFailure = (job: import('../import-jobs.js').ImportJob): Error =>
  new Error(job.error || `Import ${job.state}`);

const readFolderRequest = (body: Record<string, unknown> | undefined) => {
  // Preserve the legacy route's validation order when multiple fields are
  // invalid: option errors are reported before checking the source path.
  const clearFirst = normalizeBoolean(body?.clearFirst, { field: 'clearFirst' });
  const folderPath = body?.folderPath;
  if (
    typeof folderPath !== 'string' ||
    !folderPath.trim() ||
    folderPath.length > 4096 ||
    folderPath.includes('\0')
  ) {
    throw new ValidationError('Invalid folderPath', { field: 'folderPath' });
  }
  return {
    folderPath,
    collection:
      tryNormalizeCollectionName(body?.collection) ||
      tryNormalizeCollectionName(basename(folderPath)) ||
      'chunks',
    clearFirst,
  };
};

const acceptUpload = async (req: import('express').Request) => {
  const files = getUploadedFiles(req.files);
  try {
    const clearFirst = normalizeBoolean(req.body?.clearFirst, { field: 'clearFirst' });
    if (!files.length)
      throw new ValidationError(
        'No files uploaded. Choose JSON, HTML or ZIP exports, or an export folder.',
        { field: 'files' },
      );
    const { collectionName, targetDir } = getUploadTarget(
      files,
      tryNormalizeCollectionName(req.body?.collectionName),
    );
    const inputs = files.map((file) => {
      const { relativePath, rel } = uploadRelativePath(file.fieldname);
      if (!relativePath || !isInsideDirectory(targetDir, join(targetDir, relativePath))) {
        throw new ValidationError(`Unsafe upload path: ${rel}`, { field: 'files' });
      }
      return { path: file.path, relativePath };
    });
    return await createUploadedImportJob({
      collection: collectionName,
      sourceRoot: targetDir,
      clearFirst,
      files: inputs,
    });
  } finally {
    await cleanupUploadedTemps(files);
  }
};

const sendRequestError = (res: import('express').Response, error: unknown) => {
  if (res.destroyed || res.writableEnded) return;
  if (error instanceof ValidationError)
    return res.status(400).json({ error: error.message, field: error.field });
  const status = (error as { status?: number })?.status ?? 500;
  return res
    .status(status)
    .json({ status: 'error', error: error instanceof Error ? error.message : String(error) });
};

/** The connection observes a durable job. Closing it never cancels processing. */
const streamJob = async (
  req: import('express').Request,
  res: import('express').Response,
  accepted: import('../import-jobs.js').ImportJob,
) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  writeEvent(res, {
    status: 'accepted',
    jobId: accepted.id,
    collectionName: accepted.collection,
    safeToClose: true,
  });
  const observer = new AbortController();
  const detach = () => observer.abort();
  req.once('aborted', detach);
  res.once('close', detach);
  try {
    const job = await waitForImportJob(accepted.id, {
      signal: observer.signal,
      onProgress: (current) =>
        writeEvent(res, {
          ...(current.progress ?? {
            status: 'starting',
            phase: current.state,
            totalFiles: 0,
            processedFiles: 0,
            totalChunks: 0,
            totalTokens: 0,
            elapsedMs: 0,
          }),
          jobId: current.id,
          jobState: current.state,
          safeToClose: true,
        }),
    });
    if (job.result)
      writeEvent(res, {
        status: 'completed',
        result: job.result,
        collectionName: job.collection,
        jobId: job.id,
        jobState: job.state,
      });
    else
      writeEvent(res, {
        status: 'error',
        error: jobFailure(job).message,
        jobId: job.id,
        jobState: job.state,
      });
  } catch (error) {
    if (!observer.signal.aborted)
      writeEvent(res, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        jobId: accepted.id,
      });
  } finally {
    req.off('aborted', detach);
    res.off('close', detach);
    if (!res.destroyed) res.end();
  }
};

router.get('/api/import-jobs', async (req, res) => {
  const collection = req.query.collection;
  if (collection !== undefined && typeof collection !== 'string')
    return res.status(400).json({ error: 'Invalid collection' });
  res.json({
    jobs: await listImportJobs(collection && collection !== 'all' ? collection : undefined),
  });
});

router.get('/api/import-jobs/:id', async (req, res) => {
  const job = await getImportJob(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  res.json(job);
});

router.delete('/api/import-jobs', async (req, res) => {
  try {
    if (
      Object.keys(req.query).some((key) => key !== 'collection') ||
      (req.query.collection !== undefined && typeof req.query.collection !== 'string')
    )
      throw new ValidationError('Invalid collection', { field: 'collection' });
    const collection = normalizeCollectionSelector(req.query.collection, { defaultValue: 'all' });
    res.json({
      deleted: await clearFinishedImportJobs(collection === 'all' ? undefined : collection),
    });
  } catch (error) {
    sendRequestError(res, error);
  }
});

router.delete('/api/import-jobs/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!(await deleteImportJob(id)))
      return res.status(404).json({ error: 'Import job not found' });
    res.json({ deleted: true, id });
  } catch (error) {
    sendRequestError(res, error);
  }
});

router.post('/api/import-jobs/:id/cancel', async (req, res) => {
  const job = await cancelImportJob(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  res.json({ job });
});

router.post('/api/import-jobs/:id/retry', async (req, res) => {
  try {
    const job = await retryImportJob(String(req.params.id));
    if (!job) return res.status(404).json({ error: 'Import job not found' });
    res.status(202).json({ job });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/api/import-jobs', async (req, res) => {
  try {
    res.status(202).json({ job: await createFolderImportJob(readFolderRequest(req.body)) });
  } catch (error) {
    sendRequestError(res, error);
  }
});

router.post('/api/import-jobs/upload', upload.any(), async (req, res) => {
  try {
    res.status(202).json({ job: await acceptUpload(req) });
  } catch (error) {
    sendRequestError(res, error);
  }
});

// Existing Local apps keep the same result and NDJSON contracts.
router.post('/api/ingest-upload', upload.any(), async (req, res) => {
  try {
    const accepted = await acceptUpload(req);
    const job = await waitForImportJob(accepted.id);
    if (!job.result) throw jobFailure(job);
    if (!res.destroyed)
      res.json({
        status: 'completed',
        result: job.result,
        collectionName: job.collection,
        jobId: job.id,
      });
  } catch (error) {
    sendRequestError(res, error);
  }
});

router.post('/api/ingest-upload-progress', upload.any(), async (req, res) => {
  try {
    await streamJob(req, res, await acceptUpload(req));
  } catch (error) {
    sendRequestError(res, error);
  }
});

router.post('/api/ingest-progress', async (req, res) => {
  try {
    await streamJob(req, res, await createFolderImportJob(readFolderRequest(req.body)));
  } catch (error) {
    sendRequestError(res, error);
  }
});

export default router;
