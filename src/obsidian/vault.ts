import { constants } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  open,
  opendir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalVaultRoot, getVaultConfig, getVaultConfigForRoot } from './config.js';
import { withInterprocessLock } from '../interprocess-lock.js';

const MAX_NOTE_BYTES = 512 * 1024;
const MAX_FILES = 20_000;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const requestRoot = new AsyncLocalStorage<string>();
export const inVault = <T>(root: string, fn: () => Promise<T>): Promise<T> =>
  requestRoot.run(root, fn);
export interface VaultNote {
  readonly path: string;
  readonly content: string;
  readonly revision: string;
}
export interface VaultHit {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
  readonly line: number;
  readonly heading?: string;
}
export interface VaultSearchResult {
  readonly hits: VaultHit[];
  readonly scanned: number;
  /** `.md` files that exist but cannot be served safely (unsafe name, link, too large, unreadable). */
  readonly skipped: number;
  readonly truncated: boolean;
}

/**
 * Filesystem errors carry absolute paths in their message; never forward those
 * to a model, MCP client or browser.
 */
export const vaultErrorMessage = (error: unknown, fallback = 'Vault operation failed'): string => {
  if (error instanceof Error && error.name === 'AbortError') return 'Vault operation was cancelled';
  if ((error as NodeJS.ErrnoException | undefined)?.code)
    return 'Vault filesystem operation failed; check directory availability and permissions';
  return error instanceof Error ? error.message : fallback;
};

/** Windows device names, including the superscript-digit and console variants. */
const RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])\s*(?:\.|$)/i;

export const notePath = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 1024 || !value.toLowerCase().endsWith('.md')) {
    throw new Error('A relative .md note path is required');
  }
  const parts = value.replace(/\\/g, '/').split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part.startsWith('.') ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        // `:` also rejects drive letters and NTFS alternate data streams (`note.md:stream`).
        /[<>:"|?*]/.test(part) ||
        /[. ]$/.test(part) ||
        RESERVED_NAME.test(part),
    )
  ) {
    throw new Error('Unsafe note path: hidden paths, traversal and reserved names are forbidden');
  }
  return parts.join('/');
};
const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
const rootNow = async (write = false, expectedRoot?: string): Promise<string> => {
  const pinned = requestRoot.getStore();
  const config = pinned ? await getVaultConfigForRoot(pinned) : await getVaultConfig();
  if (!config.vaultPath) throw new Error('Connect an Obsidian vault in Settings first');
  if (write && !config.allowWrites) throw new Error('Vault is read-only: writing is disabled');
  const root = await canonicalVaultRoot(config.vaultPath);
  if (
    (expectedRoot && root !== expectedRoot) ||
    (requestRoot.getStore() && root !== requestRoot.getStore())
  )
    throw new Error('Vault changed; start a new request');
  return root;
};
const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};
/**
 * The canonical path must stay inside the vault and outside hidden folders.
 * Checking the resolved path also rejects aliases the textual check cannot see,
 * such as Windows 8.3 short names (`OBSIDI~1` for `.obsidian`).
 */
