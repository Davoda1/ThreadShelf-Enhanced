import { useEffect, useRef, useState } from 'react';
import { useTts, setSpeechContext } from './runtime';
import { extractSpeech, fingerprint } from './speech';
import { toast } from '../toast';
import { t } from '../i18n';

interface Props {
  readonly text: string;
  readonly sourceId: string;
  readonly messageId: string;
  readonly role: 'user' | 'thinking' | 'ai';
  readonly label?: string;
  readonly private?: boolean;
}
export function ReadAloud({
  text,
  sourceId,
  messageId,
  role,
  label,
  private: privateChat = false,
}: Props) {
  const speech = useTts();
  const [preparing, setPreparing] = useState(false);
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [text, sourceId, messageId],
  );
  if (
    !speech.config.enabled ||
    (speech.config.access?.canManage === false && !speech.config.access.networkPlaybackEnabled) ||
    (role === 'thinking' && !speech.config.includeThinking) ||
    !text.trim()
  )
    return null;
  const active = speech.active?.sourceId === sourceId && speech.active?.messageId === messageId;
  const read = async () => {
    const own = ++attempt.current;
    setPreparing(true);
    try {
      const config = speech.config;
      const spoken = extractSpeech(text, config);
      const proof = await fingerprint(text);
      if (own !== attempt.current || speech.config !== config || !speech.config.enabled) return;
      if (!spoken)
        throw new Error('This message has no readable text with the selected speech settings.');
      setSpeechContext({ sourceId, private: privateChat });
      await speech.start({
        text: spoken,
        messageFingerprint: proof,
        sourceId,
        messageId,
        thinking: role === 'thinking',
        label: label ?? t(role === 'ai' ? 'Response' : role === 'thinking' ? 'Reasoning' : 'User'),
        private: privateChat,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (own === attempt.current) setPreparing(false);
    }
  };
  return (
    <button
      type="button"
      className="copy-turn tts-read-button"
      aria-label={preparing ? t('Preparing…') : t('Read aloud')}
      title={preparing ? t('Preparing…') : t('Read aloud')}
      aria-pressed={active}
      aria-busy={preparing}
      disabled={preparing}
      onClick={() => void read()}
    >
      <svg viewBox="0 0 75 75" width="18" height="18" aria-hidden="true" focusable="false">
        <path
          d="M39.389,13.769 L22.235,28.606 L6,28.606 L6,47.699 L21.989,47.699 L39.389,62.75 L39.389,13.769z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinejoin="round"
        />
        <path
          d="M48,27.6a19.5,19.5 0 0 1 0,21.4M55.1,20.5a30,30 0 0 1 0,35.6M61.6,14a38.8,38.8 0 0 1 0,48.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
