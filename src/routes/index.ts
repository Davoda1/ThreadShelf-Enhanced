import { Router } from 'express';
import healthRouter from './health.js';
import collectionsRouter from './collections.js';
import filesRouter from './files.js';
import searchRouter from './search.js';
import readerSearchRouter from './reader-search.js';
import threadRouter from './thread.js';
import ingestRouter from './ingest.js';
import insightsRouter from './insights.js';
import generationRouter from './generation.js';
import modelCatalogRouter from './model-catalog.js';
import imageCacheRouter from './image-cache.js';
import uploadsRouter from './uploads.js';

const router = Router();

router.use(healthRouter);
router.use(collectionsRouter);
router.use(filesRouter);
router.use(searchRouter);
router.use(readerSearchRouter);
router.use(threadRouter);
router.use(ingestRouter);
router.use(insightsRouter);
router.use(generationRouter);
router.use(modelCatalogRouter);
router.use(imageCacheRouter);
router.use(uploadsRouter);

export default router;
