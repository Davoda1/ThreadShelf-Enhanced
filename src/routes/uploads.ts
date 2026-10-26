import { Router } from 'express';
import {
  deleteUploadedFiles,
  listUploadCollections,
  listUploadedFiles,
  UploadStorageError,
} from '../upload-storage.js';
import { ValidationError } from '../validation.js';

const router = Router();
router.use('/api/uploads', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.get('/api/uploads', async (_req, res, next) => {
  try {
    res.json({ collections: await listUploadCollections() });
  } catch (error) {
    next(error);
  }
});
router.get('/api/uploads/:collection', async (req, res, next) => {
  try {
    res.json(await listUploadedFiles(req.params.collection, req.query));
  } catch (error) {
    next(error);
  }
});
router.delete('/api/uploads/:collection', async (req, res, next) => {
  try {
    res.json(await deleteUploadedFiles(req.params.collection, req.body));
  } catch (error) {
    next(error);
  }
});
router.use(
  '/api/uploads',
  (
    error: Error,
    _req: import('express').Request,
    res: import('express').Response,
    _next: import('express').NextFunction,
  ) => {
    if (error instanceof UploadStorageError || error instanceof ValidationError)
      return res
        .status(error instanceof UploadStorageError ? error.status : 400)
        .json({ error: error.message });
    const busy = error as Error & { status?: number; code?: string };
    if (busy.status === 409 && ['COLLECTION_BUSY', 'INDEXING_BUSY'].includes(busy.code || ''))
      return res.status(409).json({ error: busy.message, code: busy.code });
    // Filesystem errors include absolute local paths; keep those out of API responses.
    return res.status(500).json({ error: 'Uploaded source storage is unavailable' });
  },
);
export default router;
