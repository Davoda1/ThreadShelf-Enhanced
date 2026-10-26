import { t, useI18n, formatNumber } from '../i18n';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocalApiStatusQuery } from '../queries';
import type { GenerationConfig } from '../types';
import { copyText } from '../utils';

export type GuideTab = 'status' | 'connect' | 'settings';
type ClientId = 'claude-code' | 'codex' | 'deepseek' | 'other';
type Shell = 'powershell' | 'bash';

const TABS: readonly { readonly id: GuideTab; readonly label: string }[] = [
  {
    id: 'status',
    get label() {
      return t('What works now');
    },
  },
  {
    id: 'connect',
    get label() {
      return t('Connect an app');
    },
  },
  {
    id: 'settings',
    get label() {
      return t('Settings explained');
    },
  },
];

const CLIENTS: readonly { readonly id: ClientId; readonly label: string }[] = [
  {
    id: 'claude-code',
    get label() {
      return t('Claude Code');
    },
  },
  {
    id: 'codex',
    get label() {
      return t('Codex CLI');
    },
  },
  {
    id: 'deepseek',
    get label() {
      return t('DeepSeek Harness');
    },
  },
  {
    id: 'other',
    get label() {
      return t('Any other app');
    },
  },
];

interface GuideProps {
  /** The tab to show, or null when the guide is closed. */
  readonly tab: GuideTab | null;
  readonly onTab: (tab: GuideTab | null) => void;
  readonly config: GenerationConfig | undefined;
  /** Model id the examples use; defaults to the loaded or first model. */
  readonly model?: string;
}

