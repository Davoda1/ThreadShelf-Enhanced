export const CODE_LANGUAGE_EXTENSIONS: Readonly<Record<string, string>>;
export const CODE_FENCE_EXTENSIONS: Readonly<Record<string, string>>;
export function codeDownloadExtension(rawLanguage?: string | null): string;
export function codeDownloadFileName(rawLanguage?: string | null, index?: number): string;
