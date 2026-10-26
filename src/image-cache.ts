import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdirSync, chmodSync } from 'node:fs';
import { readFile, writeFile, rename, unlink, opendir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataPath } from './paths.js';
import { withInterprocessLock } from './interprocess-lock.js';
import { normalizeCollectionName } from './validation.js';

const MiB = 1024 ** 2;
const MAX_IMAGE_BYTES = 16 * MiB;
const root = process.env.THREADSHELF_IMAGE_CACHE_PATH || dataPath('imageCache');
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
let db: DatabaseSync | undefined;
const database = (): DatabaseSync => {
  if (db) return db;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'metadata.sqlite');
  db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, maxBytes INTEGER NOT NULL, epoch INTEGER NOT NULL);
    INSERT OR IGNORE INTO settings VALUES(1,0,536870912,0);
    CREATE TABLE IF NOT EXISTS collection_epochs (collection TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, collection TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, accessedAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS images_collection ON images(collection);
    CREATE INDEX IF NOT EXISTS images_filename ON images(filename);
  `);
  return db;
};

export interface ImageCacheStats {
  enabled: boolean;
  maxBytes: number;
  bytes: number;
  count: number;
  collections: { collection: string; bytes: number; count: number }[];
}
interface Config {
  enabled: number;
  maxBytes: number;
  epoch: number;
}
const config = (): Config =>
  database()
    .prepare('SELECT enabled,maxBytes,epoch FROM settings WHERE id=1')
    .get() as unknown as Config;
const epoch = (collection: string): number =>
  Number(
    database().prepare('SELECT epoch FROM collection_epochs WHERE collection=?').get(collection)
      ?.epoch ?? 0,
  );

export const imageCacheStats = (): ImageCacheStats => {
  const c = config();
  const collections = database()
    .prepare(
      'SELECT collection,SUM(bytes) AS bytes,COUNT(*) AS count FROM images GROUP BY collection ORDER BY collection',
    )
    .all() as unknown as ImageCacheStats['collections'];
  return {
    enabled: !!c.enabled,
    maxBytes: c.maxBytes,
    bytes: collections.reduce((n, x) => n + x.bytes, 0),
    count: collections.reduce((n, x) => n + x.count, 0),
    collections,
  };
};

const ownedFilename = (filename: string): boolean =>
  /^[a-f0-9]{64}-[a-f0-9-]{36}\.image(?:\.tmp)?$/.test(filename);
let reconciled = false;
/** Recover abandoned temporary/publication files after an interrupted cache write. */
const reconcileFiles = async (): Promise<void> => {
  const known = database().prepare('SELECT 1 FROM images WHERE filename=? LIMIT 1');
  for await (const entry of await opendir(root)) {
    if (!entry.isFile() || !ownedFilename(entry.name)) continue;
    if (entry.name.endsWith('.tmp') || !known.get(entry.name))
      await unlink(join(root, entry.name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
};
const cacheLock = <T>(fn: () => Promise<T>): Promise<T> =>
  withInterprocessLock(join(root, 'cache-write'), async () => {
    if (!reconciled) {
      await reconcileFiles();
      reconciled = true;
    }
    return fn();
  });
const removeCached = async (key: string, filename: string): Promise<void> => {
  database().prepare('DELETE FROM images WHERE key=?').run(key);
  if (!ownedFilename(filename)) return;
  await unlink(join(root, filename)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
};
const evictTo = async (targetBytes: number): Promise<void> => {
  let bytes = Number(
    database().prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM images').get()?.bytes ?? 0,
  );
  while (bytes > targetBytes) {
    const row = database()
      .prepare('SELECT key,filename,bytes FROM images ORDER BY accessedAt,key LIMIT 1')
      .get();
    if (!row) break;
    await removeCached(String(row.key), String(row.filename));
    bytes -= Number(row.bytes);
  }
};

export const configureImageCache = async (settings: {
  enabled?: boolean;
  maxBytes?: number;
}): Promise<ImageCacheStats> => {
  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean')
    throw new ImageRequestError('Invalid cache setting', 400);
  if (
    settings.maxBytes !== undefined &&
    (!Number.isSafeInteger(settings.maxBytes) ||
      settings.maxBytes < 16 * MiB ||
      settings.maxBytes > 4096 * MiB)
  )
    throw new ImageRequestError('Cache limit must be between 16 and 4096 MiB', 400);
  return cacheLock(async () => {
    const old = config();
    const enabled = settings.enabled === undefined ? old.enabled : Number(settings.enabled);
    const maxBytes = settings.maxBytes ?? old.maxBytes;
    database()
      .prepare('UPDATE settings SET enabled=?,maxBytes=?,epoch=epoch+1 WHERE id=1')
      .run(enabled, maxBytes);
    await evictTo(maxBytes);
    return imageCacheStats();
  });
};

/** Purging images never opens or mutates a conversation database. */
export const clearImageCache = async (collection?: string): Promise<ImageCacheStats> => {
  // Only an omitted collection means a global purge; an empty selector is invalid.
  if (collection !== undefined) collection = normalizeCollectionName(collection);
  return cacheLock(async () => {
    if (collection) {
      database()
        .prepare(
          'INSERT INTO collection_epochs VALUES(?,1) ON CONFLICT(collection) DO UPDATE SET epoch=epoch+1',
        )
        .run(collection);
    } else database().prepare('UPDATE settings SET epoch=epoch+1 WHERE id=1').run();
    for (;;) {
      const row = collection
        ? database()
            .prepare('SELECT key,filename FROM images WHERE collection=? LIMIT 1')
            .get(collection)
        : database().prepare('SELECT key,filename FROM images LIMIT 1').get();
      if (!row) break;
      await removeCached(String(row.key), String(row.filename));
    }
    await reconcileFiles();
    return imageCacheStats();
  });
};

export class ImageRequestError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'ImageRequestError';
  }
}

/** Reject local, special-use and transition addresses before connecting. */
export const isPublicImageAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    if (first < 0x2000 || first > 0x3fff || first === 0x2002) return false;
    const second = Number.parseInt(normalized.split(':')[1] || '0', 16);
    // RFC 9637 reserves 3fff::/20 for documentation, not public image origins.
    if (first === 0x3fff && second < 0x1000) return false;
    if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return false;
    return true;
  }
  return false;
};

export const validateImageUrl = (input: string): URL => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ImageRequestError('Invalid image URL', 400);
  }
  if (
    input.length > 8192 ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new ImageRequestError('Unsupported image URL', 400);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.includes('%') ||
    (isIP(host) && !isPublicImageAddress(host))
  )
    throw new ImageRequestError('Image source must use a public network address', 400);
  url.hash = '';
  return url;
};

export const sniffImageMime = (bytes: Buffer): string | undefined => {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > 80_000_000) return undefined;
    return 'image/png';
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) {
    if (bytes.readUInt16LE(6) * bytes.readUInt16LE(8) > 80_000_000) return undefined;
    return 'image/gif';
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  if (
    bytes.length >= 16 &&
    bytes.subarray(4, 8).toString('ascii') === 'ftyp' &&
    /^(avif|avis)$/.test(bytes.subarray(8, 12).toString('ascii'))
  )
    return 'image/avif';
  return undefined;
};

export interface DownloadedImage {
  bytes: Buffer;
  mime: string;
  cacheable: boolean;
}
type Lookup = typeof lookup;
type Transport = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ReturnType<typeof httpRequest>;
export const downloadImage = async (
  input: string,
  dependencies: { lookup?: Lookup; transport?: Transport } = {},
): Promise<DownloadedImage> => {
  let url = validateImageUrl(input);
  const deadline = Date.now() + 20_000;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const records = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await Promise.race([
          (dependencies.lookup ?? lookup)(host, { all: true, verbatim: true }),
          delayFailure(Math.max(1, deadline - Date.now())),
        ]);
    if (!records.length || records.some((r) => !isPublicImageAddress(r.address)))
      throw new ImageRequestError('Image source resolved to a blocked address', 400);
    const pinned = records[0]!;
    const response = await new Promise<IncomingMessage>((resolveResponse, reject) => {
      const transport =
        dependencies.transport ?? (url.protocol === 'https:' ? httpsRequest : httpRequest);
      const request = transport(
        url,
        {
          method: 'GET',
          agent: false,
          family: pinned.family,
          headers: {
            Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif',
            'Accept-Encoding': 'identity',
            'User-Agent': 'ThreadShelf-ImageLoader/1.3.0',
          },
          lookup: (_name, _options, callback) => callback(null, pinned.address, pinned.family),
        },
        resolveResponse,
      );
      const timer = setTimeout(
        () => request.destroy(new ImageRequestError('Image request timed out', 504)),
        Math.max(1, deadline - Date.now()),
      );
      timer.unref();
      request.once('close', () => clearTimeout(timer));
      request.once('error', reject);
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const next = response.headers.location;
      response.destroy();
      if (!next || redirects === 4) throw new ImageRequestError('Image redirect limit reached');
      url = validateImageUrl(new URL(next, url).toString());
      continue;
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new ImageRequestError('Image source did not return an image');
    }
    const declared = Number(response.headers['content-length']);
    if (
      declared > MAX_IMAGE_BYTES ||
      (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
    ) {
      response.destroy();
      throw new ImageRequestError('Image exceeds the download limit', 413);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of response) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES || Date.now() > deadline) {
        response.destroy();
        throw new ImageRequestError('Image exceeds the download limit', 413);
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    const mime = sniffImageMime(bytes);
    if (!mime) throw new ImageRequestError('Unsupported or invalid image content', 415);
    return {
      bytes,
      mime,
      cacheable: !/\bno-store\b/i.test(String(response.headers['cache-control'] ?? '')),
    };
  }
  throw new ImageRequestError('Image redirect limit reached');
};
const delayFailure = (ms: number): Promise<never> =>
  new Promise((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ImageRequestError('Image DNS lookup timed out', 504)),
      ms,
    );
    timer.unref();
  });

const inFlight = new Map<string, Promise<DownloadedImage>>();
let activeImages = 0;
interface ImageWaiter {
  resolve: (release: () => void) => void;
  timer: ReturnType<typeof setTimeout>;
}
const imageWaiters: ImageWaiter[] = [];
const releaseImageSlot = (): (() => void) => {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = imageWaiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(releaseImageSlot());
    } else activeImages--;
  };
};
/** Queue URLs, never downloaded buffers; each slot covers cache reads and writes too. */
const acquireImageSlot = (): Promise<() => void> => {
  if (activeImages < 4) {
    activeImages++;
    return Promise.resolve(releaseImageSlot());
  }
  if (imageWaiters.length >= 32)
    return Promise.reject(
      new ImageRequestError('Image loader queue is full; try again shortly', 429),
    );
  return new Promise((resolveSlot, reject) => {
    const waiter: ImageWaiter = {
      resolve: resolveSlot,
      timer: setTimeout(() => {
        const index = imageWaiters.indexOf(waiter);
        if (index >= 0) imageWaiters.splice(index, 1);
        reject(new ImageRequestError('Image loader queue timed out; try again shortly', 504));
      }, 60_000),
    };
    waiter.timer.unref();
    imageWaiters.push(waiter);
  });
};
export const closeImageCache = (): void => {
  db?.close();
  db = undefined;
  reconciled = false;
};
export const getImageResource = async (
  input: string,
  selectedCollection?: string,
  fetchImage: (url: string) => Promise<DownloadedImage> = downloadImage,
): Promise<DownloadedImage> => {
  const url = validateImageUrl(input).toString();
  const collection =
    selectedCollection && !['all', '__all__'].includes(selectedCollection)
      ? normalizeCollectionName(selectedCollection)
      : undefined;
  const key = digest(`${collection ?? ''}\0${url}`);
  const c = config();
  const initialEpoch = collection ? epoch(collection) : 0;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const release = await acquireImageSlot();
    try {
      if (c.enabled && collection) {
        const row = database()
          .prepare('SELECT filename,mime,bytes FROM images WHERE key=? AND collection=?')
          .get(key, collection);
        if (row) {
          try {
            if (!ownedFilename(String(row.filename)))
              throw new ImageRequestError('Invalid image cache entry');
            const bytes = await readFile(join(root, String(row.filename)));
            if (bytes.length === Number(row.bytes) && sniffImageMime(bytes) === row.mime) {
              database().prepare('UPDATE images SET accessedAt=? WHERE key=?').run(Date.now(), key);
              return { bytes, mime: String(row.mime), cacheable: true };
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }
      const image = await fetchImage(url);
      if (image.bytes.length > MAX_IMAGE_BYTES || sniffImageMime(image.bytes) !== image.mime)
        throw new ImageRequestError('Unsupported or invalid image content', 415);
      if (c.enabled && collection && image.cacheable)
        await cacheLock(async () => {
          const current = config();
          if (!current.enabled || current.epoch !== c.epoch || epoch(collection) !== initialEpoch)
            return;
          await evictTo(Math.max(0, current.maxBytes - image.bytes.length));
          const filename = `${key}-${randomUUID()}.image`;
          const temporary = join(root, filename + '.tmp');
          let published = false;
          try {
            await writeFile(temporary, image.bytes, { mode: 0o600, flag: 'wx' });
            await rename(temporary, join(root, filename));
            const previous = database().prepare('SELECT filename FROM images WHERE key=?').get(key);
            database()
              .prepare(
                'INSERT INTO images VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET filename=excluded.filename,mime=excluded.mime,bytes=excluded.bytes,accessedAt=excluded.accessedAt',
              )
              .run(key, collection, filename, image.mime, image.bytes.length, Date.now());
            published = true;
            if (previous && ownedFilename(String(previous.filename)))
              await unlink(join(root, String(previous.filename))).catch(() => {});
          } finally {
            await unlink(temporary).catch(() => {});
            if (!published) await unlink(join(root, filename)).catch(() => {});
          }
        }).catch((error) => {
          // Cache failure must never prevent displaying already validated bytes.
          console.error(
            '[image-cache] cache write failed:',
            (error as NodeJS.ErrnoException).code ?? 'error',
          );
        });
      return image;
    } finally {
      release();
    }
  })();
  inFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(key);
  }
};
