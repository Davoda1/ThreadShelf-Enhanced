import { useUIStore } from '../store';
import { t, useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { LOCAL_API_STATUS_KEY } from '../queries';
import type {
  GenerationConfigResponse,
  GenerationModel,
  LlamaAccelerationMode,
  LlamaFlashAttention,
  LlamaKvCacheProfile,
  LlamaReasoningEffort,
  LlamaSpeculativeMode,
  LlamaSplitMode,
} from '../types';
import { toast } from '../toast';
import { DirectoryPicker } from './DirectoryPicker';
import { GenerationRuntimeBadge } from './GenerationRuntimeBadge';
import {
  LocalApiPanel,
  isValidNetworkPort,
  localApiDraftFrom,
  type LocalApiDraft,
} from './LocalApiPanel';
import type { GuideTab } from './LocalApiGuide';
import { ModelCatalogModal } from './ModelCatalogModal';
import { NumberCombobox } from './NumberCombobox';
import { QuickSetupPanel } from './QuickSetupPanel';

const joinDirectories = (directories: readonly string[]): string => directories.join('\n');

// Presets are a convenience only — the field accepts any size the server allows.
const CONTEXT_SIZE_PRESETS = [4096, 8192, 16_384, 32_768, 65_536, 131_072, 262_144] as const;
const CONTEXT_SIZE_LABELS: Record<number, string> = {
  get 4096() {
    return t('4k · light');
  },
  get 8192() {
    return t('8k · balanced');
  },
  get 16_384() {
    return t('16k');
  },
  get 32_768() {
    return t('32k · recommended for 24 GB GPUs');
  },
  get 65_536() {
    return t('64k · long');
  },
  get 131_072() {
    return t('128k · long, slower');
  },
  get 262_144() {
    return t('262k · native for Qwen3.8 · needs Q4 KV on 24 GB');
  },
};
// Past 64K, generation slows noticeably as the context fills (RTX 3090 Ti, Gemma 4
// 26B-A4B: 110 tok/s at 32K, 69 at 128K, 46 at 256K; see docs/PERFORMANCE.md).
const LONG_CONTEXT_TOKENS = 65_536;

const KV_CACHE_HELP: Record<LlamaKvCacheProfile, string> = {
  get default() {
    return t('F16 · llama.cpp default, uses the most KV memory.');
  },
  get quality() {
    return t(
      'Q8_0 keys and values · near-lossless, about half the KV memory. Turns Flash Attention on.',
    );
  },
  get memory() {
    return t(
      'Q4_0 keys and values · longest context per GB, small quality cost. Turns Flash Attention on.',
    );
  },
};

const SPECULATIVE_HELP: Record<LlamaSpeculativeMode, string> = {
  get off() {
    return t('No speculative decoding.');
  },
  get auto() {
    return t(
      "Drafts 2 tokens with the model's own MTP/NextN head when the GGUF has one; otherwise stays off.",
    );
  },
  get aggressive() {
    return t(
      'Drafts 3 tokens · faster on predictable text, slightly more VRAM. Needs an MTP/NextN head.',
    );
  },
};

const REASONING_HELP: Record<LlamaReasoningEffort, string> = {
  get default() {
    return t('Keeps the chat template default.');
  },
  get off() {
    return t('Disables thinking where the chat template supports it.');
  },
  get low() {
    return t('Short thinking · fastest answers.');
  },
  get medium() {
    return t('Recommended desktop balance of speed and quality.');
  },
  get high() {
    return t('Longer thinking.');
  },
  get xhigh() {
    return t('Slowest · maximum reasoning, can consume much of the context.');
  },
};

// Like Ollama's keep_alive: how long an unused model stays in memory.
const IDLE_UNLOAD_PRESETS: readonly { readonly minutes: number; readonly label: string }[] = [
  {
    minutes: 0,
    get label() {
      return t('Never (until another model or Eject)');
    },
  },
  {
    minutes: 5,
    get label() {
      return t('After 5 minutes idle');
    },
  },
  {
    minutes: 15,
    get label() {
      return t('After 15 minutes idle');
    },
  },
  {
    minutes: 30,
    get label() {
      return t('After 30 minutes idle');
    },
  },
  {
    minutes: 60,
    get label() {
      return t('After 1 hour idle');
    },
  },
  {
    minutes: 240,
    get label() {
      return t('After 4 hours idle');
    },
  },
  {
    minutes: 1440,
    get label() {
      return t('After 1 day idle');
    },
  },
];

const ACCELERATION_HELP: Record<LlamaAccelerationMode, string> = {
  get auto() {
    return t(
      'Recommended. llama.cpp fits as many layers as possible to available accelerators, then uses CPU.',
    );
  },
  get cpu() {
    return t('CPU only. Most compatible, but usually slower for generation.');
  },
  get gpu() {
    return t('Single GPU maximum. Loads all possible model layers on the selected GPU.');
  },
  get hybrid() {
    return t('CPU + GPU. Offloads an exact number of layers and keeps the rest on CPU.');
  },
  get 'multi-gpu'() {
    return t('Loads all possible layers and distributes work across multiple GPUs.');
  },
};

export function GenerationSettings() {
  useI18n();
  const [data, setData] = useState<GenerationConfigResponse | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [executablePath, setExecutablePath] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [directories, setDirectories] = useState('');
  const [contextSize, setContextSize] = useState('8192');
  const [acceleration, setAcceleration] = useState<LlamaAccelerationMode>('auto');
  const [gpuLayers, setGpuLayers] = useState(20);
  const [splitMode, setSplitMode] = useState<LlamaSplitMode>('layer');
  const [mainGpu, setMainGpu] = useState(0);
  const [tensorSplit, setTensorSplit] = useState('');
  const [threads, setThreads] = useState(-1);
  const [flashAttention, setFlashAttention] = useState<LlamaFlashAttention>('auto');
  const [kvCache, setKvCache] = useState<LlamaKvCacheProfile>('quality');
  const [speculative, setSpeculative] = useState<LlamaSpeculativeMode>('auto');
  const [reasoningEffort, setReasoningEffort] = useState<LlamaReasoningEffort>('medium');
  const [apiKey, setApiKey] = useState('');
  const [enforceZdr, setEnforceZdr] = useState(false);
  const [denyDataCollection, setDenyDataCollection] = useState(false);
  const [persistErrorLogs, setPersistErrorLogs] = useState(true);
  const [idleUnloadMinutes, setIdleUnloadMinutes] = useState(0);
  const [localApi, setLocalApi] = useState<LocalApiDraft>(() => localApiDraftFrom(undefined));
  const queryClient = useQueryClient();
  const [models, setModels] = useState<GenerationModel[] | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [guide, setGuide] = useState<GuideTab | null>(null);

  const applyData = (next: GenerationConfigResponse) => {
    setData(next);
    setExecutablePath(next.config.llamaCpp.executablePath ?? '');
    setBaseUrl(next.config.llamaCpp.baseUrl ?? '');
    // Only user-configured roots are editable. Conventional and env roots remain runtime-only.
    setDirectories(joinDirectories(next.config.llamaCpp.modelDirectories));
    setContextSize(String(next.config.llamaCpp.contextSize));
    setAcceleration(next.config.llamaCpp.acceleration);
    setGpuLayers(next.config.llamaCpp.gpuLayers);
    setSplitMode(next.config.llamaCpp.splitMode);
    setMainGpu(next.config.llamaCpp.mainGpu);
    setTensorSplit(next.config.llamaCpp.tensorSplit ?? '');
    setThreads(next.config.llamaCpp.threads);
    setFlashAttention(next.config.llamaCpp.flashAttention);
    setKvCache(next.config.llamaCpp.kvCache ?? 'quality');
    setSpeculative(next.config.llamaCpp.speculative ?? 'auto');
    setReasoningEffort(next.config.llamaCpp.reasoningEffort ?? 'medium');
    setEnforceZdr(next.config.openRouter.enforceZdr);
    setDenyDataCollection(next.config.openRouter.denyDataCollection);
    setPersistErrorLogs(next.config.diagnostics?.persistErrorLogs ?? true);
    setIdleUnloadMinutes(next.config.llamaCpp.idleUnloadMinutes ?? 0);
    setLocalApi(localApiDraftFrom(next.config.localApi));
  };

  useEffect(() => {
    const controller = new AbortController();
    void api
      .generationConfig(controller.signal)
      .then(applyData)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : 'Could not load generation settings.');
      });
    return () => controller.abort();
  }, []);

  const parsedContextSize = Number(contextSize);
  const contextSizeValid =
    /^\d+$/.test(contextSize) && parsedContextSize >= 512 && parsedContextSize <= 1_048_576;

  const save = async () => {
    if (!contextSizeValid) {
      setError('Context window must be a whole number from 512 to 1,048,576 tokens.');
      return;
    }
    if (localApi.networkAccess && !isValidNetworkPort(localApi.networkPort)) {
      setError('Network port must be a whole number from 1 to 65,535.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const llamaCpp = {
        executablePath,
        baseUrl,
        modelDirectories: directories
          .split(/\r?\n/)
          .map((path) => path.trim())
          .filter(Boolean),
        contextSize: parsedContextSize,
        acceleration,
        gpuLayers,
        splitMode,
        mainGpu,
        tensorSplit,
        threads,
        flashAttention,
        kvCache,
        speculative,
        reasoningEffort,
        idleUnloadMinutes,
      };
      const saved = data?.config.llamaCpp;
      const savedLlamaCpp = {
        ...saved,
        executablePath: saved?.executablePath ?? '',
        baseUrl: saved?.baseUrl ?? '',
        tensorSplit: saved?.tensorSplit ?? '',
        kvCache: saved?.kvCache ?? 'quality',
        speculative: saved?.speculative ?? 'auto',
        reasoningEffort: saved?.reasoningEffort ?? 'medium',
        idleUnloadMinutes: saved?.idleUnloadMinutes ?? 0,
      };
      const llamaCppChanged = Object.entries(llamaCpp).some(
        ([field, value]) =>
          JSON.stringify(value) !==
          JSON.stringify(savedLlamaCpp[field as keyof typeof savedLlamaCpp]),
      );
      const next = await api.updateGenerationConfig({
        // Access settings must stay editable while a model is generating.
        llamaCpp: llamaCppChanged ? llamaCpp : undefined,
        openRouter: {
          apiKey: apiKey || undefined,
          enforceZdr,
          denyDataCollection,
        },
        localApi: {
          enabled: localApi.enabled,
          apiKey: localApi.apiKey || undefined,
          clearApiKey: localApi.clearApiKey || undefined,
          networkAccess: localApi.networkAccess,
          networkPort: isValidNetworkPort(localApi.networkPort)
            ? Number(localApi.networkPort)
            : undefined,
        },
        diagnostics: { persistErrorLogs },
      });
      applyData(next);
      void queryClient.invalidateQueries({ queryKey: LOCAL_API_STATUS_KEY });
      setApiKey('');
      setModels(null);
      window.dispatchEvent(new Event('threadshelf:generation-runtime-changed'));
      toast.success(t('Generation settings saved.'));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not save settings.';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const scanModels = async () => {
    setModels(null);
    setError('');
    try {
      const response = await api.generationModels('llama-cpp');
      setModels(response.models);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Model scan failed.');
    }
  };

  const addDirectory = (path: string) => {
    const current = directories
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!current.includes(path)) setDirectories([...current, path].join('\n'));
  };

  return (
    <section className="generation-settings" aria-labelledby="generation-settings-title">
      <div className="section-h">
        <h2 id="generation-settings-title">{t('Conversation generation')}</h2>
      </div>

      <div className="banner warn">
        {t(
          'llama.cpp stays local. OpenRouter sends the selected archived conversation and new prompts to OpenRouter and its downstream provider.',
        )}
      </div>

      {error && <div className="banner err">{t(error)}</div>}

      <GenerationRuntimeBadge detailed />

      <QuickSetupPanel onCompleted={() => void scanModels()} />

      <div className="panel generation-panel">
        <div className="panel-head">
          <h3>{t('llama.cpp wrapper')}</h3>
          <span className="sub">{t('local · primary engine')}</span>
          <button
            type="button"
            className="btn sm ghost panel-head-action"
            onClick={() => setGuide('settings')}
          >
            {t('What do these settings mean?')}
          </button>
        </div>
        <div className="panel-body generation-form">
          <label>
            <span>{t('llama-server executable')}</span>
            <input
              value={executablePath}
              onChange={(event) => setExecutablePath(event.target.value)}
              placeholder={t('Auto-detect from PATH or .threadshelf/tools')}
            />
          </label>
          <label>
            <span>{t('Existing local server URL (optional)')}</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={t('http://127.0.0.1:8080')}
            />
          </label>
          <label>
            <span>{t('Model directories — one absolute path per line')}</span>
            <textarea
              value={directories}
              onChange={(event) => setDirectories(event.target.value)}
              rows={6}
            />
            <DirectoryPicker
              initialPath={directories.split(/\r?\n/).find((path) => path.trim())}
              onSelect={addDirectory}
            />
            {data?.config.llamaCpp.defaultModelDirectories.length ? (
              <small>
                {t('Also scanning ')}
                {data.config.llamaCpp.defaultModelDirectories.length}
                {t(
                  ' default or environment-provided model roots. These are not saved in this field.',
                )}
              </small>
            ) : null}
          </label>
          <div className="llama-runtime-config">
            <label>
              <span>{t('Acceleration profile')}</span>
              <select
                value={acceleration}
                onChange={(event) => setAcceleration(event.target.value as LlamaAccelerationMode)}
              >
                <option value="auto">{t('Auto-fit (recommended)')}</option>
                <option value="cpu">{t('CPU only')}</option>
                <option value="gpu">{t('Single GPU · maximum offload')}</option>
                <option value="hybrid">{t('CPU + GPU · selected layers')}</option>
                <option value="multi-gpu">{t('Multi-GPU')}</option>
              </select>
              <small>{ACCELERATION_HELP[acceleration]}</small>
            </label>
            <label>
              <span>{t('Context window')}</span>
              <NumberCombobox
                id="llamaContextSize"
                label={t('Context window in tokens')}
                value={contextSize}
                onChange={setContextSize}
                options={CONTEXT_SIZE_PRESETS}
                optionLabel={(value) =>
                  CONTEXT_SIZE_LABELS[value] ?? value.toLocaleString(useUIStore.getState().locale)
                }
                invalid={!contextSizeValid}
                title={t('Pick a preset or type any whole number from 512 to 1,048,576 tokens')}
              />
              <small>
                {contextSizeValid
                  ? t('{value0} tokens{value1}', {
                      value0: Number(contextSize).toLocaleString(useUIStore.getState().locale),
                      value1:
                        parsedContextSize > LONG_CONTEXT_TOKENS
                          ? ' · Long context: generation slows as the context fills and the KV cache needs much more VRAM. Use the Memory saver KV cache on 24 GB GPUs.'
                          : '',
                    })
                  : t('Enter a whole number from 512 to 1,048,576.')}
              </small>
            </label>
            {acceleration === 'hybrid' && (
              <label>
                <span>{t('GPU layers')}</span>
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={gpuLayers}
                  onChange={(event) => setGpuLayers(Number(event.target.value))}
                />
              </label>
            )}
            {(acceleration === 'gpu' || (acceleration === 'multi-gpu' && splitMode === 'row')) && (
              <label>
                <span>{t('Main GPU index')}</span>
                <input
                  type="number"
                  min={0}
                  max={31}
                  value={mainGpu}
                  onChange={(event) => setMainGpu(Number(event.target.value))}
                />
              </label>
            )}
            {acceleration === 'multi-gpu' && (
              <>
                <label>
                  <span>{t('Multi-GPU split')}</span>
                  <select
                    value={splitMode}
                    onChange={(event) => setSplitMode(event.target.value as LlamaSplitMode)}
                  >
                    <option value="layer">{t('Layer · balanced default')}</option>
                    <option value="row">{t('Row · parallel weights')}</option>
                  </select>
                </label>
                <label>
                  <span>{t('GPU proportions (optional)')}</span>
                  <input
                    value={tensorSplit}
                    onChange={(event) => setTensorSplit(event.target.value)}
                    placeholder={t('1,1 or 3,1')}
                  />
                </label>
              </>
            )}
            <label>
              <span>{t('CPU threads')}</span>
              <input
                type="number"
                min={-1}
                max={1024}
                value={threads}
                onChange={(event) => setThreads(Number(event.target.value))}
              />
              <small>{t('-1 lets llama.cpp choose automatically.')}</small>
            </label>
            <label>
              <span>{t('Flash Attention')}</span>
              <select
                value={flashAttention}
                onChange={(event) => setFlashAttention(event.target.value as LlamaFlashAttention)}
              >
                <option value="auto">{t('Auto (recommended)')}</option>
                <option value="on">{t('On')}</option>
                <option value="off">{t('Off')}</option>
              </select>
            </label>
            <label>
              <span>{t('KV cache')}</span>
              <select
                value={kvCache}
                onChange={(event) => setKvCache(event.target.value as LlamaKvCacheProfile)}
              >
                <option value="quality">{t('Quality · Q8 (recommended)')}</option>
                <option value="memory">{t('Memory saver · Q4')}</option>
                <option value="default">{t('Default · F16')}</option>
              </select>
              <small>{KV_CACHE_HELP[kvCache]}</small>
            </label>
            <label>
              <span>{t('Speculative decoding (MTP)')}</span>
              <select
                value={speculative}
                onChange={(event) => setSpeculative(event.target.value as LlamaSpeculativeMode)}
              >
                <option value="auto">{t('Auto · draft 2 (recommended)')}</option>
                <option value="aggressive">{t('Aggressive · draft 3')}</option>
                <option value="off">{t('Off')}</option>
              </select>
              <small>{SPECULATIVE_HELP[speculative]}</small>
            </label>
            <label>
              <span>{t('Reasoning effort')}</span>
              <select
                value={reasoningEffort}
                onChange={(event) => setReasoningEffort(event.target.value as LlamaReasoningEffort)}
              >
                <option value="medium">{t('Medium (recommended)')}</option>
                <option value="low">{t('Low')}</option>
                <option value="high">{t('High')}</option>
                <option value="xhigh">{t('XHigh · slow')}</option>
                <option value="off">{t('Off')}</option>
                <option value="default">{t('Template default')}</option>
              </select>
              <small>{REASONING_HELP[reasoningEffort]}</small>
            </label>
            <label>
              <span>{t('Unload model from memory')}</span>
              <select
                value={idleUnloadMinutes}
                onChange={(event) => setIdleUnloadMinutes(Number(event.target.value))}
              >
                {IDLE_UNLOAD_PRESETS.some(
                  (preset) => preset.minutes === idleUnloadMinutes,
                ) ? null : (
                  <option value={idleUnloadMinutes}>
                    {t('After ')}
                    {idleUnloadMinutes}
                    {t(' minutes idle')}
                  </option>
                )}
                {IDLE_UNLOAD_PRESETS.map((preset) => (
                  <option key={preset.minutes} value={preset.minutes}>
                    {preset.label}
                  </option>
                ))}
              </select>
              <small>
                {t(
                  'Frees VRAM and RAM when no chat or API request has used the model for a while. The next request loads it again.',
                )}
              </small>
            </label>
          </div>
          <div className="setup-note">
            {t('Safe discovery: ')}
            <code>npm run setup:llama</code>
            {t('. Check latest release:')} <code>npm run setup:llama -- -- --check</code>
            {t('. Nothing downloads until explicit')} <code>--install</code>
            {t(' or ')}
            <code>--url</code>
            {t(' approval.')}
            <br />
            {t('GPU profiles require a compatible build. Install explicitly with')}{' '}
            <code>--variant cuda</code>, <code>vulkan</code>, <code>rocm</code>
            {t(', or')} <code>sycl</code>
            {t('; Metal is automatic on supported Macs.')}
          </div>
          <div className="generation-actions">
            <button className="btn primary" onClick={() => setCatalogOpen(true)}>
              {t('Download a model…')}
            </button>
            <button className="btn" onClick={() => void scanModels()}>
              {t('Scan GGUF models')}
            </button>
            {models && (
              <span>
                {models.length.toLocaleString(useUIStore.getState().locale)}
                {t(' model files found')}
              </span>
            )}
          </div>
        </div>
      </div>

      <LocalApiPanel
        generationConfig={data?.config}
        guide={guide}
        onGuide={setGuide}
        draft={localApi}
        onChange={(patch) => setLocalApi((current) => ({ ...current, ...patch }))}
      />

      <div className="panel generation-panel">
        <div className="panel-head">
          <h3>{t('OpenRouter API')}</h3>
          <span className="sub">{t('external · opt-in')}</span>
        </div>
        <div className="panel-body generation-form">
          <label>
            <span>{t('Session API key (or set OPENROUTER_API_KEY in the server .env)')}</span>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                data?.config.openRouter.apiKeyConfigured
                  ? t('A key is configured')
                  : t('sk-or-v1-…')
              }
            />
          </label>
          <p className="sub">
            {t(
              'A key entered here stays in server-process memory only. A key in the gitignored .env persists across restarts. Neither value is returned by the API.',
            )}
          </p>
          <label className="check-field">
            <input
              type="checkbox"
              checked={enforceZdr}
              onChange={(event) => setEnforceZdr(event.target.checked)}
            />
            {t('Use ZDR-only routing by default (can exclude many endpoints)')}
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={denyDataCollection}
              onChange={(event) => setDenyDataCollection(event.target.checked)}
            />
            {t('Use only providers that deny data collection/training')}
          </label>
        </div>
      </div>

      <div className="panel generation-panel">
        <div className="panel-head">
          <h3>{t('Diagnostics')}</h3>
          <span className="sub">{t('local error log')}</span>
        </div>
        <div className="panel-body generation-form">
          <label className="check-field">
            <input
              type="checkbox"
              checked={persistErrorLogs}
              onChange={(event) => setPersistErrorLogs(event.target.checked)}
            />
            {t('Save generation errors to .threadshelf/generation-errors.log')}
          </label>
          <p className="sub">
            {t(
              'ThreadShelf writes provider/model errors without adding prompts, answers, or reasoning. Private tab-scoped chats are never written, regardless of this setting.',
            )}
          </p>
        </div>
      </div>

      <div className="generation-actions">
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? t('Saving…') : t('Save generation settings')}
        </button>
        {data?.providers.map((provider) => (
          <span key={provider.id} className="provider-status" data-ready={provider.available}>
            {provider.label}: {provider.available ? t('ready') : t('not configured')}
          </span>
        ))}
      </div>
      <ModelCatalogModal
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onDownloaded={() => void scanModels()}
      />
    </section>
  );
}
