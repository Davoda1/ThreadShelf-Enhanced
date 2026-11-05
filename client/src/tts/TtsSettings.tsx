import { useCallback, useEffect, useRef, useState } from 'react';
import { controller, ensureTts, useTts } from './runtime';
import { ttsRequest, ttsStream } from './transport';
import type { AssetsPlan, AssetsStatus, InstallProgress } from './types';
import { confirmDialog, toast } from '../toast';
import { t, useI18n } from '../i18n';
import { NetworkSpeechSettings } from './NetworkSpeechSettings';

const bytes = (value: number) => `${(value / 1024 ** 2).toFixed(1)} MiB`;
const label = (engine: string) => (engine === 'pocket' ? 'Pocket TTS · 100M' : 'Kokoro · 82M');
export function TtsSettings({ active = true }: { readonly active?: boolean }) {
  const { locale } = useI18n();
  const speech = useTts(),
    form = useRef<HTMLDivElement>(null),
    install = useRef<AbortController | null>(null),
    mounted = useRef(false),
    refreshSerial = useRef(0),
    previousActive = useRef(active);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [assetError, setAssetError] = useState(''),
    [saving, setSaving] = useState(false);
  const [assets, setAssets] = useState<AssetsStatus | null>(null),
    [selected, setSelected] = useState<('pocket' | 'kokoro')[]>(['pocket', 'kokoro']);
  const [plan, setPlan] = useState<AssetsPlan | null>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<InstallProgress | null>(null),
    [installing, setInstalling] = useState(false);
  const applyAssets = useCallback((status: AssetsStatus | null, failure = '') => {
    if (!mounted.current) return;
    setAssets(status);
    setAssetError(failure);
    controller.setLocalAssets(status, !!failure);
  }, []);
  const refresh = useCallback(async () => {
    const serial = ++refreshSerial.current;
    if (mounted.current) controller.setLocalAssets(null);
    try {
      const status = await ttsRequest<AssetsStatus>('/assets');
      if (serial === refreshSerial.current) applyAssets(status);
      return status;
    } catch (cause) {
      if (serial === refreshSerial.current)
        applyAssets(null, cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }, [applyAssets]);
  useEffect(() => {
    let alive = true;
    mounted.current = true;
    controller.setLocalAssets(null);
    void ensureTts()
      .then(() => {
        if (!alive) return;
        if (controller.config.access?.canManage === false) {
          setReady(true);
          return;
        }
        if (!form.current) return;
        form.current.innerHTML = controller.settingsHTML();
        controller.bindSettings(form.current);
        setReady(true);
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    const refreshAssets = () => {
      void refresh().catch(() => undefined);
    };
    refreshAssets();
    window.addEventListener('focus', refreshAssets);
    return () => {
      alive = false;
      mounted.current = false;
      window.removeEventListener('focus', refreshAssets);
      install.current?.abort();
      controller.cancelSettings();
    };
  }, [refresh]);
  useEffect(() => {
    if (!active) controller.disposeTest();
    else if (!previousActive.current) void refresh().catch(() => undefined);
    previousActive.current = active;
  }, [active, refresh]);
  useEffect(() => {
    controller.localize();
  }, [locale]);
  if (speech.config.access?.canManage === false)
    return (
      <div className="tts-settings-shell">
        <NetworkSpeechSettings assets={assets} />
      </div>
    );
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await controller.saveSettings();
      if (!controller.config.enabled) install.current?.abort();
      toast.success(t('Text-to-Speech settings saved.'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const review = async () => {
    setBusy(true);
    setError('');
    setProgress(null);
    try {
      setPlan(await ttsRequest<AssetsPlan>('/assets/plan', { engines: selected }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    if (!plan) return;
    const abort = new AbortController();
    install.current = abort;
    setInstalling(true);
    setBusy(true);
    setError('');
    setProgress({ state: 'preparing' });
    refreshSerial.current++;
    controller.setLocalAssets(null);
    try {
      await ttsStream<AssetsStatus>(
        '/assets/install',
        { engines: plan.requestedEngines ?? plan.engines, fingerprint: plan.fingerprint },
        (event) => setProgress(event as InstallProgress),
        abort.signal,
      );
      await refresh();
      setPlan(null);
      setProgress({ state: 'ready' });
      toast.success(t('Local voices are installed and verified.'));
    } catch (cause) {
      const cancelled = abort.signal.aborted;
      setProgress({ state: cancelled ? 'cancelled' : 'failed' });
      setError(
        cancelled
          ? t(
              'Download cancelled. Verified partial downloads can resume after reviewing the plan again.',
            )
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
      await refresh().catch(() => undefined);
    } finally {
      if (install.current === abort) install.current = null;
      setInstalling(false);
      setBusy(false);
    }
  };
  const remove = async (engine: 'pocket' | 'kokoro') => {
    const approved = await confirmDialog({
      title: t('Remove {engine}?', { engine: label(engine) }),
      message: t(
        'Remove this local voice pack. Your speech preferences and saved audio are kept. The other engine remains available.',
      ),
      confirmLabel: t('Remove'),
      danger: true,
    });
    if (!approved) return;
    setBusy(true);
    setError('');
    try {
      refreshSerial.current++;
      controller.setLocalAssets(null);
      const status = await ttsRequest<AssetsStatus>('/assets/uninstall', { engines: [engine] });
      refreshSerial.current++;
      applyAssets(status);
      setPlan(null);
      toast.success(t('Local voice pack removed.'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tts-settings-shell">
      <p className="settings-description">
        {t(
          'Listen with local CPU voices or an API provider. Speech is off by default; enabling it does not download anything.',
        )}
      </p>
      {(error || assetError) && (
        <div className="banner error" role="alert">
          {error || assetError}
        </div>
      )}
      <div ref={form} className="tts-settings-mount" />
      {!ready && !error && <p role="status">{t('Loading speech settings…')}</p>}
      <div className="tts-save-row">
        <button
          type="button"
          className="btn primary"
          disabled={!ready || saving}
          onClick={() => void save()}
        >
          <span className="stable-label">
            <span>{saving ? t('Saving…') : t('Save speech settings')}</span>
            <span className="stable-label-size" aria-hidden="true">
              {t('Saving…')}
            </span>
            <span className="stable-label-size" aria-hidden="true">
              {t('Save speech settings')}
            </span>
          </span>
        </button>
        <span className="tts-help">
          {t('Streaming can be turned on or off independently. Settings apply when saved.')}
        </span>
      </div>
      {speech.config.enabled && (
        <section
          className="tts-assets settings-section"
          aria-labelledby="ttsLocalVoicesTitle"
          hidden={speech.subtab !== 'providers'}
        >
          <header>
            <h3 id="ttsLocalVoicesTitle">{t('Local voices')}</h3>
            <span
              className="tts-status-chip"
              data-state={assets?.supported ? 'local' : 'unavailable'}
            >
              {assets?.platform ?? t('Checking…')}
            </span>
          </header>
          <p>
            {t(
              'Download only the voices you want, including their local runtimes. After installation, local speech runs without an internet connection. Both current packs speak English.',
            )}
          </p>
          {assets && !assets.supported && (
            <div className="banner" role="status">
              {t(
                'Local voice packs are not available for this server platform. API providers remain available.',
              )}
            </div>
          )}
          <div className="tts-engine-grid">
            {(['pocket', 'kokoro'] as const).map((engine) => (
              <div className="tts-engine-card" key={engine}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(engine)}
                    disabled={busy || assets?.supported === false}
                    onChange={(event) => {
                      setSelected((value) =>
                        event.target.checked
                          ? [...value, engine]
                          : value.filter((id) => id !== engine),
                      );
                      setPlan(null);
                    }}
                  />
                  <span>
                    <strong>{label(engine)}</strong>
                    <small>
                      {engine === 'pocket'
                        ? t('Six preset voices · natural speech')
                        : t('28 US / UK voices · full precision')}
                    </small>
                  </span>
                </label>
                <div className="tts-engine-actions">
                  <span
                    className="tts-status-chip"
                    data-state={assets?.engines?.[engine]?.installed ? 'ready' : 'missing'}
                  >
                    {assets?.engines?.[engine]?.installed ? t('Installed') : t('Not installed')}
                  </span>
                  {assets?.engines?.[engine]?.installed && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={busy}
                      onClick={() => void remove(engine)}
                    >
                      {t('Remove')}
                    </button>
                  )}
                </div>
                {assets?.engines?.[engine]?.error && (
                  <p className="tts-error">{assets.engines[engine].error}</p>
                )}
              </div>
            ))}
          </div>
          <div className="tts-install-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !selected.length || assets?.supported !== true}
              onClick={() => void review()}
            >
              <span className="stable-label">
                <span>
                  {busy && !installing ? t('Checking…') : t('Download / repair local voices')}
                </span>
                <span className="stable-label-size" aria-hidden="true">
                  {t('Checking…')}
                </span>
                <span className="stable-label-size" aria-hidden="true">
                  {t('Download / repair local voices')}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void refresh().catch(() => undefined)}
            >
              {t('Refresh status')}
            </button>
          </div>
          {plan && (
            <div
              className="tts-install-review"
              role="region"
              aria-label={t('Review local voice download')}
            >
              <h4>{t('Review download')}</h4>
              <p>
                {plan.engines.map(label).join(' + ')} · {plan.platform}
              </p>
              <dl>
                <div>
                  <dt>{t('Download')}</dt>
                  <dd>{bytes(plan.downloadBytes)}</dd>
                </div>
                <div>
                  <dt>{t('Estimated free space required')}</dt>
                  <dd>{bytes(plan.requiredFreeBytes)}</dd>
                </div>
              </dl>
              <p className="tts-help">
                {t(
                  'Models, runtimes and license notices install in the server’s personal data directory. Existing working files stay usable until verification succeeds.',
                )}
              </p>
              {plan.licenses?.length ? (
                <p className="tts-help">
                  {t('Licenses')}:{' '}
                  {plan.licenses
                    .map((item) =>
                      typeof item === 'string'
                        ? item
                        : (item.name ?? item.license ?? 'Included notice'),
                    )
                    .join(' · ')}
                </p>
              ) : null}
              <details>
                <summary>
                  {t('Included files')} ({plan.files.length})
                </summary>
                <ul>
                  {plan.files.map((file) => (
                    <li key={file.name}>
                      <span>{file.name}</span>
                      <span>{file.cached ? t('Verified locally') : bytes(file.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </details>
              <div className="tts-install-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !speech.config.enabled}
                  onClick={() => void download()}
                >
                  {t('Download and install')}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => setPlan(null)}>
                  {t('Close review')}
                </button>
              </div>
            </div>
          )}
          {progress && (
            <div
              className="tts-install-progress"
              role="status"
              aria-live="polite"
              data-state={progress.state}
            >
              <strong>
                {progress.state === 'ready'
                  ? t('Ready')
                  : progress.state === 'failed'
                    ? t('Installation failed')
                    : progress.state === 'cancelled'
                      ? t('Cancelled')
                      : progress.state === 'verifying'
                        ? t('Verifying files…')
                        : progress.state === 'installing'
                          ? t('Installing…')
                          : t('Downloading…')}
              </strong>
              {busy && (
                <progress
                  max={progress.totalBytes || undefined}
                  value={progress.totalBytes ? (progress.downloadedBytes ?? 0) : undefined}
                  aria-label={t('Local voice installation progress')}
                />
              )}
              {progress.totalBytes ? (
                <span>
                  {bytes(progress.downloadedBytes ?? 0)} / {bytes(progress.totalBytes)}
                </span>
              ) : null}
              {progress.file && <span className="tts-help">{progress.file}</span>}
              {installing && (
                <button type="button" className="btn" onClick={() => install.current?.abort()}>
                  {t('Cancel download')}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
