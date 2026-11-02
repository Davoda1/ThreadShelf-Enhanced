import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import { dataPath, packagePath } from '../paths.js';
import { abortOnDisconnect } from '../routes/stream-abort.js';
import { ttsAssets, type TtsEvent, type Engine, TtsAssetManager } from './assets.js';

export type TtsSettings = Record<string, unknown> & {
  enabled: boolean;
  provider: string;
  includeThinking: boolean;
  streamingEnabled: boolean;
};
type Args = Record<string, unknown>;
interface Core {
  invoke: (action: string, args?: Args) => Promise<unknown>;
  dispose: () => Promise<void>;
}
interface Job {
  owner: string;
  requestId: string;
  internalId: string;
  controller: AbortController;
  onEvent: (event: TtsEvent) => void;
  done: Promise<unknown>;
}
const require = createRequire(import.meta.url);
const ttsModule = require(packagePath('tts', 'index.cjs')) as {
  createTtsService: (args: {
    profileDir: string;
    assetsDir: string;
    onEvent: (event: TtsEvent) => void;
    dependencies: Record<string, unknown>;
  }) => Core;
};
const cpu = require(packagePath('tts', 'cpu.cjs')) as {
  synthesizeCPU: (args: Args) => Promise<Buffer>;
  POCKET_VOICES: string[];
  KOKORO_VOICES: string[];
};
const providers = require(packagePath('tts', 'providers.cjs')) as {
  parseWav: (bytes: Buffer) => { pcm: Buffer };
  wav: (bytes: Buffer, rate?: number, channels?: number) => Buffer;
};
const allowedActions = new Set([
  'tts.availability',
  'tts.cancel',
  'tts.playback',
  'tts.cache.list',
  'tts.cache.preview',
  'tts.cache.delete',
  'tts.cache.pin',
  'tts.providers.discover',
  'tts.credentials.status',
  'tts.credentials.set',
  'tts.credentials.unlock',
  'tts.credentials.forget',
]);
const object = (value: unknown): Args => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('Invalid speech request');
  return value as Args;
};
const ownerKey = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value))
    throw new Error('Invalid speech session identity');
  return value;
};
const requestKey = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new Error('Invalid speech request identity');
  return value;
};
const internalKey = (owner: string, id: string): string =>
  createHash('sha256').update(owner).digest('hex').slice(0, 32) + ':' + id;
const cancelled = (): Error => new DOMException('Speech generation cancelled.', 'AbortError');
/** One archive server owns one coherent settings/cache/credentials service.
 * CPU/remote work has a bounded FIFO; starting another tab never cancels it. */