/** Copyable code block. */
function Snippet({ code }: { readonly code: string }) {
  useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <pre className="guide-snippet">
      <code>{code}</code>
      <button
        type="button"
        className="btn sm ghost"
        onClick={() => {
          void copyText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {t(copied ? 'copied' : 'copy')}
      </button>
    </pre>
  );
}

function StatusRow({
  label,
  ok,
  children,
}: {
  readonly label: string;
  readonly ok: boolean | null;
  readonly children: ReactNode;
}) {
  useI18n();
  return (
    <div className="guide-status-row" data-ok={ok === null ? 'neutral' : ok}>
      <span className="guide-status-dot" aria-hidden="true" />
      <span className="guide-status-label">{label}</span>
      <span className="guide-status-value">{children}</span>
    </div>
  );
}

const idleText = (minutes: number | undefined): string => {
  if (!minutes) return t('Never. A loaded model stays in memory until another model or Eject.');
  if (minutes % 1440 === 0)
    return t('After {count} day(s) without requests.', { count: formatNumber(minutes / 1440) });
  if (minutes % 60 === 0)
    return t('After {count} hour(s) without requests.', { count: formatNumber(minutes / 60) });
  return t('After {count} minutes without requests.', { count: formatNumber(minutes) });
};

/** Environment variables differ only in syntax between shells. */
const envLines = (shell: Shell, vars: readonly (readonly [string, string])[]): string =>
  vars
    .map(([name, value]) =>
      shell === 'powershell' ? `$env:${name} = "${value}"` : `export ${name}="${value}"`,
    )
    .join('\n');

function ConnectInstructions({
  client,
  shell,
  origin,
  model,
  apiKey,
  keyRequired,
}: {
  readonly client: ClientId;
  readonly shell: Shell;
  readonly origin: string;
  readonly model: string;
  readonly apiKey: string;
  readonly keyRequired: boolean;
}) {
  useI18n();
  switch (client) {
    case 'claude-code':
      return (
        <>
          <ol className="guide-steps">
            <li>
              {t('Load a model with a long context: 32K at least, 64K is better for agents.')}
            </li>
            <li>
              {t(
                'Run these lines in the terminal where you start Claude Code. They last until you close the terminal.',
              )}
            </li>
          </ol>
          <Snippet
            code={`${envLines(shell, [
              ['ANTHROPIC_BASE_URL', origin],
              ['ANTHROPIC_AUTH_TOKEN', apiKey],
              ['ANTHROPIC_MODEL', model],
              ['ANTHROPIC_DEFAULT_HAIKU_MODEL', model],
            ])}\nclaude`}
          />
          <ul className="guide-notes">
            <li>
              {t('The base URL has ')}
              <b>{t('no')}</b> <code>/v1</code>
              {t(': Claude Code adds it and calls')} <code>/v1/messages</code>.
            </li>
            <li>
              {t('Both model variables use the ')}
              <b>{t('same')}</b>
              {t(
                ' id. ThreadShelf keeps one model in memory, so a second model for background tasks would reload models all the time.',
              )}
            </li>
            <li>
              {keyRequired
                ? t('Use your ThreadShelf API key as the token.')
                : t('No key is set in ThreadShelf, so any token works.')}
            </li>
          </ul>
        </>
      );
    case 'codex':
      return (
        <>
          <ol className="guide-steps">
            <li>
              {t('Open ')}
              <code>~/.codex/config.toml</code>
              {t(' (on Windows')} <code>%USERPROFILE%\.codex\config.toml</code>
              {t(') and add:')}
            </li>
          </ol>
          <Snippet
            code={`model = "${model}"
model_provider = "threadshelf"

[model_providers.threadshelf]
name = "ThreadShelf"
base_url = "${origin}/v1"
wire_api = "responses"${keyRequired ? '\nenv_key = "THREADSHELF_API_KEY"' : ''}`}
          />
          {keyRequired && (
            <>
              <ol className="guide-steps" start={2}>
                <li>{t('Put the key where Codex can read it, then start Codex:')}</li>
              </ol>
              <Snippet code={`${envLines(shell, [['THREADSHELF_API_KEY', apiKey]])}\ncodex`} />
            </>
          )}
          <ul className="guide-notes">
            <li>
              <code>wire_api = "responses"</code>
              {t(' is required: current Codex versions refuse to start with ')}
              <code>"chat"</code>
              {t('. ThreadShelf serves ')}
              <code>/v1/responses</code>.
            </li>
            <li>{t('Codex is an agent: give the model 32K or more of context.')}</li>
          </ul>
        </>
      );
    case 'deepseek':
      return (
        <>
          <ol className="guide-steps">
            <li>
              {t('In DeepSeek Harness open ')}
              <b>{t('Settings → Models → Add a custom provider')}</b>
              {t(' and enter the values below. Or add the same block to ')}
              <code>$DSH_HOME/settings.yaml</code>:
            </li>
          </ol>
          <Snippet
            code={`llm-pi-ai:
  providers:
    threadshelf:
      displayName: ThreadShelf
      apiKeyEnv: THREADSHELF_API_KEY
      api: openai-completions
      baseURL: ${origin}/v1
      models:
        - id: ${model}`}
          />
          <ol className="guide-steps" start={2}>
            <li>
              {t(
                'The harness reads the key from an environment variable, so set it even when ThreadShelf has no key, then start the harness from that terminal:',
              )}
            </li>
          </ol>
          <Snippet
            code={`${envLines(shell, [['THREADSHELF_API_KEY', apiKey]])}\nnpx @deepseek-ai/dsh web`}
          />
          <ul className="guide-notes">
            <li>
              {t('Pick ')}
              <b>{t('ThreadShelf')}</b>
              {t(" and the model in the session's model picker.")}
            </li>
            <li>
              {t('If your harness version names the fields differently, the values are: base URL')}{' '}
              <code>{origin}/v1</code>
              {t(', protocol OpenAI-compatible (chat completions), model id')} <code>{model}</code>.
            </li>
          </ul>
        </>
      );
    case 'other':
      return (
        <>
          <p className="guide-text">
            {t("Choose the app's ")}
            <b>{t('OpenAI-compatible')}</b>
            {t(' (or "custom OpenAI") provider, not an Ollama preset, and fill in:')}
          </p>
          <div className="guide-fields">
            <span>{t('Base URL')}</span>
            <code>{origin}/v1</code>
            <span>{t('API key')}</span>
            <code>{t(keyRequired ? 'your ThreadShelf key' : 'anything, e.g. threadshelf')}</code>
            <span>{t('Model')}</span>
            <code>{model}</code>
          </div>
          <p className="guide-text">
            {t('Apps built on the Anthropic SDK use the base URL ')}
            <code>{origin}</code>
            {t(', without')} <code>/v1</code>.
          </p>
          <ul className="guide-notes">
            <li>
              {t('An app in Docker, a VM or on another device cannot reach this address. Turn on')}{' '}
              <b>{t('Serve on the local network')}</b>
              {t(' and use the network URL instead.')}
            </li>
            <li>
              {t(
                'A "connection refused" error means ThreadShelf is not running; 401 means the key is wrong; 403 means the app is not on this computer (or the API is off).',
              )}
            </li>
          </ul>
        </>
      );
  }
}

const SETTINGS_HELP: readonly {
  readonly group: string;
  readonly items: readonly {
    readonly name: string;
    readonly what: string;
    readonly pick: string;
  }[];
}[] = [
  {
    get group() {
      return t('Local model API');
    },
    items: [
      {
        get name() {
          return t('Serve the local model API');
        },
        get what() {
          return t(
            'Lets other programs on this computer use your models through the /v1 address, like LM Studio or Ollama.',
          );
        },
        get pick() {
          return t('Leave on. Turn off if you never use other apps with ThreadShelf models.');
        },
      },
      {
        get name() {
          return t('API key');
        },
        get what() {
          return t(
            'A password other apps must send. Empty means no password: any program on this computer may use the models.',
          );
        },
        get pick() {
          return t(
            'Leave empty for use on this computer. Set one (Generate) when an app insists on a key or other devices connect.',
          );
        },
      },
      {
        get name() {
          return t('Serve on the local network');
        },
        get what() {
          return t(
            'Opens a second port so phones, laptops or Docker containers can use your models. Only the model API is shared, never your archive.',
          );
        },
        get pick() {
          return t('Off unless another device needs it. When on, also set an API key.');
        },
      },
      {
        get name() {
          return t('Network port');
        },
        get what() {
          return t('The port other devices connect to, e.g. http://192.168.1.50:3001/v1.');
        },
        get pick() {
          return t('3001, unless something else already uses it.');
        },
      },
    ],
  },
  {
    get group() {
      return t('Memory');
    },
    items: [
      {
        get name() {
          return t('Unload model from memory');
        },
        get what() {
          return t(
            'Frees the GPU memory (VRAM) once nobody has used the model for this long. The next message loads it again, which takes a few seconds to a minute.',
          );
        },
        get pick() {
          return t(
            'Never if the computer is only for AI. 15–30 minutes if you also game or edit video on the same GPU.',
          );
        },
      },
      {
        get name() {
          return t('Eject');
        },
        get what() {
          return t('Unloads the model right now. Same as POST /v1/models/unload.');
        },
        get pick() {
          return t('Use before starting a game or another GPU-heavy program.');
        },
      },
    ],
  },
  {
    get group() {
      return t('llama.cpp model settings');
    },
    items: [
      {
        get name() {
          return t('Context window');
        },
        get what() {
          return t(
            'How much text the model can keep in mind at once: the conversation, files an agent reads, and the answer. Bigger needs more VRAM and gets slower as it fills.',
          );
        },
        get pick() {
          return t(
            '32K on a 24 GB GPU. 64K for coding agents (with the Memory saver KV cache). 8–16K on smaller GPUs.',
          );
        },
      },
      {
        get name() {
          return t('KV cache');
        },
        get what() {
          return t(
            'How precisely that context is stored. Q8 is near lossless; Q4 uses half the memory so a longer context fits.',
          );
        },
        get pick() {
          return t('Quality · Q8. Memory saver · Q4 for 64K and more.');
        },
      },
      {
        get name() {
          return t('Acceleration profile');
        },
        get what() {
          return t(
            'Where the model runs. Layers that do not fit on the GPU run on the much slower CPU.',
          );
        },
        get pick() {
          return t('Auto-fit. Change only if the runtime log shows a problem.');
        },
      },
      {
        get name() {
          return t('Flash Attention');
        },
        get what() {
          return t(
            'A faster way to compute attention that also saves memory. Needed for the Q8/Q4 KV cache.',
          );
        },
        get pick() {
          return t('Auto.');
        },
      },
      {
        get name() {
          return t('Speculative decoding (MTP)');
        },
        get what() {
          return t(
            'Lets the model guess a few words ahead with its own built-in helper and check them in one step. Same answers, faster. Only models with an MTP head (e.g. Qwen 3.8) use it.',
          );
        },
        get pick() {
          return t(
            'Auto · draft 2. In tests Qwen 3.8 went from 44 to 72–76 tokens per second; it turns itself off for models without an MTP head.',
          );
        },
      },
      {
        get name() {
          return t('Reasoning effort');
        },
        get what() {
          return t(
            'How long thinking models think before answering. Thinking is written text too, so it takes time.',
          );
        },
        get pick() {
          return t('Medium. Low or Off for quick questions.');
        },
      },
      {
        get name() {
          return t('CPU threads');
        },
        get what() {
          return t('CPU cores used for the parts that run on the CPU.');
        },
        get pick() {
          return t('-1 (automatic).');
        },
      },
      {
        get name() {
          return t('Existing local server URL');
        },
        get what() {
          return t(
            'Use a llama-server you started yourself instead of the one ThreadShelf manages, e.g. for a draft model or vision.',
          );
        },
        get pick() {
          return t('Empty, unless you know you need it.');
        },
      },
    ],
  },
];

/** Plain-language help for the local model API: status, client setup, settings. */
export function LocalApiGuide({ tab, onTab, config, model: chosenModel }: GuideProps) {
  useI18n();
  const { data: status } = useLocalApiStatusQuery();
  const open = tab !== null;
  const onClose = useCallback(() => onTab(null), [onTab]);
  const [client, setClient] = useState<ClientId>('claude-code');
  const [shell, setShell] = useState<Shell>(() =>
    /windows/i.test(navigator.userAgent) ? 'powershell' : 'bash',
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    },
    [onClose],
  );
  useEffect(() => {
    if (!open) return;
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onKeyDown]);

  if (!open) return null;

  const api = config?.localApi;
  const enabled = api?.enabled ?? true;
  const keyRequired = Boolean(api?.apiKeyConfigured);
  const origin = window.location.origin;
  const models = status?.models ?? [];
  const loaded = models.find((model) => model.loaded);
  const model = chosenModel ?? loaded?.id ?? models[0]?.id ?? 'your-model-id';
  const key = keyRequired ? 'YOUR_THREADSHELF_KEY' : 'threadshelf';
  const network = status?.network;
  const external = config?.llamaCpp.baseUrl;

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="modal-card guide-modal"
        role="dialog"
        aria-label={t('Local model API guide')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head guide-head">
          <div>
            <h3>{t('Local model API guide')}</h3>
            <p>{t('Use the models in ThreadShelf from coding agents and other apps.')}</p>
          </div>
          <button type="button" className="btn sm ghost" onClick={onClose} aria-label={t('Close')}>
            {t('Close')}
          </button>
        </div>

        <div className="local-api-tabs guide-tabs" role="tablist">
          {TABS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={tab === option.id}
              data-active={tab === option.id}
              onClick={() => onTab(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="guide-body">
          {tab === 'status' && (
            <>
              <div className="guide-status">
                <StatusRow label={t('API')} ok={enabled}>
                  {enabled
                    ? t('On at {value0}/v1', { value0: origin })
                    : t('Off. Apps get "403 api_disabled". Turn it on in Local model API.')}
                </StatusRow>
                <StatusRow label={t('Who can use it')} ok={null}>
                  {network?.state === 'listening'
                    ? t('This computer, and other devices at {value0}', {
                        value0: network.urls.join(', ') || `port ${network.port}`,
                      })
                    : t('Only programs on this computer.')}
                </StatusRow>
                <StatusRow label={t('API key')} ok={null}>
                  {api?.apiKeySource === 'env'
                    ? t('Required. Set by THREADSHELF_API_KEY.')
                    : keyRequired
                      ? t('Required. Apps must send the key you saved.')
                      : t('Not required. Apps may send any key, or none.')}
                </StatusRow>
                {network?.state === 'error' && (
                  <StatusRow label={t('Network port')} ok={false}>
                    {network.error}
                  </StatusRow>
                )}
                <StatusRow label={t('Model in memory')} ok={null}>
                  {loaded
                    ? t('{value0}. Requests for it answer right away.', { value0: loaded.id })
                    : t('None. The first request loads the model it names.')}
                </StatusRow>
                <StatusRow label={t('Unload when idle')} ok={null}>
                  {idleText(config?.llamaCpp.idleUnloadMinutes)}
                </StatusRow>
                <StatusRow label={t('Engine')} ok={null}>
                  {external
                    ? t('Your own llama-server at {value0}.', { value0: external })
                    : t('llama.cpp managed by ThreadShelf, one model at a time.')}
                </StatusRow>
                <StatusRow label={t('Models available')} ok={models.length > 0}>
                  {models.length > 0
                    ? `${models.length}: ${models
                        .slice(0, 4)
                        .map((entry) => entry.id)
                        .join(', ')}${models.length > 4 ? ', …' : ''}`
                    : (status?.modelsError ?? t('None yet. Download one in Settings.'))}
                </StatusRow>
              </div>

              <h4 className="guide-subhead">{t('What the API can do')}</h4>
              <table className="guide-table">
                <tbody>
                  <tr>
                    <td>
                      <code>GET /v1/models</code>
                    </td>
                    <td>{t('List your models; the loaded one has "loaded": true.')}</td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/chat/completions</code>
                    </td>
                    <td>{t('Chat, OpenAI style. Used by most apps.')}</td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/responses</code>
                    </td>
                    <td>{t('OpenAI Responses API. Used by Codex.')}</td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/messages</code>
                    </td>
                    <td>{t('Chat, Anthropic style. Used by Claude Code.')}</td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/completions</code>
                    </td>
                    <td>{t('Plain text completion (older apps).')}</td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/models/unload</code>
                    </td>
                    <td>{t('Free the GPU memory now.')}</td>
                  </tr>
                </tbody>
              </table>
              <p className="guide-text">
                {t(
                  "Streaming, tool calls and JSON output work as llama.cpp supports them. Not available: embeddings, images, audio and Ollama's own ",
                )}
                <code>/api</code>
                {t(' routes. Requests from apps are never saved to your archive.')}
              </p>
              <p className="guide-text">
                <b>{t('One model at a time.')}</b>
                {t(
                  ' Asking for another model swaps it in, freeing the old one\'s memory first. While one model is answering, a request for a different model gets "503 model_busy" and apps retry.',
                )}
              </p>
            </>
          )}

          {tab === 'connect' && (
            <>
              <div className="guide-pickers">
                <div className="local-api-tabs" role="tablist" aria-label={t('App')}>
                  {CLIENTS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="tab"
                      aria-selected={client === option.id}
                      data-active={client === option.id}
                      onClick={() => setClient(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {client !== 'other' && (
                  <div className="local-api-tabs" role="tablist" aria-label={t('Shell')}>
                    {(['powershell', 'bash'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="tab"
                        aria-selected={shell === option}
                        data-active={shell === option}
                        onClick={() => setShell(option)}
                      >
                        {option === 'powershell' ? t('Windows PowerShell') : t('macOS / Linux')}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {!enabled && (
                <div className="banner warn">
                  {t('The API is off. Turn it on before connecting.')}
                </div>
              )}
              <p className="guide-text">
                {t('Filled in with ')}
                <code>{model}</code>
                {loaded?.id === model ? t(' (loaded now)') : ''}
                {t('. Pick another model id in the Local model API panel to change the examples.')}
              </p>
              <ConnectInstructions
                client={client}
                shell={shell}
                origin={origin}
                model={model}
                apiKey={key}
                keyRequired={keyRequired}
              />
            </>
          )}

          {tab === 'settings' &&
            SETTINGS_HELP.map((section) => (
              <section key={section.group} className="guide-settings">
                <h4 className="guide-subhead">{section.group}</h4>
                <dl>
                  {section.items.map((item) => (
                    <div key={item.name} className="guide-setting">
                      <dt>{item.name}</dt>
                      <dd>
                        {item.what}
                        <span className="guide-pick">
                          {t('If unsure: ')}
                          {item.pick}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
        </div>
      </div>
    </div>
  );
}
