import { readProviderJson } from '../transport.js';
import { getGenerationConfig, getOpenRouterApiKey } from '../config.js';
import { openAiCompatibleChat, openAiCompatibleChatStream } from '../openai-compatible.js';
import type { GenerationModel, GenerationModelListOptions, GenerationProvider } from '../types.js';

interface OpenRouterModelsResponse {
  readonly data?: readonly {
    readonly id?: string;
    readonly name?: string;
    readonly context_length?: number;
    readonly created?: number;
    readonly pricing?: {
      readonly prompt?: string;
      readonly completion?: string;
    };
  }[];
  readonly error?: { readonly message?: string };
}

export const isFreeOpenRouterModel = (model: GenerationModel): boolean => {
  if (model.id === 'openrouter/free' || model.id.endsWith(':free')) return true;
  const prompt = Number(model.promptPrice);
  const completion = Number(model.completionPrice);
  return (
    model.promptPrice !== undefined &&
    model.promptPrice.trim() !== '' &&
    model.completionPrice !== undefined &&
    model.completionPrice.trim() !== '' &&
    Number.isFinite(prompt) &&
    Number.isFinite(completion) &&
    prompt === 0 &&
    completion === 0
  );
};

const routingPreferences = (
  enforceZdr: boolean,
  denyDataCollection: boolean,
): Readonly<Record<string, unknown>> | undefined => {
  const provider: Record<string, unknown> = {};
  if (enforceZdr) provider.zdr = true;
  if (denyDataCollection) provider.data_collection = 'deny';
  return Object.keys(provider).length > 0 ? { provider } : undefined;
};

const openRouterCreatedAt = (value: number | undefined): string | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export const createOpenRouterProvider = (fetchImpl: typeof fetch = fetch): GenerationProvider => ({
  id: 'openrouter',
  label: 'OpenRouter',
  local: false,

  async status() {
    const config = await getGenerationConfig();
    return {
      id: 'openrouter',
      label: 'OpenRouter',
      available: config.openRouter.apiKeyConfigured,
      local: false,
      detail: config.openRouter.apiKeyConfigured
        ? 'API key configured; prompts leave this device.'
        : 'Set OPENROUTER_API_KEY or a session key in Settings.',
    };
  },

  async listModels(options: GenerationModelListOptions = {}): Promise<GenerationModel[]> {
    const config = await getGenerationConfig();
    const key = getOpenRouterApiKey();
    if (!key) throw new Error('OpenRouter API key is not configured');
    const url = new URL(`${config.openRouter.baseUrl}/models`);
    if (options.sort && options.sort !== 'default') url.searchParams.set('sort', options.sort);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'ThreadShelf' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await readProviderJson(response).catch(
      () => ({}),
    )) as OpenRouterModelsResponse;
    if (!response.ok) {
      throw new Error(
        payload.error?.message || `OpenRouter models request failed (${response.status})`,
      );
    }
    return (payload.data ?? [])
      .filter((model): model is typeof model & { id: string } => Boolean(model.id))
      .map((model) => ({
        id: model.id,
        name: model.name || model.id,
        provider: 'openrouter' as const,
        contextLength: model.context_length,
        createdAt: openRouterCreatedAt(model.created),
        promptPrice: model.pricing?.prompt,
        completionPrice: model.pricing?.completion,
      }))
      .filter((model) => !options.freeOnly || isFreeOpenRouterModel(model));
  },

  async chat(request, signal) {
    const config = await getGenerationConfig();
    const key = getOpenRouterApiKey();
    if (!key) throw new Error('OpenRouter API key is not configured');
    return openAiCompatibleChat({
      provider: 'openrouter',
      baseUrl: config.openRouter.baseUrl,
      apiKey: key,
      request,
      signal,
      fetchImpl,
      extraBody: routingPreferences(
        request.openRouterZdr ?? config.openRouter.enforceZdr,
        config.openRouter.denyDataCollection,
      ),
    });
  },

  async chatStream(request, onDelta, signal) {
    const config = await getGenerationConfig();
    const key = getOpenRouterApiKey();
    if (!key) throw new Error('OpenRouter API key is not configured');
    return openAiCompatibleChatStream(
      {
        provider: 'openrouter',
        baseUrl: config.openRouter.baseUrl,
        apiKey: key,
        request,
        signal,
        fetchImpl,
        extraBody: routingPreferences(
          request.openRouterZdr ?? config.openRouter.enforceZdr,
          config.openRouter.denyDataCollection,
        ),
      },
      onDelta,
    );
  },
});
