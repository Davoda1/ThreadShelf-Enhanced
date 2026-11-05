export function formatJsonResponse(content: unknown, role: string): string | null;
export function isEmptyThoughtsResponse(content: unknown, role: string): boolean;
export function shouldHideJsonResponse(
  content: unknown,
  role: string,
  visibility: 'show-all' | 'hide-empty' | 'hide-all',
): boolean;
export function jsonResponseMarkdown(content: unknown, role: string): string | null;
