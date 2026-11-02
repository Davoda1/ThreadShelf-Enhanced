import { Router, type Response } from 'express';
import { requireAiManagement } from './feature-access.js';
import {
  getVaultConfig,
  getVaultRegistry,
  selectVault,
  saveVaultConfig,
  setVaultWritePermission,
} from '../obsidian/config.js';
import {
  createVaultNote,
  editVaultNote,
  inVault,
  readVaultNote,
  searchVault,
  vaultErrorMessage,
} from '../obsidian/vault.js';
import { decideVaultDeletion } from '../obsidian/approvals.js';
import { detectNoteFolders } from '../obsidian/detect.js';

const router = Router();
router.use('/api/obsidian', requireAiManagement);

/** Raw filesystem errors carry absolute paths; only sanitized messages leave the server. */
const fail = (res: Response, status: number, error: unknown, fallback: string): void => {
  res.status(status).json({ error: vaultErrorMessage(error, fallback) });
};

router.get('/api/obsidian/vaults', async (_req, res) => {
  try {
    res.json(await getVaultRegistry());
  } catch (error) {
    fail(res, 500, error, 'Cannot read connected vaults');
  }
});
router.post('/api/obsidian/active', async (req, res) => {
  try {
    res.json(await selectVault(req.body?.vaultId));
  } catch (error) {
    fail(res, 400, error, 'Cannot select vault');
  }
});
/** Requests may pin a connected vault without changing another tab's active selection. */
router.use('/api/obsidian', async (req, res, next) => {
  const id = req.query.vaultId;
  if (id === undefined) {
    next();
    return;
  }
  if (typeof id !== 'string') {
    fail(res, 400, new Error('Invalid vault identifier'), 'Invalid vault identifier');
    return;
  }
  try {
    const config = await getVaultConfig(id);
    await inVault(config.vaultPath, async () => next());
  } catch (error) {
    fail(res, 400, error, 'Cannot select vault');
  }
});
router.get('/api/obsidian/config', async (req, res) => {
  try {
    res.json(
      await getVaultConfig(typeof req.query.vaultId === 'string' ? req.query.vaultId : undefined),
    );
  } catch (error) {
    fail(res, 500, error, 'Cannot read Obsidian configuration');
  }
});
router.get('/api/obsidian/detected', async (_req, res) => {
  try {
    res.json({ folders: await detectNoteFolders() });
  } catch (error) {
    fail(res, 500, error, 'Cannot look for note folders');
  }
});
router.put('/api/obsidian/config', async (req, res) => {
  try {
    res.json(await saveVaultConfig(req.body));
  } catch (error) {
    fail(res, 400, error, 'Invalid vault configuration');
  }
});
router.patch('/api/obsidian/config', async (req, res) => {
  try {
    const body: unknown = req.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'allowWrites')
    )
      throw new Error('Only allowWrites can be changed with PATCH');
    res.json(
      await setVaultWritePermission(
        (body as { allowWrites?: unknown }).allowWrites,
        typeof req.query.vaultId === 'string' ? req.query.vaultId : undefined,
      ),
    );
  } catch (error) {
    fail(res, 400, error, 'Invalid write policy');
  }
});
router.get('/api/obsidian/search', async (req, res) => {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    res.json(
      await searchVault(
        req.query.q,
        req.query.limit === undefined ? 10 : Number(req.query.limit),
        controller.signal,
      ),
    );
  } catch (error) {
    if (!controller.signal.aborted) fail(res, 400, error, 'Vault search failed');
  }
});
router.get('/api/obsidian/note', async (req, res) => {
  try {
    res.json(await readVaultNote(req.query.path));
  } catch (error) {
    fail(res, 400, error, 'Cannot read note');
  }
});
router.post('/api/obsidian/note', async (req, res) => {
  try {
    res.status(201).json(await createVaultNote(req.body?.path, req.body?.content));
  } catch (error) {
    fail(res, 400, error, 'Cannot create note');
  }
});
router.put('/api/obsidian/note', async (req, res) => {
  try {
    res.json(await editVaultNote(req.body?.path, req.body?.content, req.body?.revision));
  } catch (error) {
    fail(res, 409, error, 'Cannot edit note');
  }
});
router.post('/api/obsidian/approvals/:id', async (req, res) => {
  try {
    await decideVaultDeletion(req.params.id, req.body);
    res.json({ ok: true });
  } catch (error) {
    fail(res, 409, error, 'Confirmation failed');
  }
});
export default router;
