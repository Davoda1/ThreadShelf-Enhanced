import type { CSSProperties } from 'react';
import type { ConversationDisplayPreferences } from '../display-preferences';
import { useI18n } from '../i18n';
import { useUIStore } from '../store';

const JSON_VISIBILITY = [
  { value: 'show-all', label: 'Show all' },
  { value: 'hide-empty', label: 'Hide empty' },
  { value: 'hide-all', label: 'Hide all' },
] as const;

type ToggleKey = Exclude<keyof ConversationDisplayPreferences, 'jsonVisibility'>;

function DisplayToggle({
  setting,
  label,
  description,
}: {
  readonly setting: ToggleKey;
  readonly label: string;
  readonly description: string;
}) {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.conversationDisplay[setting]);
  const setConversationDisplay = useUIStore((state) => state.setConversationDisplay);
  const id = `conversation-display-${setting}`;
  return (
    <div className="conversation-display-option">
      <div className="render-setting">
        <span id={`${id}-label`}>{t(label)}</span>
        <button
          id={id}
          type="button"
          className="render-switch"
          role="switch"
          aria-checked={enabled}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-help`}
          onClick={() => setConversationDisplay({ [setting]: !enabled })}
        >
          <span className="render-switch-track" aria-hidden="true">
            <span className="render-switch-knob" />
          </span>
          <span className="render-switch-state" aria-hidden="true">
            {t(enabled ? 'On' : 'Off')}
          </span>
        </button>
      </div>
      <p className="muted conversation-display-help" id={`${id}-help`}>
        {t(description)}
      </p>
    </div>
  );
}

export function ConversationDisplaySettings() {
  const { t } = useI18n();
  const visibility = useUIStore((state) => state.conversationDisplay.jsonVisibility);
  const setConversationDisplay = useUIStore((state) => state.setConversationDisplay);
  const selected = JSON_VISIBILITY.findIndex((choice) => choice.value === visibility);
  return (
    <section
      className="panel conversation-display-settings"
      aria-labelledby="conversation-display-heading"
    >
      <div className="panel-head">
        <h2 id="conversation-display-heading">{t('Conversation display')}</h2>
      </div>
      <div className="panel-body">
        <p className="muted conversation-display-help">
          {t('Changes apply immediately and are saved for this browser.')}
        </p>
        <fieldset>
          <legend>{t('JSON-only responses')}</legend>
          <label className="field-label" htmlFor="conversation-display-jsonVisibility">
            {t('Response visibility')}
          </label>
          <div
            className="conversation-visibility-control"
            style={{ '--conversation-visibility-position': `${selected * 50}%` } as CSSProperties}
          >
            <div className="conversation-visibility-rail" aria-hidden="true">
              {JSON_VISIBILITY.map((choice, index) => (
                <span
                  key={choice.value}
                  className="conversation-visibility-stop"
                  style={{ left: `${index * 50}%` }}
                />
              ))}
              <span className="conversation-visibility-marker" />
            </div>
            <input
              id="conversation-display-jsonVisibility"
              type="range"
              min="0"
              max="2"
              step="1"
              value={selected}
              aria-valuetext={t(JSON_VISIBILITY[selected]!.label)}
              aria-describedby="conversation-display-jsonVisibility-help"
              onChange={(event) =>
                setConversationDisplay({
                  jsonVisibility: JSON_VISIBILITY[Number(event.currentTarget.value)]!.value,
                })
              }
            />
            <div className="conversation-visibility-labels" aria-hidden="true">
              {JSON_VISIBILITY.map((choice) => (
                <span key={choice.value} data-selected={visibility === choice.value}>
                  {t(choice.label)}
                </span>
              ))}
            </div>
          </div>
          <p
            className="muted conversation-display-help"
            id="conversation-display-jsonVisibility-help"
          >
            {t(
              'Hide empty hides recognized empty AI export metadata. Other JSON results, including zero and false, stay visible. Stored messages and exports stay unchanged.',
            )}
          </p>
          <DisplayToggle
            setting="jsonAsCode"
            label="Render JSON as code"
            description="Show visible JSON-only AI responses in a JSON code block. Turn off to keep their original formatting."
          />
        </fieldset>
        <fieldset>
          <legend>{t('Code blocks')}</legend>
          <DisplayToggle
            setting="codeDownloads"
            label="Show code download button"
            description="Download each code block as a file. Known languages use their file extension; plain text and unknown languages use .txt."
          />
          <DisplayToggle
            setting="codeWrap"
            label="Wrap long code lines"
            description="When off, wide code blocks scroll horizontally. When on, long lines wrap inside the code block."
          />
          <DisplayToggle
            setting="codeLineNumbers"
            label="Show code line numbers"
            description="Line numbers are only a reading aid. They are never included in copied code, downloaded files or conversation exports."
          />
        </fieldset>
      </div>
    </section>
  );
}
