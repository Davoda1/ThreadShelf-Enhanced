export type ConversationDisplayPreferences = {
  jsonVisibility: 'show-all' | 'hide-empty' | 'hide-all';
  jsonAsCode: boolean;
  codeDownloads: boolean;
  codeWrap: boolean;
  codeLineNumbers: boolean;
};

export const DEFAULT_CONVERSATION_DISPLAY: Readonly<ConversationDisplayPreferences> = {
  jsonVisibility: 'hide-empty',
  jsonAsCode: true,
  codeDownloads: true,
  codeWrap: false,
  codeLineNumbers: false,
};

/** Persisted browser preferences are untrusted and may come from an older version. */
export function normalizeConversationDisplay(value: unknown): ConversationDisplayPreferences {
  const saved =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<Record<keyof ConversationDisplayPreferences, unknown>>)
      : {};
  return {
    jsonVisibility:
      saved.jsonVisibility === 'show-all' ||
      saved.jsonVisibility === 'hide-empty' ||
      saved.jsonVisibility === 'hide-all'
        ? saved.jsonVisibility
        : DEFAULT_CONVERSATION_DISPLAY.jsonVisibility,
    jsonAsCode:
      typeof saved.jsonAsCode === 'boolean'
        ? saved.jsonAsCode
        : DEFAULT_CONVERSATION_DISPLAY.jsonAsCode,
    codeDownloads:
      typeof saved.codeDownloads === 'boolean'
        ? saved.codeDownloads
        : DEFAULT_CONVERSATION_DISPLAY.codeDownloads,
    codeWrap:
      typeof saved.codeWrap === 'boolean' ? saved.codeWrap : DEFAULT_CONVERSATION_DISPLAY.codeWrap,
    codeLineNumbers:
      typeof saved.codeLineNumbers === 'boolean'
        ? saved.codeLineNumbers
        : DEFAULT_CONVERSATION_DISPLAY.codeLineNumbers,
  };
}
