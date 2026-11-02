import { Router } from 'express';
import { abortOnDisconnect } from './stream-abort.js';
import { searchAcrossCollections } from '../services/search.js';
import {
  ValidationError,
  normalizeCollectionSelector,
  normalizeQuery,
  normalizeCount,
  normalizeRoles,
  normalizeBoolean,
  normalizeOptionalString,
  normalizeDateRange,
  normalizeEnhancedSearchMode,
  type EnhancedSearchMode,
} from '../validation.js';

const router = Router();

router.get('/api/search', async (req, res) => {
  const controller = abortOnDisconnect(req, res);
  let q: string;
  let collection: string;
  let n: number;
  let roles: string[] | null;
  let keywordBoost: boolean;
  let model: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let mode: EnhancedSearchMode;
  let origin: 'threadshelf' | 'archive' | undefined;

  try {
    q = normalizeQuery(req.query?.q);
    collection = normalizeCollectionSelector(req.query?.collection);
    n = normalizeCount(req.query?.n, { defaultValue: 15 });
    roles = normalizeRoles(req.query?.roles) || null;
    keywordBoost = normalizeBoolean(req.query?.keywordBoost, { field: 'keywordBoost' });
    model = normalizeOptionalString(req.query?.model, { field: 'model' });
    ({ from, to } = normalizeDateRange(req.query?.from, req.query?.to));
    mode = normalizeEnhancedSearchMode(req.query?.mode);
    const rawOrigin = normalizeOptionalString(req.query?.origin, { field: 'origin' });
    if (rawOrigin && rawOrigin !== 'threadshelf' && rawOrigin !== 'archive') {
      throw new ValidationError('Invalid origin: expected threadshelf or archive', {
        field: 'origin',
      });
    }
    origin = rawOrigin as 'threadshelf' | 'archive' | undefined;
  } catch (e) {
    if (e instanceof ValidationError) {
      return res.status(400).json({ error: e.message, field: e.field });
    }
    throw e;
  }

  try {
    const results = await searchAcrossCollections(q, collection, {
      n,
      roles: roles ?? undefined,
      keywordBoost,
      model,
      from,
      to,
      mode,
      origin,
      signal: controller.signal,
    });
    // Legacy single-collection clients expect the historical metadata shape.
    // Internal retrieval and additive hybrid keep full collection identities.
    const responseResults =
      collection === 'all' || mode === 'hybrid'
        ? results
        : results.map((row) => {
            const metadata = { ...row.metadata };
            delete metadata.collection;
            return { ...row, metadata };
          });
    res.json({ results: responseResults });
  } catch (e) {
    if (controller.signal.aborted || res.destroyed) return;
    console.error('[/api/search]', e);
    res.status(500).json({ error: (e as Error).message, results: [] });
  }
});

export default router;