const assertCanonical = async (root: string, target: string): Promise<void> => {
  const real = await realpath(target);
  if (!inside(root, real)) throw new Error('Path escapes the vault');
  if (
    relative(root, real)
      .split(/[\\/]/)
      .some((part) => part.startsWith('.'))
  )
    throw new Error('Unsafe note path: hidden paths, traversal and reserved names are forbidden');
};
const safeTarget = async (root: string, path: string, missing = false): Promise<string> => {
  const parts = notePath(path).split('/');
  let target = root;
  for (let i = 0; i < parts.length; i++) {
    target = join(target, parts[i]!);
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (missing && i === parts.length - 1 && error.code === 'ENOENT') return undefined;
      throw new Error('Note or parent directory is unavailable');
    });
    if (!stat) break;
    if (
      stat.isSymbolicLink() ||
      (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1)
    ) {
      throw new Error('Only regular Markdown files inside the vault are allowed');
    }
    await assertCanonical(root, target);
  }
  if (!inside(root, target)) throw new Error('Path escapes the vault');
  return target;
};
const readAt = async (root: string, path: string): Promise<VaultNote> => {
  const target = await safeTarget(root, path);
  const before = await lstat(target);
  const file = await open(
    target,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  ).catch(() => {
    throw new Error('Cannot open note');
  });
  try {
    const stat = await file.stat();
    if (before.ino !== stat.ino || before.dev !== stat.dev)
      throw new Error('Note changed while opening it');
    if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_NOTE_BYTES)
      throw new Error('Note is too large or is not a regular file');
    // Bounded read also covers files growing after the stat call.
    const buffer = Buffer.alloc(MAX_NOTE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_NOTE_BYTES) throw new Error('Note exceeds the 512 KiB limit');
    await safeTarget(root, path);
    const after = await lstat(target);
    if (
      after.ino !== stat.ino ||
      after.dev !== stat.dev ||
      after.size !== size ||
      after.mtimeMs !== stat.mtimeMs
    )
      throw new Error('Note changed while reading it; retry');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, size),
      );
    } catch {
      throw new Error('Note must contain valid UTF-8 text');
    }
    if (content.includes('\0')) throw new Error('Note must not contain binary NUL bytes');
    return { path: notePath(path), content, revision: hash(content) };
  } finally {
    await file.close();
  }
};
export const readVaultNote = async (path: unknown): Promise<VaultNote> =>
  readAt(await rootNow(), notePath(path));
const contentValue = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > MAX_NOTE_BYTES ||
    value.includes('\0')
  ) {
    throw new Error('Markdown content must be text of at most 512 KiB');
  }
  return value;
};

/** Writes hold the lock for milliseconds; an older lock is left behind by a crashed process. */
export const STALE_LOCK_MS = 2 * 60_000;
export const LOCK_NAME = '.threadshelf-write-lock';
const OWNER_FILE = 'owner';
const LOCK_RETRIES = 8;
const LOCK_RETRY_MS = 25;
const BUSY = 'Vault is busy; retry after the current write completes';

export interface LockState {
  /** Directory identity plus the owner's random token: a re-created lock never matches. */
  readonly id: string;
  readonly mtimeMs: number;
}
/** Identity of the directory itself (not its contents); undefined for anything else. */
const dirIdentity = async (path: string): Promise<string | undefined> => {
  const stat = await lstat(path, { bigint: true }).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return undefined;
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
};

