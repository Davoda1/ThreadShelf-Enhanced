import { Router, json, type Request, type Response } from 'express';
import { once } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import { requireTtsManagement, isFeatureManagementRequest } from './feature-access.js';
import { getLocalApiAccess } from '../generation/config.js';
import { abortOnDisconnect } from './stream-abort.js';
import { getTtsService, type TtsSettings } from '../tts/service.js';
import { ttsAssets, type TtsEvent } from '../tts/assets.js';
const router = Router();
router.use(json({ limit: '512kb' }));
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'Text-to-Speech request failed.';
// Trusted-LAN opt-in grants the same speech controls as localhost.
// Without it, remote callers keep the restricted, API-key-only CPU path.
const canManageSpeech = (req: Request): boolean => isFeatureManagementRequest(req, 'tts');
const sha = (value: string): Buffer => createHash('sha256').update(value).digest();
async function allowPlayback(req: Request, res: Response): Promise<boolean> {
  if (canManageSpeech(req)) return true;
  const settings = await getTtsService().settings();
  const access = await getLocalApiAccess();
  if (
    !settings.enabled ||
    settings.allowNetworkPlayback !== true ||
    !access.enabled ||
    !access.apiKey
  ) {
    res.status(403).json({
      error:
        'Enable authenticated LAN speech and configure a local API key, or set ALLOW_LAN_TTS=1 on the server for trusted-LAN speech controls.',
    });
    return false;
  }
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '')?.[1];
  if (!bearer || !timingSafeEqual(sha(bearer), sha(access.apiKey))) {
    res.status(401).json({ error: 'Enter the server local API key for LAN speech.' });
    return false;
  }
  return true;
}
const cpuSettings = (settings: TtsSettings, provider?: unknown, voice?: unknown): TtsSettings => {
  const engine =
    provider ?? (['pocket', 'kokoro'].includes(settings.provider) ? settings.provider : 'pocket');
  if (engine !== 'pocket' && engine !== 'kokoro')
    throw new Error('LAN speech supports installed Pocket and Kokoro voices.');
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  const profile = profiles[engine]!;
  return {
    ...settings,
    ...profile,
    ...(voice === undefined ? {} : { voice }),
    provider: engine,
    cacheEnabled: false,
    preferSavedApiAudio: false,
  } as TtsSettings;
};
router.get('/settings', async (req, res) => {
  try {
    const settings = await getTtsService().settings(),
      canManage = canManageSpeech(req);
    res.setHeader('Cache-Control', 'no-store');
    const safe = canManage ? settings : cpuSettings(settings);
    if (!canManage) {
      delete safe.credentialStatus;
      safe.providerProfiles = Object.fromEntries(
        Object.entries(settings.providerProfiles as Record<string, Record<string, unknown>>).map(
          ([id, p]) => [
            id,
            ['pocket', 'kokoro'].includes(id)
              ? p
              : { ...p, endpoint: '', instructions: '', voice: '', model: '' },
          ],
        ),
      );
    }
    res.json({
      ...safe,
      access: {
        canManage,
        networkPlaybackEnabled: settings.allowNetworkPlayback === true,
        requiresApiKey: !canManage,
      },
    });
  } catch (error) {
    res.status(400).json({ error: errorText(error) });
  }
});
router.patch('/settings', requireTtsManagement, async (req, res) => {
  try {
    const settings = await getTtsService().save(req.body?.settings);
    if (!settings.enabled) ttsAssets.cancelInstallation();
    res.json({
      ...settings,
      access: {
        canManage: true,
        networkPlaybackEnabled: settings.allowNetworkPlayback === true,
        requiresApiKey: false,
      },
    });
  } catch (error) {
    res.status(400).json({ error: errorText(error) });
  }
});
router.post('/invoke', async (req, res) => {
  try {
    if (!canManageSpeech(req)) {
      if (!(await allowPlayback(req, res))) return;
      if (
        !['tts.availability', 'tts.cancel', 'tts.playback', 'tts.providers.discover'].includes(
          req.body?.action,
        )
      ) {
        res.status(403).json({
          error: 'Speech management requires localhost or ALLOW_LAN_TTS=1 on the server.',
        });
        return;
      }
      if (req.body?.action === 'tts.availability')
        req.body.args = { ...req.body.args, private: true };
      if (req.body?.action === 'tts.providers.discover') {
        if (!['pocket', 'kokoro'].includes(req.body?.args?.provider)) {
          res.status(403).json({ error: 'LAN speech discovery supports local CPU engines only.' });
          return;
        }
        req.body.args = { provider: req.body.args.provider };
      }
    }
    res.json(
      await getTtsService().invoke(req.body?.ownerId, req.body?.action, req.body?.args || {}),
    );
  } catch (error) {
    res.status(400).json({ error: errorText(error) });
  }
});
async function stream(
  req: Request,
  res: Response,
  work: (emit: (event: TtsEvent) => void, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  const controller = abortOnDisconnect(req, res, 'Speech operation disconnected');
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();
  const emit = (event: TtsEvent): void => {
    if (controller.signal.aborted) return;
    if (res.writableLength > 4 * 1024 ** 2) {
      controller.abort(new Error('Speech client cannot receive audio fast enough.'));
      return;
    }
    res.write(JSON.stringify({ type: 'event', event }) + '\n');
  };
  try {
    const result = await work(emit, controller.signal);
    controller.signal.throwIfAborted();
    const ok = res.write(JSON.stringify({ type: 'result', result }) + '\n');
    if (!ok) await once(res, 'drain', { signal: controller.signal });
  } catch (error) {
    if (!res.destroyed && !res.writableEnded)
      res.write(JSON.stringify({ type: 'error', error: errorText(error) }) + '\n');
  } finally {
    if (!res.destroyed) res.end();
  }
}
for (const operation of ['synthesize', 'preview'] as const)
  router.post('/' + operation, async (req, res) => {
    if (!(await allowPlayback(req, res))) return;
    let override: TtsSettings | undefined;
    let args = req.body;
    try {
      if (!canManageSpeech(req)) {
        override = cpuSettings(
          await getTtsService().settings(),
          req.body?.localProvider,
          req.body?.localVoice,
        );
        if (req.body?.localStreamingEnabled !== undefined) {
          if (typeof req.body.localStreamingEnabled !== 'boolean')
            throw new Error('Invalid streaming preference');
          override.streamingEnabled = req.body.localStreamingEnabled;
        }
        args = { ...req.body, private: true, settings: undefined, apiKey: undefined };
      }
    } catch (error) {
      res.status(400).json({ error: errorText(error) });
      return;
    }
    await stream(req, res, (emit, signal) =>
      getTtsService().synthesize(
        req.body?.ownerId,
        args,
        operation === 'preview',
        emit,
        signal,
        override,
      ),
    );
  });
router.get('/assets', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await ttsAssets.status());
  } catch (error) {
    res.status(400).json({ error: errorText(error) });
  }
});
router.post('/assets/plan', requireTtsManagement, async (req, res) => {
  try {
    res.json(await ttsAssets.plan(req.body?.engines));
  } catch (error) {
    res.status(400).json({ error: errorText(error) });
  }
});
router.post('/assets/install', requireTtsManagement, async (req, res) => {
  if (!(await getTtsService().settings()).enabled) {
    res.status(409).json({ error: 'Enable Text-to-Speech before downloading local voices.' });
    return;
  }
  await stream(req, res, (emit, signal) =>
    ttsAssets.install(req.body?.engines, req.body?.fingerprint, emit, signal),
  );
});
router.post('/assets/uninstall', requireTtsManagement, async (req, res) => {
  try {
    res.json(await ttsAssets.uninstall(req.body?.engines));
  } catch (error) {
    res.status(400).json({ error: errorText(error) });
  }
});
export default router;
