import type { Provider } from './types';

export const PROVIDERS: Readonly<Record<string, Provider>> = {
  'google-ai-studio': { label: 'Google AI Studio', short: 'AI Studio', color: 'var(--p-google)' },
  google: { label: 'Google AI Studio', short: 'AI Studio', color: 'var(--p-google)' },
  openrouter: { label: 'OpenRouter', short: 'OpenRouter', color: 'var(--p-openrouter)' },
  openai: { label: 'ChatGPT', short: 'ChatGPT', color: 'var(--p-openai)' },
  anthropic: { label: 'Claude', short: 'Claude', color: 'var(--p-claude)' },
  claude: { label: 'Claude', short: 'Claude', color: 'var(--p-claude)' },
  'lm-studio': { label: 'LM Studio', short: 'LM Studio', color: 'var(--p-lmstudio)' },
  grok: { label: 'Grok', short: 'Grok', color: 'var(--p-grok)' },
  meta: { label: 'Meta AI', short: 'Meta AI', color: 'var(--p-google)' },
  gemini: { label: 'Gemini', short: 'Gemini', color: 'var(--p-google)' },
  venice: { label: 'Venice', short: 'Venice', color: 'var(--p-openrouter)' },
  converted: { label: 'Converted export', short: 'Converted', color: 'var(--p-openai)' },
  threadshelf: {
    label: 'ThreadShelf',
    short: 'ThreadShelf',
    color: 'oklch(0.74 0.16 165)',
  },
};

const UNKNOWN_PROVIDER: Provider = { label: 'Unknown', short: '—', color: 'var(--border-2)' };

export const getProvider = (key: string | undefined): Provider => {
  if (!key) return UNKNOWN_PROVIDER;
  return PROVIDERS[key] ?? UNKNOWN_PROVIDER;
};

export const EXAMPLE_QUERIES = [
  'paper chromatography household experiment',
  'fact-checking workflow with citations',
  'sauna rules and temperature',
  'openrouter export json schema',
  'ablation study sample size',
  'polish translation tone register',
] as const;

export const STORAGE_KEYS = {
  COLLECTION: 'threadshelf:selected-collection',
} as const;
