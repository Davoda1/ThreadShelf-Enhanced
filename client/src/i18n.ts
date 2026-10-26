import { useUIStore } from './store';
import { countLabel, translate, translatePlural, type TranslationParams } from './i18n/core';
export { LOCALES, localeNames, normalizeLocale, type Locale } from './i18n/core';

export const t = (source: string, params?: TranslationParams): string =>
  translate(source, useUIStore.getState().locale, params);

/** Subscribing does not remount the page or interrupt an active chat or upload. */
export const useI18n = () => {
  const locale = useUIStore((state) => state.locale);
  return { locale, t };
};

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
  new Intl.NumberFormat(useUIStore.getState().locale, options).format(value);
export const formatDate = (value: Date | number, options?: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(useUIStore.getState().locale, options).format(value);
export const plural = (
  count: number,
  forms: Readonly<Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }>,
  params?: TranslationParams,
): string => translatePlural(forms, count, useUIStore.getState().locale, params);

export const formatCount = (count: number, unit: import('./i18n/core').CountUnit): string =>
  countLabel(count, unit, useUIStore.getState().locale);