export const describeLock = async (lock: string): Promise<LockState | undefined> => {
  const stat = await lstat(lock, { bigint: true }).catch(() => undefined);
  // Anything other than a real directory is never treated as a reclaimable lock.
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return undefined;
  const owner = await readFile(join(lock, OWNER_FILE), 'utf8').catch(() => '');
  return {
    id: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${owner}`,
    mtimeMs: Number(stat.mtimeMs),
  };
};

/**
 * Removes a lock judged stale, safely against concurrent reclaimers.
 *
 * 1. A per-instance marker (`mkdir`, exclusive) lets only one process reclaim
 *    the lock instance that was judged stale.
 * 2. The winner re-checks the identity, then atomically renames the lock to a
 *    unique tombstone and verifies the tombstone is still that instance. If a
 *    live writer replaced it in between, the lock is put back untouched.
 *
 * A process that judged an older instance stale can therefore never remove a
 * lock that another process has just re-created.
 */
export const reclaimStaleLock = async (
  lock: string,
  judged: LockState,
  /** Test seam: runs inside the race windows around the rename. */
  hooks: { beforeRename?: () => Promise<void>; afterRename?: () => Promise<void> } = {},
): Promise<boolean> => {
  if (Date.now() - judged.mtimeMs <= STALE_LOCK_MS) return false;
  const marker = `${lock}.reclaim-${hash(judged.id).slice(0, 16)}`;
  try {
    await mkdir(marker);
  } catch {
    // A reclaimer that crashed inside its millisecond window must not block the vault forever.
    const stat = await lstat(marker).catch(() => undefined);
    if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS)
      await rmdir(marker).catch(() => undefined);
    return false;
  }
  try {
    if ((await describeLock(lock))?.id !== judged.id) return false;
    const tombstone = `${lock}.stale-${randomUUID()}`;
    await hooks.beforeRename?.();
    if (
      !(await rename(lock, tombstone).then(
        () => true,
        () => false,
      ))
    )
      return false;
    await hooks.afterRename?.();
    if ((await describeLock(tombstone))?.id !== judged.id) {
      // Someone else's directory was moved. Our marker existed before the judged lock
      // vanished, so whoever created this one saw the marker and is backing off without
      // ever writing an owner: it is an abandoned, empty provisional lock. Putting it back
      // would orphan it at the lock path ("Vault is busy" until it ages out), so remove it.
      // rmdir only removes an empty directory, so a lock with an owner is never deleted.
      if (
        await rmdir(tombstone).then(
          () => true,
          () => false,
        )
      )
        return false;
      // A lock with an owner (defensive; e.g. after a marker expired): put it back. While
      // the marker exists, acquirers back off, so nobody can take the vacated path meanwhile.
      for (let i = 0; i < LOCK_RETRIES; i++) {
        if (
          await rename(tombstone, lock).then(
            () => true,
            () => false,
          )
        )
          break;
        await delay(LOCK_RETRY_MS);
      }
      return false;
    }
    await rm(tombstone, { recursive: true, force: true }).catch(() => undefined);
    return true;
  } finally {
    await rmdir(marker).catch(() => undefined);
  }
};

const reclaimInProgress = async (root: string): Promise<boolean> => {
  const prefix = `${LOCK_NAME}.reclaim-`;
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const stat = await lstat(join(root, name)).catch(() => undefined);
    // A marker left by a crashed reclaimer expires like a stale lock.
    if (stat && Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return true;
  }
  return false;
};

/** Cross-process exclusion for ThreadShelf writers. Returns a release function that never throws. */
export const acquireVaultLock = async (
  root: string,
  /** Test seam: runs between creating the lock directory and checking for reclaimers. */
  hooks: { afterCreate?: () => Promise<void> } = {},
): Promise<() => Promise<void>> => {
  const lock = join(root, LOCK_NAME);
  const token = randomUUID();
  // Removes the directory this call created, never one that replaced it at the same path
  // (a reclaimer may have moved ours away and another writer may have made a new one).
  const dropOwn = async (own: string | undefined) => {
    if (own && (await dirIdentity(lock)) === own) await rmdir(lock).catch(() => undefined);
  };
  for (let attempt = 0; ; attempt++) {
    const created = await mkdir(lock).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        return false;
      },
    );
    if (created) {
      const own = await dirIdentity(lock);
      await hooks.afterCreate?.();
      if (await reclaimInProgress(root)) {
        // A reclaimer may be holding a live lock away from this path; taking it now would
        // give two writers. Release the empty lock we just made and wait for the marker to go.
        await dropOwn(own);
      } else {
        try {
          // `wx`: the owner file decides who holds the lock. ENOENT/EEXIST mean our
          // directory was moved or replaced meanwhile: we lost the race, nothing to undo.
          await writeFile(join(lock, OWNER_FILE), token, { flag: 'wx', mode: 0o600 });
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'EEXIST') {
            await dropOwn(own);
            throw error;
          }
        }
      }
    } else {
      const state = await describeLock(lock);
      if (state && (await reclaimStaleLock(lock, state))) continue;
    }
    if (attempt >= LOCK_RETRIES) throw new Error(BUSY);
    await delay(LOCK_RETRY_MS);
  }
  return async () => {
    // Only remove our own lock; one reclaimed after STALE_LOCK_MS belongs to another writer.
    const owner = await readFile(join(lock, OWNER_FILE), 'utf8').catch(() => '');
    if (owner === token) await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  };
};

const withWrite = async <T>(
  fn: (root: string) => Promise<T>,
  expectedRoot?: string,
): Promise<T> => {
  const root = await rootNow(true, expectedRoot);
  // The OS lock is authoritative. The legacy lock directory is retained for
  // interoperability, but its stale timeout can never steal a live Enhanced write.
  return withInterprocessLock(join(root, '.threadshelf-vault-write'), async () => {
    const release = await acquireVaultLock(root);
    try {
      await rootNow(true, root);
      return await fn(root);
    } finally {
      await release().catch(() => undefined);
    }
  });
};
export const createVaultNote = async (path: unknown, content: unknown): Promise<VaultNote> => {
  const name = notePath(path);
  const text = contentValue(content);
  return withWrite(async (root) => {
    const target = await safeTarget(root, name, true);
    const temporary = join(dirname(target), `.threadshelf-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(text, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rootNow(true, root);
      await safeTarget(root, name, true);
      // link() installs the complete file atomically and refuses an existing name.
      // Unlike rename(), it can never overwrite a note created after the preview.
      await link(temporary, target).catch(() => {
        throw new Error('Note already exists or cannot be created');
      });
      await syncDirectory(dirname(target));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return { path: name, content: text, revision: hash(text) };
  });
};
export const editVaultNote = async (
  path: unknown,
  content: unknown,
  revision: unknown,
): Promise<VaultNote> => {
  const name = notePath(path);
  const text = contentValue(content);
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))
    throw new Error('Read the note first and provide its revision');
  return withWrite(async (root) => {
    const before = await readAt(root, name);
    if (before.revision !== revision) throw new Error('Note changed; read it again before editing');
    const target = await safeTarget(root, name);
    const { mode } = await lstat(target);
    const temporary = join(dirname(target), `.threadshelf-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(text, 'utf8');
        await file.sync();
        // Keep the note's permissions (e.g. 0644 for a synced vault). Windows only has a read-only bit.
        if (process.platform !== 'win32') await file.chmod(mode & 0o777);
      } finally {
        await file.close();
      }
      if ((await readAt(root, name)).revision !== revision)
        throw new Error('Note changed during editing');
      await rootNow(true, root);
      await safeTarget(root, name);
      await saveRevision(root, before);
      await rename(temporary, target);
      await syncDirectory(dirname(target));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return { path: name, content: text, revision: hash(text) };
  });
};

const syncDirectory = async (path: string): Promise<void> => {
  // Windows does not offer POSIX directory fsync through Node. File handles
  // themselves are synced on both platforms before publication.
  if (process.platform === 'win32') return;
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
};

/** Retained note revisions live outside normal search in the vault itself. */
const saveRevision = async (root: string, note: VaultNote): Promise<void> => {
  const directory = join(root, '.threadshelf-history');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(await realpath(directory)) !== root)
    throw new Error('Unsafe note history directory');
  const key = `${Date.now()}-${randomUUID()}`;
  // A manifest associates the retained source with its original relative path.
  const saved = await open(join(directory, `${key}.json`), 'wx', 0o600);
  try {
    await saved.writeFile(
      JSON.stringify({ path: note.path, revision: note.revision, content: note.content }),
      'utf8',
    );
    await saved.sync();
  } finally {
    await saved.close();
  }
  await syncDirectory(directory);
};

export interface WriteProposal {
  readonly operation: 'create' | 'edit';
  readonly path: unknown;
  readonly content: unknown;
  readonly revision?: unknown;
}
export interface WriteSnapshot {
  readonly root: string;
  readonly operation: 'create' | 'edit';
  readonly path: string;
  readonly before: string;
  readonly content: string;
  readonly revision?: string;
}
export const prepareVaultWrite = async (input: WriteProposal): Promise<WriteSnapshot> => {
  if (input.operation !== 'create' && input.operation !== 'edit')
    throw new Error('Invalid note operation');
  const root = await rootNow(true);
  const path = notePath(input.path);
  const content = contentValue(input.content);
  if (input.operation === 'create') {
    const target = await safeTarget(root, path, true);
    if (await lstat(target).catch(() => undefined)) throw new Error('Note already exists');
    return { root, operation: 'create', path, before: '', content };
  }
  const note = await readAt(root, path);
  if (typeof input.revision !== 'string' || note.revision !== input.revision)
    throw new Error('Note changed; read it again before editing');
  return { root, operation: 'edit', path, before: note.content, content, revision: note.revision };
};
export const executeApprovedWrite = async (
  snapshot: WriteSnapshot,
  signal?: AbortSignal,
): Promise<VaultNote> =>
  inVault(snapshot.root, async () => {
    signal?.throwIfAborted();
    await rootNow(true, snapshot.root);
    return snapshot.operation === 'create'
      ? createVaultNote(snapshot.path, snapshot.content)
      : editVaultNote(snapshot.path, snapshot.content, snapshot.revision);
  });

export interface DeleteSnapshot {
  readonly root: string;
  readonly files: readonly { path: string; revision: string }[];
}
export const prepareVaultDelete = async (paths: unknown): Promise<DeleteSnapshot> => {
  if (!Array.isArray(paths) || !paths.length || paths.length > 20)
    throw new Error('Choose 1–20 Markdown notes');
  const names = [...new Set(paths.map(notePath))];
  const root = await rootNow(true);
  const files = [];
  // Case/normalization variants (`Note.md`, `note.md`) can name one file; list it once.
  const seen = new Set<string>();
  for (const path of names) {
    const stat = await lstat(await safeTarget(root, path), { bigint: true });
    const identity = `${stat.dev}:${stat.ino}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const note = await readAt(root, path);
    files.push({ path, revision: note.revision });
  }
  return { root, files };
};

const trashDirectory = async (root: string): Promise<string> => {
  const link = join(root, '.trash');
  await mkdir(link, { recursive: true });
  const stat = await lstat(link);
  const trash = await realpath(link);
  // Case-insensitive volumes may already hold `.Trash`; any other location is unsafe.
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    dirname(trash) !== root ||
    basename(trash).toLowerCase() !== '.trash'
  )
    throw new Error('Unsafe trash directory');
  return trash;
};

