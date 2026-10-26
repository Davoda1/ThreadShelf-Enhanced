import { lstat, opendir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dataPath, packagePath, uploadsPath } from './paths.js';
import { effectiveModelDirectories, getGenerationConfig } from './generation/config.js';
import { hasBlockingCollectionJobs, withInactiveCollectionJobs } from './import-jobs.js';
import {
  indexingDataPath,
  withExclusiveCollectionMutation,
  withIndexOperation,
} from './indexing-coordinator.js';
import { normalizeCollectionName } from './validation.js';

export class UploadStorageError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'UploadStorageError';
  }
}

export interface UploadedSourceFile {
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAt: number;
}

const MAX_ENTRIES = 1_000_000;
const MAX_DEPTH = 32;
const MAX_COLLECTIONS = 10_000;
const MAX_PAGE_SIZE = 200;
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const contains = (parent: string, child: string): boolean => {
  const suffix = relative(parent, child);
  return (
    suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  );
};

const collectionName = (value: unknown): string => {
  if (typeof value !== 'string' || normalizeCollectionName(value) !== value)
    throw new UploadStorageError('Invalid upload collection');
  return value;
};

/** Reject aliases instead of normalizing a destructive filesystem selection. */
const relativeFilePath = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    /[\\:]/.test(value) ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    isAbsolute(value)
  )
    throw new UploadStorageError('Invalid uploaded file path');
  const parts = value.split('/');
  if (
    parts.length > MAX_DEPTH ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.toLowerCase() === '.incoming' ||
        part.length > 255 ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )
  )
    throw new UploadStorageError('Invalid uploaded file path');
  return value;
};

/** Resolve existing ancestors too, so a not-yet-created override cannot alias protected data. */
const canonical = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await canonical(parent), relative(parent, path));
  }
};

const assertSeparateStorage = async (directory: string): Promise<void> => {
  const config = await getGenerationConfig().catch(() => {
    throw new UploadStorageError('Server storage configuration could not be verified', 409);
  });
  const protectedPaths = [
    indexingDataPath(),
    process.env.COLLECTIONS_PATH || dataPath('collections'),
    process.env.GENERATION_CONFIG_PATH || dataPath('generationConfig'),
    process.env.MASTER_PROMPTS_PATH || dataPath('masterPrompts'),
    process.env.THREADSHELF_IMAGE_CACHE_PATH || dataPath('imageCache'),
    process.env.THREADSHELF_MODELS_PATH || dataPath('models'),
    process.env.THREADSHELF_TOOLS_PATH || dataPath('tools'),
    process.env.THREADSHELF_MODEL_CACHE || dataPath('modelCache'),
    process.env.GENERATION_ERROR_LOG_PATH || dataPath('generationErrorLog'),
    ...effectiveModelDirectories(config.llamaCpp),
    ...(config.llamaCpp.executablePath ? [config.llamaCpp.executablePath] : []),
    ...[
      'src',
      'client',
      'dist',
      'public',
      'scripts',
      'mcp',
      'bin',
      'node_modules',
      '.local',
      '.git',
      'personal',
    ].map((part) => packagePath(part)),
    dataPath('env'),
  ];
  for (const protectedPath of protectedPaths) {
    const protectedRoot = await canonical(resolve(protectedPath));
    if (contains(directory, protectedRoot) || contains(protectedRoot, directory))
      throw new UploadStorageError(
        'Upload storage overlaps protected server data; cleanup is unavailable.',
        409,
      );
  }
};

const collectionDirectory = async (collection: string): Promise<string> => {
  collectionName(collection);
  let root: string;
  try {
    root = await realpath(uploadsPath());
  } catch (error) {
    if (isMissing(error)) throw new UploadStorageError('Upload collection not found', 404);
    throw error;
  }
  const directory = join(root, collection);
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (isMissing(error)) throw new UploadStorageError('Upload collection not found', 404);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new UploadStorageError('Upload collection must be a regular directory', 409);
  await assertSeparateStorage(directory);
  return directory;
};

export const listUploadCollections = async (): Promise<{ collection: string }[]> => {
  const collections: { collection: string }[] = [];
  let directory;
  try {
    directory = await opendir(uploadsPath());
  } catch (error) {
    if (isMissing(error)) return collections;
    throw error;
  }
  let visited = 0;
  for await (const entry of directory) {
    if (++visited > MAX_ENTRIES)
      throw new UploadStorageError('Upload directory has too many entries to list safely', 413);
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      collectionName(entry.name);
    } catch {
      continue;
    }
    if (collections.length >= MAX_COLLECTIONS)
      throw new UploadStorageError('Too many upload collections to list safely', 413);
    collections.push({ collection: entry.name });
  }
  return collections.sort((a, b) => a.collection.localeCompare(b.collection));
};

