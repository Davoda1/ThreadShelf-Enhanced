import { getCompatibleApiKey, getGenerationConfig } from '../config.js';
import { openAiCompatibleChat, openAiCompatibleChatStream } from '../openai-compatible.js';
import { readProviderJson } from '../transport.js';
import type { GenerationModel, GenerationProvider } from '../types.js';

const options = async () => {
  const { openAiCompatible } = await getGenerationConfig();
  if (!openAiCompatible.baseUrl)
    throw new Error('Configure an OpenAI-compatible API base URL in AI Models settings');
  return { config: openAiCompatible, apiKey: await getCompatibleApiKey() };
};

/** User-selected endpoint. LAN hosts are deliberately described as off-device. */
export const createCompatibleProvider = (fetchImpl: typeof fetch = fetch): GenerationProvider => ({
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  // Dynamic availability/location are returned by status(), never assumed from this preset.
  local: false,
  async status() {
    const { openAiCompatible: config } = await getGenerationConfig();
    return {
      id: 'openai-compatible',
      label: config.label,
      available: Boolean(config.baseUrl),
      local: config.local,
      detail: config.baseUrl
        ? `${config.baseUrl} · ${config.local ? 'on this server' : 'off-device; selected conversation context is sent to this endpoint'}`
        : 'Set an explicit API base URL in AI Models settings.',
    };
  },
  async listModels(): Promise<GenerationModel[]> {
    const { config, apiKey } = await options();
    const response = await fetchImpl(`${config.baseUrl}/models`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!response.ok)
      throw new Error(`Compatible server models request failed (HTTP ${response.status})`);
    const payload = await readProviderJson<{ data?: unknown[] }>(response, 4 * 1024 * 1024);
    if (!payload || !Array.isArray(payload.data) || payload.data.length > 10_000)
      throw new Error('Compatible server returned an invalid models list');
    const seen = new Set<string>();
    return payload.data.flatMap((entry): GenerationModel[] => {
      if (!entry || typeof entry !== 'object') return [];
      const model = entry as Record<string, unknown>;
      if (
        typeof model.id !== 'string' ||
        !model.id.trim() ||
        model.id.length > 4096 ||
        seen.has(model.id)
      )
        return [];
      seen.add(model.id);
      return [
        {
          id: model.id,
          name: typeof model.name === 'string' ? model.name : model.id,
          provider: 'openai-compatible',
          loaded: true,
          ...(Number.isSafeInteger(model.context_length) && Number(model.context_length) > 0
            ? { contextLength: Number(model.context_length) }
            : {}),
        },
      ];
    });
  },
  async chat(request, signal) {
    const { config, apiKey } = await options();
    return openAiCompatibleChat({
      provider: 'openai-compatible',
      baseUrl: config.baseUrl,
      apiKey,
      request,
      signal,
      fetchImpl,
    });
  },
  async chatStream(request, onDelta, signal) {
    const { config, apiKey } = await options();
    return openAiCompatibleChatStream(
      {
        provider: 'openai-compatible',
        baseUrl: config.baseUrl,
        apiKey,
        request,
        signal,
        fetchImpl,
      },
      onDelta,
    );
  },
});
