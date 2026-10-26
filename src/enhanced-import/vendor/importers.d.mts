export interface NativeRecord {
  sourceIndex?: number;
  provider: string;
  sourceFile: string;
  conversationKey: string;
  title: string;
  turns: import('../../validation.js').Turn[];
  raw: Record<string, unknown>;
  sourceIdentity?: Record<string, unknown>;
}
export interface ImportProgress {
  phase: string;
  code?: 'empty' | 'unsupported';
  sourceFile?: string;
  message?: string;
  bytes?: number;
  totalBytes?: number;
}
export interface NativeOptions {
  signal?: AbortSignal;
  limits?: Partial<typeof IMPORT_LIMITS>;
  onProgress?: (event: ImportProgress) => void;
  checkpoint?: () => Promise<void>;
  beforeWholeDocument?: (bytes: number) => Promise<void>;
}
export const IMPORT_LIMITS: {
  fileBytes: number;
  htmlBytes: number;
  zipBytes: number;
  expandedBytes: number;
  streamBytes: number;
  recordBytes: number;
  streamingThreshold: number;
  metadataBytes: number;
  directoryBytes: number;
  records: number;
  entries: number;
  depth: number;
  jsonDepth: number;
  nodes: number;
};
export function normalizeDocument(
  input: unknown,
  sourceFile?: string,
  options?: NativeOptions,
): NativeRecord[];
export function isClearlyUnsupportedExportPrefix(prefix: Buffer, filename: string): boolean;
export function importPaths(
  paths: string[],
  options?: NativeOptions,
): AsyncGenerator<
  NativeRecord | { error: string; sourceFile: string; kind?: 'unsupported' | 'invalid' }
>;
