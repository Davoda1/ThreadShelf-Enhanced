import { useState } from 'react';
import { useTts } from './runtime';
import { invokeTts, setSpeechAccessKey, setLocalSpeechChoice } from './transport';
import type { AssetsStatus } from './types';
import { t } from '../i18n';
import { NativeSelect } from '../components/NativeSelect';
const voices = {
  pocket: ['alba', 'marius', 'javert', 'anna', 'charles', 'vera'],
  kokoro: [
    'af_heart',
    'af_alloy',
    'af_aoede',
    'af_bella',
    'af_jessica',
    'af_kore',
    'af_nicole',
    'af_nova',
    'af_river',
    'af_sarah',
    'af_sky',
    'am_adam',
    'am_echo',
    'am_eric',
    'am_fenrir',
    'am_liam',
    'am_michael',
    'am_onyx',
    'am_puck',
    'am_santa',
    'bf_alice',
    'bf_emma',
    'bf_isabella',
    'bf_lily',
    'bm_daniel',
    'bm_fable',
    'bm_george',
    'bm_lewis',
  ],
};
export function NetworkSpeechSettings({ assets }: { readonly assets: AssetsStatus | null }) {
  const speech = useTts();
  const [key, setKey] = useState(''),
    [status, setStatus] = useState(''),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false);
  const provider = speech.config.provider === 'kokoro' ? 'kokoro' : 'pocket';
  const choose = (
    engine: 'pocket' | 'kokoro',
    voice: string,
    streaming = speech.config.streamingEnabled,
  ) => {
    setLocalSpeechChoice(engine, voice, streaming);
    speech.setConfig({ ...speech.config, provider: engine, voice, streamingEnabled: streaming });
  };
  const connect = async () => {
    setBusy(true);
    setError(false);
    setSpeechAccessKey(key);
    try {
      await invokeTts('tts.availability', { messages: [], private: true });
      setKey('');
      setStatus(t('Speech access is ready for this tab. The key stays only in browser memory.'));
    } catch (cause) {
      setSpeechAccessKey('');
      setError(true);
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="tts-network-panel">
      <h3>{t('Speech from this server')}</h3>
      <p className="tts-help">
        {t(
          'Restricted LAN playback uses installed CPU voices without saving text or audio. Full settings require localhost or ALLOW_LAN_TTS=1.',
        )}
      </p>
      {!speech.config.enabled || !speech.config.access?.networkPlaybackEnabled ? (
        <div className="banner" role="status">
          {t(
            'For headless setup, set ALLOW_LAN_TTS=1 in the server .env and restart. Otherwise enable speech and authenticated LAN speech from localhost.',
          )}
        </div>
      ) : (
        <>
          <label htmlFor="tts-network-key">{t('Server API key')}</label>
          <input
            id="tts-network-key"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={t('Used only in this browser tab')}
          />
          <div className="tts-install-actions">
            <button
              className="btn primary"
              type="button"
              disabled={busy || !key.trim()}
              onClick={() => void connect()}
            >
              <span className="stable-label">
                <span>{busy ? t('Checking…') : t('Connect speech')}</span>
                <span className="stable-label-size" aria-hidden="true">
                  {t('Checking…')}
                </span>
                <span className="stable-label-size" aria-hidden="true">
                  {t('Connect speech')}
                </span>
              </span>
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                speech.stop(true);
                setSpeechAccessKey('');
                setKey('');
                setError(false);
                setStatus(t('Access key forgotten for this tab.'));
              }}
            >
              {t('Forget key')}
            </button>
          </div>
          <div className="tts-network-fields">
            <label>
              {t('Local engine')}
              <NativeSelect
                value={provider}
                onChange={(event) => {
                  const engine = event.target.value as 'pocket' | 'kokoro';
                  choose(engine, engine === 'pocket' ? 'alba' : 'am_michael');
                }}
              >
                {(['pocket', 'kokoro'] as const).map((engine) => (
                  <option
                    key={engine}
                    value={engine}
                    disabled={!assets?.engines[engine]?.installed}
                  >
                    {engine === 'pocket' ? 'Pocket TTS' : 'Kokoro'}
                    {assets?.engines[engine]?.installed ? '' : ` · ${t('Not installed')}`}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              {t('Voice')}
              <NativeSelect
                value={speech.config.voice}
                onChange={(event) => choose(provider, event.target.value)}
              >
                {voices[provider].map((voice) => (
                  <option value={voice} key={voice}>
                    {voice}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </div>
          <label className="tts-network-stream">
            <input
              type="checkbox"
              checked={speech.config.streamingEnabled}
              onChange={(event) => choose(provider, speech.config.voice, event.target.checked)}
            />
            {t('Stream audio as it arrives')}
          </label>
        </>
      )}
      {status && (
        <p role={error ? 'alert' : 'status'} className={error ? 'tts-error' : 'tts-help'}>
          {t(status)}
        </p>
      )}
    </section>
  );
}