/** Open one bounded directory buffer per nesting level, never materialize the tree. */
async function* walkFiles(root: string): AsyncGenerator<UploadedSourceFile> {
  let visited = 0;
  async function* walk(parts: string[]): AsyncGenerator<UploadedSourceFile> {
    if (parts.length >= MAX_DEPTH)
      throw new UploadStorageError('Upload directory nesting exceeds the safe limit', 413);
    const directory = await opendir(join(root, ...parts));
    for await (const entry of directory) {
      if (++visited > MAX_ENTRIES)
        throw new UploadStorageError('Upload directory has too many entries to scan safely', 413);
      if (entry.name.toLowerCase() === '.incoming' || entry.isSymbolicLink()) continue;
      const path = [...parts, entry.name].join('/');
      // Files that cannot be addressed safely remain untouched, including links and staging.
      try {
        relativeFilePath(path);
      } catch {
        continue;
      }
      const info = await lstat(join(root, ...parts, entry.name));
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) yield* walk([...parts, entry.name]);
      else if (info.isFile()) yield { path, bytes: info.size, modifiedAt: info.mtimeMs };
    }
  }
  yield* walk([]);
}

const pageNumber = (value: unknown, fallback: number, max: number, min = 0): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new UploadStorageError('Invalid upload pagination');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new UploadStorageError('Invalid upload pagination');
  return number;
};

export const listUploadedFiles = async (
  collection: string,
  options: { cursor?: unknown; limit?: unknown } = {},
): Promise<{ files: UploadedSourceFile[]; nextCursor: string | null; locked: boolean }> => {
  if (Object.keys(options).some((key) => key !== 'cursor' && key !== 'limit'))
    throw new UploadStorageError('Invalid upload pagination');
  const offset = pageNumber(options.cursor, 0, MAX_ENTRIES);
  const limit = pageNumber(options.limit, 100, MAX_PAGE_SIZE, 1);
  const directory = await collectionDirectory(collection);
  const files: UploadedSourceFile[] = [];
  let seen = 0;
  let nextCursor: string | null = null;
  for await (const file of walkFiles(directory)) {
    if (seen++ < offset) continue;
    if (files.length === limit) {
      nextCursor = String(offset + limit);
      break;
    }
    files.push(file);
  }
  return { files, nextCursor, locked: await hasBlockingCollectionJobs(collection, directory) };
};

const selectedFile = async (root: string, path: string): Promise<UploadedSourceFile> => {
  const parts = relativeFilePath(path).split('/');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isMissing(error))
        throw new UploadStorageError('Selected uploaded file no longer exists', 404);
      throw error;
    }
    if (info.isSymbolicLink())
      throw new UploadStorageError('Symbolic links cannot be managed as uploaded files', 400);
    if (index < parts.length - 1) {
      if (!info.isDirectory()) throw new UploadStorageError('Invalid uploaded file path');
    } else {
      if (!info.isFile()) throw new UploadStorageError('Select uploaded files, not directories');
      return { path, bytes: info.size, modifiedAt: info.mtimeMs };
    }
  }
  throw new UploadStorageError('Invalid uploaded file path');
};

export const deleteUploadedFiles = async (
  collection: string,
  body: unknown,
): Promise<{ deleted: number; bytes: number }> => {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new UploadStorageError('Select uploaded files or clear the upload collection');
  const request = body as Record<string, unknown>;
  const all = request.all === true;
  if (
    Object.keys(request).some((key) => key !== (all ? 'all' : 'paths')) ||
    (!all &&
      (!Array.isArray(request.paths) ||
        request.paths.length === 0 ||
        request.paths.length > MAX_PAGE_SIZE))
  )
    throw new UploadStorageError('Select up to 200 uploaded files, or use all: true');
  const paths = all ? [] : [...new Set((request.paths as unknown[]).map(relativeFilePath))];
  const directory = await collectionDirectory(collection);
  return withInactiveCollectionJobs(
    collection,
    () =>
      withIndexOperation(
        collection,
        false,
        () =>
          withExclusiveCollectionMutation(collection, async () => {
            // Revalidate after acquiring all reservations. No recursive rm is used.
            if ((await collectionDirectory(collection)) !== directory)
              throw new UploadStorageError(
                'Upload collection changed; refresh before deleting',
                409,
              );
            const files = all
              ? undefined
              : await Promise.all(paths.map((path) => selectedFile(directory, path)));
            // Preflight the bounded traversal before clearing, so an oversized tree is unchanged.
            if (all) for await (const file of walkFiles(directory)) void file;
            let deleted = 0;
            let bytes = 0;
            for await (const file of files ?? walkFiles(directory)) {
              const checked = await selectedFile(directory, file.path);
              await unlink(join(directory, ...checked.path.split('/')));
              deleted++;
              bytes += checked.bytes;
            }
            return { deleted, bytes };
          }),
        { timeoutMs: 0 },
      ),
    directory,
  );
};
