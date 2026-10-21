import { resolve } from 'node:path';
import type { Conversation } from '../parser.js';
import { validateTurns } from '../validation.js';
import { createMediaResolver } from './media.js';
import {
  IMPORT_LIMITS,
  importPaths,
  normalizeDocument,
  type NativeOptions,
  type NativeRecord,
} from './vendor/importers.mjs';

export { IMPORT_LIMITS };
export interface EnhancedImportOptions extends NativeOptions {
  /** Complete ZIP parts of the same native Venice backup. */
  readonly companionPaths?: readonly string[];
}
export interface EnhancedConversation extends Conversation {
  readonly provider: string;
  readonly sourceFile: string;
  readonly raw: Record<string, unknown>;
  readonly sourceIdentity?: Record<string, unknown>;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Existing archive identities are also used by saved links and local continuations. */
const legacyKey = (record: NativeRecord, index: number): string => {
  const raw = record.raw;
  index = record.sourceIndex ?? index;
  // Local Reader/API exports carry their identity explicitly. Do not prefix it again.
  if (
    Array.isArray(raw.turns) &&
    raw.turns.some((turn) =>
      ['user', 'ai', 'thinking'].some((key) => typeof object(turn)[key] === 'string'),
    )
  ) {
    const explicit = raw.conversationKey ?? raw.key;
    if (explicit !== undefined && explicit !== null) return String(explicit);
    return record.conversationKey;
  }
  switch (record.provider) {
    case 'google-ai-studio':
      return 'google:0';
    case 'openrouter':
      return 'openrouter:0';
    case 'lm-studio':
      return 'lmstudio:0';
    case 'openai':
      return `openai:${String(raw.id ?? raw.conversation_id ?? raw.title ?? index)}`;
    case 'anthropic':
      return `anthropic:${String(raw.uuid ?? raw.id ?? raw.conversation_id ?? index)}`;
    case 'grok': {
      const meta = object(raw.conversation);
      return `grok:${String(meta.id ?? meta.conversation_id ?? raw.id ?? index)}`;
    }
    default:
      return record.conversationKey;
  }
};

const adaptRecord = (record: NativeRecord, index: number): EnhancedConversation => {
  const key = legacyKey(record, index);
  return {
    key,
    title: record.title,
    turns: validateTurns(record.turns),
    provider: record.provider,
    sourceFile: record.sourceFile,
    raw: record.raw,
    sourceIdentity: {
      ...record.sourceIdentity,
      conversationKey: key,
      originalConversationKey: key,
      sourceFile: record.sourceFile,
    },
  };
};

/** Synchronous compatibility entry point for already-decoded, bounded documents. */
export const parseEnhancedDocument = (
  input: unknown,
  sourceFile = 'export.json',
  options: EnhancedImportOptions = {},
): EnhancedConversation[] => {
  options.signal?.throwIfAborted();
  return normalizeDocument(input, sourceFile, {
    ...options,
    limits: { ...IMPORT_LIMITS, ...options.limits },
  })
    .map(adaptRecord)
    .filter((conversation) => conversation.turns.length > 0);
};

export interface EnhancedFileResult {
  readonly conversations: EnhancedConversation[];
  readonly provider: string;
  readonly diagnostics: string[];
}

/**
 * The source reader validates large JSON arrays in a bounded first pass, then
 * normalizes one record at a time. Source ZIP members are CRC checked and never
 * extracted. Storage still stages the normalized conversations before replacing
 * a file, so a failed/cancelled archive cannot partially overwrite its old data.
 */
export const importEnhancedFile = async (
  filePath: string,
  options: EnhancedImportOptions = {},
): Promise<EnhancedFileResult> => {
  const sourcePath = resolve(filePath);
  const conversations: EnhancedConversation[] = [];
  const diagnostics: string[] = [];
  const indices = new Map<string, number>();
  const sourcePaths = [sourcePath, ...(options.companionPaths ?? []).map((path) => resolve(path))];
  for await (const record of importPaths(sourcePaths, options)) {
    options.signal?.throwIfAborted();
    if ('error' in record) {
      diagnostics.push(`${record.sourceFile}: ${record.error}`);
      continue;
    }
    const index = indices.get(record.sourceFile) ?? 0;
    indices.set(record.sourceFile, index + 1);
    const conversation = adaptRecord(record, index);
    const archiveMember = record.sourceFile.startsWith(`${sourcePath}!`)
      ? record.sourceFile.slice(sourcePath.length + 1)
      : undefined;
    const key = archiveMember
      ? `${encodeURIComponent(archiveMember)}::${conversation.key}`
      : conversation.key;
    if (conversation.turns.length)
      conversations.push({
        ...conversation,
        key,
        sourceIdentity: {
          ...conversation.sourceIdentity,
          conversationKey: key,
          originalConversationKey: conversation.key,
          ...(sourcePaths.length > 1 ? { sourceFiles: sourcePaths } : {}),
        },
      });
  }
  options.signal?.throwIfAborted();
  if (diagnostics.length) return { conversations: [], provider: 'unknown', diagnostics };
  let withAssets = conversations;
  for (const mediaPath of sourcePaths) {
    const media = await createMediaResolver(mediaPath, options.signal);
    const resolvedConversations: EnhancedConversation[] = [];
    try {
      for (const conversation of withAssets) {
        resolvedConversations.push({
          ...conversation,
          turns: await media.resolveTurns(conversation.turns, conversation.sourceFile),
        });
      }
    } finally {
      await media.close();
    }
    withAssets = resolvedConversations;
  }
  const providers = new Set(conversations.map((conversation) => conversation.provider));
  return {
    conversations: withAssets,
    provider: providers.size === 1 ? conversations[0]!.provider : 'mixed',
    diagnostics,
  };
};
