import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataPath, uploadsPath } from '../paths.js';
import { withInterprocessLock } from '../interprocess-lock.js';
import { listCollections, dropCollection } from '../store.js';

// Overridable so test servers with an isolated LanceDB do not share (and
// pollute) the real registry file in the repo/app directory.
const COLLECTIONS_FILE = resolve(process.env.COLLECTIONS_PATH || dataPath('collections'));

const validCollections = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((name) => typeof name === 'string');

export const readManualCollections = async (): Promise<string[]> => {
  let raw: string;
  try {
    raw = await readFile(COLLECTIONS_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error('Collection registry contains invalid JSON; the existing file was preserved', {
      cause: error,
    });
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !validCollections((data as { collections?: unknown }).collections)
  )
    throw new Error('Collection registry has an invalid format; the existing file was preserved');
  return (data as { collections: string[] }).collections;
};

/** Publish a complete registry while the caller holds its interprocess lock. */
const writeManualCollectionsLocked = async (collections: string[]): Promise<void> => {
  // Preserve an existing configured symlink instead of replacing the link itself.
  const destination = await realpath(COLLECTIONS_FILE).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return COLLECTIONS_FILE;
    throw error;
  });
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ collections }, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    // Windows does not expose directory fsync through Node's filesystem API.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(destination), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
};

export const writeManualCollections = async (collections: string[]): Promise<void> =>
  withInterprocessLock(COLLECTIONS_FILE, async () => {
    if (!validCollections(collections)) throw new Error('Collection names must be strings');
    // A damaged or unreadable registry must never become an apparently empty one.
    await readManualCollections();
    await writeManualCollectionsLocked(collections);
  });

export const getAllCollections = async (): Promise<string[]> => {
  const [tableCollections, manualCollections] = await Promise.all([
    listCollections(),
    readManualCollections(),
  ]);
  return [...new Set([...tableCollections, ...manualCollections, 'chunks'])].sort();
};

export const addManualCollection = async (name: string): Promise<void> =>
  withInterprocessLock(COLLECTIONS_FILE, async () => {
    const collections = await readManualCollections();
    if (!collections.includes(name)) {
      collections.push(name);
      collections.sort();
      await writeManualCollectionsLocked(collections);
    }
  });

export const removeManualCollection = async (name: string): Promise<void> =>
  withInterprocessLock(COLLECTIONS_FILE, async () => {
    const collections = await readManualCollections();
    const filtered = collections.filter((c) => c !== name);
    if (filtered.length !== collections.length) {
      await writeManualCollectionsLocked(filtered);
    }
  });

export const ensureCollectionExists = async (name: string): Promise<void> => {
  const all = await getAllCollections();
  if (!all.includes(name)) {
    await addManualCollection(name);
  }
};

export const deleteCollectionFull = async (
  name: string,
  uploadsDir: string = uploadsPath(),
): Promise<void> => {
  // Fail before destructive work when registry corruption already prevents cleanup.
  await readManualCollections();
  await dropCollection(name);
  await removeManualCollection(name);
  await rm(join(uploadsDir, name), { recursive: true, force: true });
};
