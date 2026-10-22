import { Router } from 'express';
import { dropCollection } from '../store.js';
import {
  getAllCollections,
  addManualCollection,
  ensureCollectionExists,
  deleteCollectionFull,
} from '../services/collections.js';
import { getStatsForCollection } from '../services/stats.js';
import {
  ValidationError,
  normalizeCollectionName,
  normalizeCollectionSelector,
  assertDeletableCollection,
  assertClearableCollection,
} from '../validation.js';

const router = Router();

const sendValidationError = (res: import('express').Response, err: ValidationError): void => {
  res.status(400).json({ error: err.message, field: err.field });
};

router.get('/api/collections', async (_req, res) => {
  try {
    const collections = await getAllCollections();
    res.json({ collections });
  } catch (e) {
    console.error('[/api/collections]', e);
    res.status(500).json({ collections: ['chunks'] });
  }
});

router.post('/api/collections', async (req, res) => {
  let name: string;
  try {
    name = normalizeCollectionName(req.body?.name, { field: 'name' });
  } catch (e) {
    if (e instanceof ValidationError) return sendValidationError(res, e);
    throw e;
  }

  try {
    await addManualCollection(name);
    res.json({ ok: true, collection: name });
  } catch (e) {
    console.error('[/api/collections POST]', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post('/api/collections/:name/clear', async (req, res) => {
  let name: string;
  try {
    name = assertClearableCollection(req.params.name);
  } catch (e) {
    if (e instanceof ValidationError) return sendValidationError(res, e);
    throw e;
  }

  try {
    await dropCollection(name);
    await ensureCollectionExists(name);
    res.json({ ok: true, collection: name });
  } catch (e) {
    console.error('[/api/collections/:name/clear]', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

router.delete('/api/collections/:name', async (req, res) => {
  let name: string;
  try {
    name = assertDeletableCollection(req.params.name);
  } catch (e) {
    if (e instanceof ValidationError) return sendValidationError(res, e);
    throw e;
  }

  try {
    await deleteCollectionFull(name);
    res.json({ ok: true, collection: name });
  } catch (e) {
    console.error('[/api/collections/:name DELETE]', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get('/api/collections/:name/stats', async (req, res) => {
  let collection: string;
  try {
    collection = normalizeCollectionSelector(req.params.name);
  } catch (e) {
    if (e instanceof ValidationError) return sendValidationError(res, e);
    throw e;
  }

  try {
    res.json(await getStatsForCollection(collection));
  } catch (e) {
    console.error('[/api/collections/:name/stats]', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

export default router;
