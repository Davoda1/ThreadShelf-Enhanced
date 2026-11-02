/** Shared bounds for untrusted provider replies. No provider controls resource budgets. */
export const PROVIDER_BODY_LIMIT = 16 * 1024 * 1024;
export const PROVIDER_EVENT_LIMIT = 2_000_000;
export const PROVIDER_IDLE_TIMEOUT_MS = 120_000;

export const redactProviderError = (value: unknown, secrets: readonly string[] = []): string => {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  return message
    .replace(/(Bearer\s+)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{8,})\b/g, '[redacted]')
    .replace(/([?&](?:key|api_key|token|access_token)=)[^\s&#]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32 || ['\n', '\r', '\t'].includes(character))
    .join('')
    .slice(0, 2000);
};

export const readProviderChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
  timeoutMs = PROVIDER_IDLE_TIMEOUT_MS,
): Promise<ReadableStreamReadResult<Uint8Array>> => {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Provider response idle timeout')), timeoutMs);
        abort = () => reject(signal?.reason ?? new Error('Generation cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
};

export const readProviderText = async (
  response: Response,
  limit = PROVIDER_BODY_LIMIT,
  signal?: AbortSignal,
): Promise<string> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Provider response exceeds its size limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await readProviderChunk(reader, signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Provider response exceeds its size limit');
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

export const readProviderJson = async <T = unknown>(
  response: Response,
  limit = PROVIDER_BODY_LIMIT,
  signal?: AbortSignal,
): Promise<T> => JSON.parse(await readProviderText(response, limit, signal)) as T;