/** Called only by the approval manager, never an HTTP/MCP/model tool. */
/** A batch delete that failed after moving some notes; `deleted` lists exactly those. */
export class PartialDeleteError extends Error {
  constructor(
    message: string,
    readonly deleted: readonly string[],
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

/** Test seam: runs after each note is moved, to inject a failure mid-batch. */
export const deleteTestHooks: { afterMove?: (index: number) => Promise<void> } = {};

export const executeApprovedDelete = async (
  snapshot: DeleteSnapshot,
  signal?: AbortSignal,
): Promise<{ deleted: string[]; trash: string }> =>
  withWrite(async (root) => {
    signal?.throwIfAborted();
    for (const file of snapshot.files) {
      if ((await readAt(root, file.path)).revision !== file.revision)
        throw new Error('A note changed since the deletion request; request confirmation again');
    }
    const batch = join(await trashDirectory(root), `threadshelf-${randomUUID()}`);
    await mkdir(batch);
    await writeFile(
      join(batch, 'manifest.json'),
      JSON.stringify({
        version: 1,
        files: snapshot.files.map((file, i) => ({
          ...file,
          storedAs: `${i}-${basename(file.path)}`,
        })),
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const deleted: string[] = [];
    try {
      for (let i = 0; i < snapshot.files.length; i++) {
        signal?.throwIfAborted();
        const file = snapshot.files[i]!;
        await rootNow(true, root);
        const target = await safeTarget(root, file.path);
        if ((await readAt(root, file.path)).revision !== file.revision)
          throw new Error('Note changed before deletion');
        await rename(target, join(batch, `${i}-${basename(file.path)}`));
        deleted.push(file.path);
        await deleteTestHooks.afterMove?.(i);
      }
    } catch (error) {
      if (!deleted.length) {
        await unlink(join(batch, 'manifest.json')).catch(() => undefined);
        await rmdir(batch).catch(() => undefined);
        throw new Error(`Deletion stopped before any note moved: ${vaultErrorMessage(error)}`, {
          cause: error,
        });
      }
      throw new PartialDeleteError(
        `Deletion stopped (${vaultErrorMessage(error)}). Notes already moved to trash: ${JSON.stringify(deleted)}`,
        deleted,
        error,
      );
    }
    return { deleted, trash: relative(root, batch).replace(/\\/g, '/') };
  }, snapshot.root);

export const searchVault = async (
  query: unknown,
  limit: unknown = 10,
  signal?: AbortSignal,
): Promise<VaultSearchResult> => {
  if (typeof query !== 'string' || !query.trim() || query.length > 1000)
    throw new Error('Search query must contain 1–1000 characters');
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 30)
    throw new Error('Search limit must be 1–30');
  const root = await rootNow();
  const terms = [...new Set(query.toLocaleLowerCase().trim().split(/\s+/))];
  const hits: (VaultHit & { score: number })[] = [];
  let scanned = 0;
  let skipped = 0;
  let bytes = 0;
  let truncated = false;
  let entries = 0;
  const visit = async (directory: string, depth = 0): Promise<void> => {
    if (depth > 64) {
      truncated = true;
      return;
    }
    signal?.throwIfAborted();
    await rootNow(false, root);
    // Stream directory entries: an unrelated huge folder must not allocate an
    // unbounded listing before the scan's entry budget can stop it.
    const listing = await opendir(directory);
    for await (const entry of listing) {
      signal?.throwIfAborted();
      if (++entries > MAX_FILES || bytes > MAX_SCAN_BYTES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.')) continue;
      const markdown = entry.name.toLowerCase().endsWith('.md');
      if (entry.isSymbolicLink()) {
        if (markdown) skipped++;
        continue;
      }
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        const stat = await lstat(target).catch(() => undefined);
        if (stat?.isDirectory() && !stat.isSymbolicLink() && inside(root, await realpath(target)))
          await visit(target, depth + 1);
        if (truncated) return;
      } else if (entry.isFile() && markdown) {
        let note: VaultNote;
        try {
          note = await readAt(root, relative(root, target));
        } catch {
          // Unsafe names (e.g. `a:b.md` on Linux), hard links, oversized or locked files.
          skipped++;
          continue;
        }
        scanned++;
        bytes += Buffer.byteLength(note.content);
        const lower = note.content.toLocaleLowerCase();
        const name = note.path.toLocaleLowerCase();
        const score = terms.reduce(
          (sum, term) => sum + (name.includes(term) ? 5 : 0) + (lower.includes(term) ? 1 : 0),
          0,
        );
        if (!terms.every((term) => name.includes(term) || lower.includes(term))) continue;
        const lines = note.content.split(/\r?\n/);
        const index = Math.max(
          0,
          lines.findIndex((line) => terms.some((term) => line.toLocaleLowerCase().includes(term))),
        );
        const title =
          lines
            .find((line) => /^#\s+/.test(line))
            ?.replace(/^#\s+/, '')
            .slice(0, 200) || basename(note.path, '.md');
        hits.push({
          path: note.path,
          title,
          line: index + 1,
          heading: lines
            .slice(0, index + 1)
            .reverse()
            .find((line) => /^#{1,6}\s+/.test(line))
            ?.replace(/^#{1,6}\s+/, '')
            .slice(0, 200),
          snippet: lines
            .slice(index, index + 4)
            .join('\n')
            .slice(0, 800),
          score,
        });
        hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
        if (hits.length > (limit as number)) hits.pop();
      }
    }
  };
  await visit(root);
  return {
    hits: hits.map(({ score: _score, ...hit }) => hit),
    scanned,
    skipped,
    truncated,
  };
};
