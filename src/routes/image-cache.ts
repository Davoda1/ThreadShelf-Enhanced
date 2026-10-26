import { Router } from 'express';
import { clearImageCache, configureImageCache, getImageResource, imageCacheStats, ImageRequestError } from '../image-cache.js';
import { ValidationError } from '../validation.js';

const router = Router();
router.get('/api/image-cache', (_req, res) => res.json(imageCacheStats()));
router.put('/api/image-cache', async (req, res, next) => {
  try { res.json(await configureImageCache({ enabled: req.body?.enabled, maxBytes: req.body?.maxBytes })); } catch (error) { next(error); }
});
router.delete('/api/image-cache', async (req, res, next) => {
  try {
    if (req.query.collection !== undefined && typeof req.query.collection !== 'string') throw new ImageRequestError('Invalid collection', 400);
    res.json(await clearImageCache(req.query.collection as string | undefined));
  } catch (error) { next(error); }
});
router.get('/api/image-cache/resource', async (req, res, next) => {
  try {
    if (typeof req.query.url !== 'string' || (req.query.collection !== undefined && typeof req.query.collection !== 'string')) throw new ImageRequestError('Invalid image request', 400);
    const image = await getImageResource(req.query.url, req.query.collection as string | undefined);
    res.set({ 'Content-Type': image.mime, 'Content-Length': String(image.bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(image.bytes);
  } catch (error) { next(error); }
});
router.use((error: Error, _req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
  if (error instanceof ImageRequestError || error instanceof ValidationError) return res.status(error instanceof ImageRequestError ? error.status : 400).json({ error: error.message });
  next(error);
});
export default router;
