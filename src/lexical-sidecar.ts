/** Disposable lexical acceleration; LanceDB and its publication metadata remain authoritative. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SearchResult } from './store.js';
import { lexicalTerms } from './search-ranking.js';
import { withInterprocessLock } from './interprocess-lock.js';

const FORMAT = 2;
// Encode normalized tokens so SQLite Unicode-version differences cannot omit
// a word which the JavaScript fallback recognises.
const tokenKey = (term: string): string => `t${Buffer.from(term).toString('hex')}`;
const MAX_BUILD_BYTES = 256 * 1024 * 1024;
const safeFile = async (path: string): Promise<boolean> => {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

interface SidecarOptions {
  readonly directory: string;
  readonly collection: string;
  readonly fingerprint: string;
  readonly query: string;
  readonly signal?: AbortSignal;
  readonly source: () => AsyncIterable<SearchResult>;
  readonly onResult: (row: SearchResult) => void;
  readonly onReset: () => void;
}

/** Returns false on unavailable/corrupt/busy cache. Caller then scans the complete snapshot. */
export const readLexicalSidecar = async (opts: SidecarOptions): Promise<boolean> => {
  if (process.env.THREADSHELF_LEXICAL_CACHE === '0') return false;
  const terms = lexicalTerms(opts.query);
  if (!terms.length) return false;
  const prefix = createHash('sha256').update(opts.collection).digest('hex').slice(0, 24);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([FORMAT, opts.fingerprint]))
    .digest('hex');
  const target = join(opts.directory, `${prefix}-${fingerprint}.sqlite`);
  const read = async (): Promise<boolean> => {
    opts.onReset();
    if (!(await safeFile(target))) return false;
    const database = new DatabaseSync(target, { readOnly: true });
    try {
      const meta = database.prepare('SELECT fingerprint FROM metadata').get();
      if (meta?.fingerprint !== fingerprint) return false;
      const query = terms.map((term) => `"${tokenKey(term)}"`).join(' OR ');
      // Materialize at most one row at a time. FTS only narrows the *lexical*
      // branch; every matching row still receives application filters/ranking.
      const rows = database
        .prepare(
          'SELECT payload FROM documents JOIN words ON documents.id = words.rowid WHERE words MATCH ?',
        )
        .iterate(query);
      let count = 0;
      for (const row of rows) {
        if (count++ % 256 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          opts.signal?.throwIfAborted();
        }
        opts.onResult(JSON.parse(String(row.payload)) as SearchResult);
      }
      return true;
    } finally {
      database.close();
    }
  };
  try {
    try {
      if (await read()) return true;
    } catch {
      opts.signal?.throwIfAborted();
    }
    await mkdir(opts.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(opts.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    return await withInterprocessLock(
      join(opts.directory, `${prefix}-build`),
      async () => {
        try {
          if (await read()) return true;
        } catch {
          opts.signal?.throwIfAborted();
        }
        const staging = join(opts.directory, `${prefix}-${randomUUID()}.tmp`);
        let database: DatabaseSync | undefined;
        try {
          database = new DatabaseSync(staging);
          await chmod(staging, 0o600);
          database.exec(`
          PRAGMA journal_mode = OFF;
          PRAGMA synchronous = OFF;
          CREATE TABLE metadata (fingerprint TEXT NOT NULL);
          CREATE TABLE documents (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
          CREATE VIRTUAL TABLE words USING fts5(content, tokenize = 'unicode61 remove_diacritics 2');
          BEGIN;
        `);
          const insertDocument = database.prepare('INSERT INTO documents VALUES (?, ?)');
          const insertWords = database.prepare('INSERT INTO words(rowid, content) VALUES (?, ?)');
          let id = 0,
            bytes = 0;
          for await (const row of opts.source()) {
            opts.signal?.throwIfAborted();
            const payload = JSON.stringify(row);
            bytes += Buffer.byteLength(payload, 'utf8');
            if (bytes > MAX_BUILD_BYTES) throw new Error('Lexical cache size budget exceeded');
            insertDocument.run(++id, payload);
            // No term cap for documents: the query cap must never truncate the index.
            const words =
              `${row.metadata.title ?? ''} ${row.document}`
                .normalize('NFKD')
                .replace(/\p{M}/gu, '')
                .toLowerCase()
                .match(/[\p{L}\p{N}]+/gu) ?? [];
            insertWords.run(id, words.map(tokenKey).join(' '));
            if (id % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          }
          database.prepare('INSERT INTO metadata VALUES (?)').run(fingerprint);
          database.exec('COMMIT;');
          database.close();
          database = undefined;
          opts.signal?.throwIfAborted();
          await rename(staging, target);
          // Retain two completed snapshots per collection. Open Unix readers keep
          // their handles; Windows sharing failures simply defer cache cleanup.
          const old = [];
          for (const name of await readdir(opts.directory)) {
            if (
              !name.startsWith(`${prefix}-`) ||
              !/^[a-f0-9]{24}-[a-f0-9]{64}\.sqlite$/.test(name) ||
              join(opts.directory, name) === target
            )
              continue;
            const path = join(opts.directory, name);
            const stat = await lstat(path);
            if (stat.isFile() && !stat.isSymbolicLink()) old.push({ path, mtime: stat.mtimeMs });
          }
          old.sort((a, b) => b.mtime - a.mtime);
          for (const item of old.slice(1)) await rm(item.path).catch(() => undefined);
          return read();
        } finally {
          database?.close();
          await rm(staging, { force: true }).catch(() => undefined);
        }
      },
      { timeoutMs: 0, signal: opts.signal },
    );
  } catch {
    opts.signal?.throwIfAborted();
    return false;
  }
};
