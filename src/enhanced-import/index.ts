import { resolve } from 'node:path';
import { getMemoryStatus, memoryCheckpoint } from '../memory-governor.js';
import type { Conversation } from '../parser.js';
import { validateTurns } from '../validation.js';
import { createMediaResolver, type MediaResolver } from './media.js';
import {
  IMPORT_LIMITS,
  importPaths,
  normalizeDocument,
  type NativeOptions,
  type NativeRecord,
} from './vendor/importers.mjs';

export { IMPORT_LIMITS };
export { isClearlyUnsupportedExportPrefix } from './vendor/importers.mjs';
export interface EnhancedImportOptions extends NativeOptions {
  /** Complete ZIP parts of the same native Venice backup. */
  readonly companionPaths?: readonly string[];
  /** Physical snapshots retain the stable source identities used by existing archives. */
  readonly sourcePathMap?: Readonly<Record<string, string>>;
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

export interface EnhancedImportNotice {
  readonly sourceFile: string;
  readonly code: 'unsupported' | 'empty' | 'warning' | 'invalid';
  readonly message: string;
}

export type EnhancedImportEvent =
  | { readonly type: 'conversation'; readonly conversation: EnhancedConversation }
  | { readonly type: 'skipped' | 'warning' | 'error'; readonly notice: EnhancedImportNotice };

export interface EnhancedFileResult {
  readonly conversations: EnhancedConversation[];
  readonly provider: string;
  readonly diagnostics: string[];
  readonly warnings?: readonly EnhancedImportNotice[];
}

/**
 * Yield one normalized conversation at a time. Consumers must stage the iterator
 * until it completes: a later ZIP member or changed source can still fail.
 * The ingest path writes these records to disk before any archive publication.
 */
export async function* iterateEnhancedFile(
  filePath: string,
  options: EnhancedImportOptions = {},
): AsyncGenerator<EnhancedImportEvent> {
  const sourcePath = resolve(filePath);
  const checkpoint = options.checkpoint ?? (() => memoryCheckpoint({ signal: options.signal }));
  const beforeWholeDocument =
    options.beforeWholeDocument ??
    (async (bytes: number) => {
      await checkpoint();
      const memory = getMemoryStatus();
      // Whole-document providers retain decoded strings, raw trees and normalized
      // copies concurrently. Refuse before allocating rather than hoping a later
      // memory sample can rescue an already oversized synchronous parse.
      const allowance = Math.min(
        memory.availableBytes - memory.reserveBytes,
        memory.processBudgetBytes - memory.rssBytes,
      );
      if (bytes * 12 > allowance)
        throw new Error(
          'This whole-document export would exceed the available memory budget. Use a supported conversation-array JSON export or split the export into smaller files.',
        );
    });
  const sourcePaths = [sourcePath, ...(options.companionPaths ?? []).map((path) => resolve(path))];
  const logicalSource = (physical: string): string => {
    for (const path of sourcePaths) {
      const mapped = options.sourcePathMap?.[path];
      if (mapped && (physical === path || physical.startsWith(`${path}!`)))
        return mapped + physical.slice(path.length);
    }
    if (physical === sourcePaths.join(';'))
      return sourcePaths.map((path) => options.sourcePathMap?.[path] ?? path).join(';');
    return physical;
  };
  const indices = new Map<string, number>();
  const notices: EnhancedImportEvent[] = [];
  const resolvers = new Map<string, MediaResolver>();
  let noticeOverflow = 0;
  const mediaFor = async (path: string): Promise<MediaResolver> => {
    const existing = resolvers.get(path);
    if (existing) return existing;
    // Multipart backups must not retain one open ZIP directory and media cache
    // for every part. At most two resolvers are live concurrently.
    if (resolvers.size >= 2) {
      const oldest = resolvers.entries().next().value!;
      await oldest[1].close();
      resolvers.delete(oldest[0]);
    }
    const created = await createMediaResolver(path, options.signal);
    resolvers.set(path, created);
    return created;
  };
  const onProgress: NonNullable<NativeOptions['onProgress']> = (event) => {
    const sourceFile = logicalSource(event.sourceFile ?? sourcePath);
    options.onProgress?.({ ...event, sourceFile });
    if (event.phase !== 'skipped' && event.phase !== 'warning') return;
    if (notices.length >= 1000) {
      noticeOverflow++;
      return;
    }
    notices.push({
      type: event.phase === 'skipped' ? 'skipped' : 'warning',
      notice: {
        sourceFile,
        code: event.phase === 'skipped' ? (event.code ?? 'empty') : 'warning',
        message: event.message ?? 'Source entry skipped.',
      },
    });
  };
  try {
    for await (const record of importPaths(sourcePaths, {
      ...options,
      onProgress,
      checkpoint,
      beforeWholeDocument,
    })) {
      options.signal?.throwIfAborted();
      await checkpoint();
      while (notices.length) yield notices.shift()!;
      if ('error' in record) {
        yield {
          type: record.kind === 'unsupported' ? 'skipped' : 'error',
          notice: {
            sourceFile: logicalSource(record.sourceFile),
            code: record.kind === 'unsupported' ? 'unsupported' : 'invalid',
            message: record.error,
          },
        };
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
      if (!conversation.turns.length) continue;
      let turns = conversation.turns;
      for (const mediaPath of sourcePaths)
        turns = await (await mediaFor(mediaPath)).resolveTurns(turns, record.sourceFile);
      const sourceFile = logicalSource(record.sourceFile);
      yield {
        type: 'conversation',
        conversation: {
          ...conversation,
          sourceFile,
          turns,
          key,
          sourceIdentity: {
            ...conversation.sourceIdentity,
            sourceFile,
            conversationKey: key,
            originalConversationKey: conversation.key,
            ...(sourcePaths.length > 1 ? { sourceFiles: sourcePaths.map(logicalSource) } : {}),
          },
        },
      };
    }
    while (notices.length) yield notices.shift()!;
    if (noticeOverflow)
      yield {
        type: 'warning',
        notice: {
          sourceFile: logicalSource(sourcePath),
          code: 'warning',
          message: `${noticeOverflow} additional source warnings were omitted from the progress buffer.`,
        },
      };
    options.signal?.throwIfAborted();
  } finally {
    for (const resolver of resolvers.values()) await resolver.close();
  }
}

/** Compatibility collector for bounded documents; ingestion uses the iterator. */
export const importEnhancedFile = async (
  filePath: string,
  options: EnhancedImportOptions = {},
): Promise<EnhancedFileResult> => {
  const conversations: EnhancedConversation[] = [];
  const diagnostics: string[] = [];
  const warnings: EnhancedImportNotice[] = [];
  for await (const event of iterateEnhancedFile(filePath, options)) {
    if (event.type === 'conversation') conversations.push(event.conversation);
    else if (event.type === 'error')
      diagnostics.push(`${event.notice.sourceFile}: ${event.notice.message}`);
    else if (warnings.length < 1000) warnings.push(event.notice);
  }
  if (diagnostics.length)
    return {
      conversations: [],
      provider: 'unknown',
      diagnostics,
      ...(warnings.length ? { warnings } : {}),
    };
  const providers = new Set(conversations.map((conversation) => conversation.provider));
  return {
    conversations,
    provider:
      providers.size === 1 ? conversations[0]!.provider : providers.size ? 'mixed' : 'unknown',
    diagnostics,
    ...(warnings.length ? { warnings } : {}),
  };
};