export class ServerTts {
  private core: Core;
  private jobs = new Map<string, Job>();
  private active: Job | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(
    readonly assets: TtsAssetManager = ttsAssets,
    root = dataPath('tts'),
    dependencies: Record<string, unknown> = {},
  ) {
    this.core = ttsModule.createTtsService({
      profileDir: root,
      assetsDir: joinAssets(root),
      onEvent: (event) => {
        const job = this.active;
        if (job && event.requestId === job.internalId) {
          job.onEvent({ ...event, requestId: job.requestId });
        }
      },
      dependencies: {
        serverMode: true,
        signalForRequest: (id: string) =>
          this.active?.internalId === id ? this.active.controller.signal : undefined,
        synthesizeCPU: async (args: Args) =>
          this.assets.withAssets(
            args.provider as Engine,
            (assetsDir) => cpu.synthesizeCPU({ ...args, assetsDir }),
            args.signal as AbortSignal | undefined,
          ),
        ...dependencies,
      },
    });
  }
  async settings(): Promise<TtsSettings> {
    return (await this.core.invoke('tts.settings.get')) as TtsSettings;
  }
  async save(settings: unknown): Promise<TtsSettings> {
    const patch = object(settings);
    if (patch.enabled === false)
      for (const job of this.jobs.values()) job.controller.abort(cancelled());
    return (await this.core.invoke('tts.settings.save', { settings: patch })) as TtsSettings;
  }
  async invoke(owner: unknown, action: unknown, args: unknown = {}): Promise<unknown> {
    const id = ownerKey(owner);
    if (typeof action !== 'string' || !allowedActions.has(action))
      throw new Error('Unknown speech action');
    const values = { ...object(args) };
    delete values.serverSettings;
    if (action === 'tts.cancel') {
      const requestId = values.requestId === undefined ? undefined : requestKey(values.requestId);
      let count = 0;
      for (const job of this.jobs.values())
        if (job.owner === id && (!requestId || job.requestId === requestId)) {
          job.controller.abort(cancelled());
          count++;
        }
      return { cancelled: count > 0 };
    }
    if (action === 'tts.playback') values.requestId = internalKey(id, requestKey(values.requestId));
    if (action === 'tts.availability' && values.private === true) {
      const messages = values.messages;
      if (!Array.isArray(messages) || messages.length > 64)
        throw new Error('Check at most 64 speech recordings at a time');
      return { revision: 0, items: messages.map((m) => ({ id: object(m).id, available: false })) };
    }
    return this.core.invoke(action, values);
  }
  async synthesize(
    owner: unknown,
    request: unknown,
    preview: boolean,
    onEvent: (event: TtsEvent) => void,
    signal?: AbortSignal,
    serverSettings?: TtsSettings,
  ): Promise<unknown> {
    if (this.disposed) throw new Error('Text-to-Speech has shut down');
    const ownerId = ownerKey(owner),
      args = { ...object(request) };
    delete args.serverSettings;
    delete args.ownerId;
    if (Buffer.byteLength(JSON.stringify(args)) > 512 * 1024)
      throw new Error('The speech request is too large.');
    const requestId = requestKey(args.requestId),
      key = internalKey(ownerId, requestId);
    const settings = serverSettings || (await this.settings());
    if (!preview && !settings.enabled) throw new Error('Text-to-Speech is disabled.');
    if (this.disposed) throw new Error('Text-to-Speech has shut down');
    if (this.jobs.has(key)) throw new Error('This speech request is already queued');
    if (this.jobs.size >= 8)
      throw new Error('The speech queue is full. Wait for another reading to finish.');
    if ([...this.jobs.values()].filter((job) => job.owner === ownerId).length >= 2)
      throw new Error('This tab already has two speech requests.');
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason || cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const job: Job = {
      owner: ownerId,
      requestId,
      internalId: key,
      controller,
      onEvent,
      done: Promise.resolve(),
    };
    this.jobs.set(key, job);
    const run = async (): Promise<unknown> => {
      controller.signal.throwIfAborted();
      if (!preview && !(await this.settings()).enabled)
        throw new Error('Text-to-Speech is disabled.');
      controller.signal.throwIfAborted();
      this.active = job;
      const cancelCore = (): void => {
        void this.core.invoke('tts.cancel', { requestId: key });
      };
      controller.signal.addEventListener('abort', cancelCore, { once: true });
      try {
        const result = await this.core.invoke(preview ? 'tts.preview' : 'tts.synthesize', {
          ...args,
          requestId: key,
          serverSettings: settings,
        });
        controller.signal.throwIfAborted();
        return { ...object(result), requestId };
      } finally {
        controller.signal.removeEventListener('abort', cancelCore);
        if (this.active === job) this.active = null;
      }
    };
    try {
      onEvent({ state: 'queued', requestId, position: this.jobs.size });
    } catch {
      controller.abort(cancelled());
    }
    job.done = this.tail.catch(() => {}).then(run);
    this.tail = job.done.catch(() => {});
    try {
      return await job.done;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.jobs.delete(key);
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const job of this.jobs.values()) job.controller.abort(cancelled());
    await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
    await this.core.dispose();
  }
}
const joinAssets = (root: string): string => root + '/assets';
let singleton: ServerTts | undefined;
export const getTtsService = (): ServerTts => (singleton ??= new ServerTts());
export const disposeTts = async (): Promise<void> => {
  await singleton?.dispose();
  singleton = undefined;
};
export const speechModels = async (): Promise<
  { id: string; object: 'model'; created: number; owned_by: string }[]
