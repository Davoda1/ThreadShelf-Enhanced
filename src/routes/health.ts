import { Router } from 'express';
import { getMemoryStatus } from '../memory-governor.js';

const router = Router();

router.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

router.get('/api/memory', (_req, res) => {
  res.json(getMemoryStatus());
});

export default router;
