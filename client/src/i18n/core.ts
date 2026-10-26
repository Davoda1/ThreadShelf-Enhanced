import { translations } from './translations';

export const LOCALES = ['en', 'hu', 'de', 'ja', 'fr', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export type TranslationParams = Readonly<Record<string, string | number>>;
export const localeNames: Readonly<Record<Locale, string>> = {
  en: 'English',
  hu: 'Magyar',
  de: 'Deutsch',
  ja: '日本語',
  fr: 'Français',
  ru: 'Русский',
};
export const normalizeLocale = (value: unknown): Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
    ? (value as Locale)
    : 'en';

/** Only application-owned strings are passed here. Conversation content is never translated. */
export function translate(
  source: string,
  locale: Locale = 'en',
  params: TranslationParams = {},
): string {
  const key = source.trim().replace(/\s+/g, ' ');
  const translation = locale === 'en' ? undefined : translations[key]?.[locale];
  const result =
    translation === undefined
      ? source
      : `${source.match(/^\s*/)?.[0] ?? ''}${translation}${source.match(/\s*$/)?.[0] ?? ''}`;
  return result.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function translatePlural(
  forms: Readonly<Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }>,
  count: number,
  locale: Locale = 'en',
  params: TranslationParams = {},
): string {
  const rule = new Intl.PluralRules(locale).select(count);
  return translate(forms[rule] ?? forms.other, locale, {
    ...params,
    count: new Intl.NumberFormat(locale).format(count),
  });
}

export type CountUnit = 'file' | 'conversation' | 'thread' | 'chunk' | 'message';
const countWords: Readonly<
  Record<CountUnit, Readonly<Record<Locale, readonly [string, string, string]>>>
> = {
  file: {
    en: ['file', 'files', 'files'],
    hu: ['fájl', 'fájl', 'fájl'],
    de: ['Datei', 'Dateien', 'Dateien'],
    ja: ['ファイル', 'ファイル', 'ファイル'],
    fr: ['fichier', 'fichiers', 'fichiers'],
    ru: ['файл', 'файла', 'файлов'],
  },
  conversation: {
    en: ['conversation', 'conversations', 'conversations'],
    hu: ['beszélgetés', 'beszélgetés', 'beszélgetés'],
    de: ['Unterhaltung', 'Unterhaltungen', 'Unterhaltungen'],
    ja: ['会話', '会話', '会話'],
    fr: ['conversation', 'conversations', 'conversations'],
    ru: ['разговор', 'разговора', 'разговоров'],
  },
  thread: {
    en: ['thread', 'threads', 'threads'],
    hu: ['beszélgetés', 'beszélgetés', 'beszélgetés'],
    de: ['Unterhaltung', 'Unterhaltungen', 'Unterhaltungen'],
    ja: ['会話', '会話', '会話'],
    fr: ['conversation', 'conversations', 'conversations'],
    ru: ['разговор', 'разговора', 'разговоров'],
  },
  chunk: {
    en: ['chunk', 'chunks', 'chunks'],
    hu: ['részlet', 'részlet', 'részlet'],
    de: ['Abschnitt', 'Abschnitte', 'Abschnitte'],
    ja: ['チャンク', 'チャンク', 'チャンク'],
    fr: ['segment', 'segments', 'segments'],
    ru: ['фрагмент', 'фрагмента', 'фрагментов'],
  },
  message: {
    en: ['message', 'messages', 'messages'],
    hu: ['üzenet', 'üzenet', 'üzenet'],
    de: ['Nachricht', 'Nachrichten', 'Nachrichten'],
    ja: ['メッセージ', 'メッセージ', 'メッセージ'],
    fr: ['message', 'messages', 'messages'],
    ru: ['сообщение', 'сообщения', 'сообщений'],
  },
};
export function countLabel(count: number, unit: CountUnit, locale: Locale = 'en'): string {
  const category = new Intl.PluralRules(locale).select(count);
  const words = countWords[unit][locale];
  const noun = words[category === 'one' ? 0 : category === 'few' ? 1 : 2];
  return `${new Intl.NumberFormat(locale).format(count)} ${noun}`;
}