> => {
  if (!(await getTtsService().settings()).enabled) return [];
  const status = await ttsAssets.status();
  const engines = status.engines as Record<Engine, { installed: boolean }>;
  return (['pocket', 'kokoro'] as Engine[])
    .filter((e) => engines[e].installed)
    .map((e) => ({
      id: `tts-${e}`,
      object: 'model',
      created: 0,
      owned_by: 'threadshelf-local-tts',
    }));
};
export const speechVoicesHandler: RequestHandler = async (_req, res) => {
  try {
    const models = await speechModels();
    res.json({
      voices: models.flatMap((m) =>
        (m.id === 'tts-pocket' ? cpu.POCKET_VOICES : cpu.KOKORO_VOICES).map((id) => ({
          id,
          name: id,
          model: m.id,
          language: 'en',
        })),
      ),
    });
  } catch {
    res
      .status(503)
      .json({ error: { message: 'Local speech is unavailable', type: 'server_error' } });
  }
};
export const speechHandler: RequestHandler = async (req, res) => {
  const abort = abortOnDisconnect(req, res, 'Speech client disconnected');
  try {
    const body = object(req.body);
    if (!['tts-pocket', 'tts-kokoro'].includes(String(body.model)))
      throw new Error('Choose an installed tts-pocket or tts-kokoro model.');
    if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 100000)
      throw new Error('Speech input must contain 1 to 100,000 characters.');
    if (
      body.response_format !== undefined &&
      !['wav', 'pcm'].includes(String(body.response_format))
    )
      throw new Error('Local speech supports wav and pcm response formats.');
    if (body.speed !== undefined && body.speed !== 1)
      throw new Error('Local speech speed is controlled during playback; use speed 1.');
    const engine = body.model === 'tts-pocket' ? 'pocket' : 'kokoro';
    const voices = engine === 'pocket' ? cpu.POCKET_VOICES : cpu.KOKORO_VOICES;
    const voice = body.voice ?? (engine === 'pocket' ? 'alba' : 'am_michael');
    if (typeof voice !== 'string' || !voices.includes(voice))
      throw new Error('Choose a supported English voice.');
    const service = getTtsService(),
      settings = await service.settings();
    if (!settings.enabled) throw new Error('Text-to-Speech is disabled.');
    const profile = (settings.providerProfiles as Record<string, Args>)[engine]!;
    const streamPCM =
      body.response_format === 'pcm' && settings.streamingEnabled && body.stream !== false;
    let streamed = false;
    const onAudio = (event: TtsEvent): void => {
      if (!streamPCM || event.state !== 'audio' || typeof event.audioBase64 !== 'string') return;
      if (res.writableLength > 4 * 1024 ** 2) {
        abort.abort(new Error('Speech client cannot receive audio fast enough.'));
        return;
      }
      const pcm = providers.parseWav(Buffer.from(event.audioBase64, 'base64')).pcm;
      if (!res.headersSent) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'audio/pcm;rate=24000;channels=1');
      }
      streamed = true;
      res.write(pcm);
    };
    const requestId = randomBytes(16).toString('hex'),
      ownerId = randomBytes(24).toString('hex');
    const result = object(
      await service.synthesize(
        ownerId,
        {
          requestId,
          sourceId: 'speech-api',
          messageId: requestId,
          text: body.input,
          private: true,
        },
        false,
        onAudio,
        abort.signal,
        {
          ...settings,
          ...profile,
          voice,
          provider: engine,
          cacheEnabled: false,
          streamingEnabled: streamPCM,
        },
      ),
    );
    if (typeof result.audioBase64 !== 'string' || result.mime !== 'audio/wav')
      throw new Error('Local speech did not return a complete WAV');
    if (streamed) {
      res.end();
      return;
    }
    const bytes = Buffer.from(result.audioBase64, 'base64');
    res.setHeader('Cache-Control', 'no-store');
    res.type(body.response_format === 'pcm' ? 'audio/pcm' : 'audio/wav');
    res.send(body.response_format === 'pcm' ? providers.parseWav(bytes).pcm : bytes);
  } catch (error) {
    if (res.headersSent && !res.destroyed) {
      res.destroy();
      return;
    }
    if (!res.headersSent && !res.destroyed)
      res.status(400).json({
        error: {
          message: error instanceof Error ? error.message : 'Speech generation failed',
          type: 'invalid_request_error',
        },
      });
  }
};
