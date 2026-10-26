import { useUIStore } from '../store';
import { LOCALES, localeNames, useI18n, type Locale } from '../i18n';

export function AppearanceSettings() {
  const { t, locale } = useI18n();
  const imageLoadMode = useUIStore((state) => state.imageLoadMode);
  const setImageLoadMode = useUIStore((state) => state.setImageLoadMode);
  const setLocale = useUIStore((state) => state.setLocale);
  const richRendering = useUIStore((state) => state.richRendering);
  const setRichRendering = useUIStore((state) => state.setRichRendering);
  return (
    <section className="panel appearance-settings" aria-labelledby="appearance-heading">
      <div className="panel-head">
        <h2 id="appearance-heading">{t('Appearance and language')}</h2>
      </div>
      <div className="panel-body">
        <label className="field-label" htmlFor="interface-language">
          {t('Interface language')}
        </label>
        <select
          id="interface-language"
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          {LOCALES.map((language) => (
            <option key={language} value={language} lang={language}>
              {localeNames[language]}
            </option>
          ))}
        </select>
        <p className="muted">
          {t(
            'Only the interface language changes. Your conversations stay in their original language.',
          )}
        </p>
        <label className="field-label" htmlFor="image-load-mode">
          {t('External images')}
        </label>
        <select
          id="image-load-mode"
          value={imageLoadMode}
          onChange={(event) => setImageLoadMode(event.target.value === 'auto' ? 'auto' : 'click')}
        >
          <option value="click">{t('Click to load')}</option>
          <option value="auto">{t('Load automatically')}</option>
        </select>
        <p className="muted">
          {t(
            'Images open inside the conversation. Loading an external image contacts its source website.',
          )}
        </p>
        <fieldset>
          <legend>{t('Full rich rendering')}</legend>
          <p className="muted" id="rich-rendering-help">
            {t(
              'When off, basic Markdown still formats emphasis, underline, lists, links, code and tables. Advanced math, diagrams and rich widgets remain readable as source.',
            )}
          </p>
          {(['user', 'thinking', 'ai'] as const).map((role) => (
            <div key={role} className="render-setting">
              <span id={`rich-rendering-${role}-label`}>
                {t({ user: 'User prompts', thinking: 'Thinking', ai: 'Responses' }[role])}
              </span>
              <button
                type="button"
                className="render-switch"
                id={`rich-rendering-${role}`}
                role="switch"
                aria-checked={richRendering[role]}
                aria-labelledby={`rich-rendering-${role}-label`}
                aria-describedby="rich-rendering-help"
                onClick={() => setRichRendering(role, !richRendering[role])}
              >
                <span className="render-switch-track" aria-hidden="true">
                  <span className="render-switch-knob" />
                </span>
                <span className="render-switch-state" aria-hidden="true">
                  {t(richRendering[role] ? 'On' : 'Off')}
                </span>
              </button>
            </div>
          ))}
          <p className="muted">
            {t(
              'These settings control formatting. Use the existing message filters to show or hide content.',
            )}
          </p>
        </fieldset>
      </div>
    </section>
  );
}
