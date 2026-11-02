import { t } from '../i18n';

/** Same-origin bridge. No credentials, conversation text or ownership tokens go in URLs. */
const randomId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
};
export const ownerId = randomId();
export const requestId = randomId;
let accessKey = '';
let managedSettings: Record<string, unknown> = {};
let canManage = true;
let localPlayback: Record<string, unknown> = {};
let localChoice: { localProvider?: string; localVoice?: string; localStreamingEnabled?: boolean } =
  {};
export function setSpeechAccessKey(value: string) {
  accessKey = value.trim();
}
export function setLocalSpeechChoice(provider: string, voice: string, streaming: boolean) {
  localChoice = { localProvider: provider, localVoice: voice, localStreamingEnabled: streaming };
}
const authHeaders = (): Record<string, string> =>
  accessKey ? { Authorization: `Bearer ${accessKey}` } : {};
/** Settings responses carry UI capabilities and diagnostics alongside editable
 * preferences. Keep that metadata in the client, never send it as a preference
 * in saves, previews, synthesis overrides, or credential-save rollbacks. */
const writableSettings = (value: Record<string, unknown>): Record<string, unknown> => {
  const settings = { ...value };
  delete settings.access;
  delete settings.credentialStatus;
  delete settings.warning;
  return settings;
};
const events = new Set<(event: unknown) => void>();
const requests = new Map<string, AbortController>();
export const onTtsEvent = (listener: (event: unknown) => void) => {
  events.add(listener);
  return () => {
    events.delete(listener);
  };
};
export async function ttsRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  method?: string,
): Promise<T> {
  const response = await fetch(`/api/tts${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal,
    headers: {
      ...authHeaders(),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `Speech request failed (${response.status}).`);
  return result;
}
export async function ttsStream<T>(
  path: string,
  body: unknown,
  onEvent: (event: unknown) => void,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/tts${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error || `Speech request failed (${response.status}).`);
  }
  if (!response.body) throw new Error('Speech streaming is unavailable.');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = '',
    result: T | undefined,
    received = 0;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const item = JSON.parse(line) as { type: string; event?: unknown; result?: T; error?: string };
    if (item.type === 'error') throw new Error(item.error || 'Speech generation failed.');
    if (item.type === 'event') onEvent(item.event);
    if (item.type === 'result') result = item.result;
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      // A 64 MiB audio response can also include streamed copies. Bound protocol overhead.
      if (received > 192 * 1024 ** 2)
        throw new Error('The speech response exceeds the browser limit.');
      pending += decoder.decode(next.value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        consume(line);
      }
      if (pending.length > 96 * 1024 ** 2)
        throw new Error('The speech response frame is too large.');
    }
    consume(pending + decoder.decode());
    if (result === undefined) throw new Error('Speech connection ended before completion.');
    return result;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function invokeTts(
  action: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (action === 'tts.settings.get') {
    const value = await ttsRequest<Record<string, unknown> & { access?: { canManage: boolean } }>(
      '/settings',
    );
    canManage = value.access?.canManage !== false;
    managedSettings = canManage
      ? value
      : {
          ...value,
          ...localPlayback,
          ...(localChoice.localProvider
            ? {
                provider: localChoice.localProvider,
                voice: localChoice.localVoice,
                streamingEnabled: localChoice.localStreamingEnabled,
              }
            : {}),
        };
    return managedSettings;
  }
  if (action === 'tts.settings.save') {
    const settings = writableSettings(args.settings as Record<string, unknown>);
    if (!canManage) {
      if (Object.keys(settings).some((key) => !['volume', 'playbackRate'].includes(key)))
        throw new Error(
          t(
            'Speech management requires localhost or ALLOW_LAN_TTS=1 in the server .env, followed by a restart.',
          ),
        );
      localPlayback = { ...localPlayback, ...settings };
      managedSettings = { ...managedSettings, ...settings };
      return managedSettings;
    }
    return ttsRequest('/settings', { settings }, undefined, 'PATCH');
  }
  if (action === 'tts.cancel') {
    const id = args.requestId;
    if (typeof id === 'string') requests.get(id)?.abort();
  }
  if (action === 'tts.synthesize' || action === 'tts.preview') {
    const controller = new AbortController(),
      id = String(args.requestId);
    const settings = args.settings;
    const speechArgs =
      settings && typeof settings === 'object' && !Array.isArray(settings)
        ? { ...args, settings: writableSettings(settings as Record<string, unknown>) }
        : args;
    requests.set(id, controller);
    try {
      return await ttsStream(
        action === 'tts.preview' ? '/preview' : '/synthesize',
        { ownerId, ...speechArgs, ...localChoice },
        (event) => events.forEach((listener) => listener(event)),
        controller.signal,
      );
    } finally {
      if (requests.get(id) === controller) requests.delete(id);
    }
  }
  return ttsRequest('/invoke', { ownerId, action, args });
}
