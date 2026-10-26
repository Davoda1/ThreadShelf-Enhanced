import { open, realpath, lstat, readdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Reader, ZipReader, type Entry } from '@zip.js/zip.js';
import type { Turn } from '../validation.js';

const MAX_IMAGE_BYTES = 5 * 1024 ** 2;
const MAX_TOTAL_BYTES = 32 * 1024 ** 2;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
type Asset = { url: string; label?: string; source?: string };

const mimeType = (bytes: Uint8Array): string | undefined => {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return undefined;
};

/** Gather explicit media references, never arbitrary source strings or paths. */
const references = (turn: Turn): string[] => {
  const found = new Set<string>();
  const stack: unknown[] = [turn.raw, turn.metadata];
  let visited = 0;
  while (stack.length && visited++ < 8000 && found.size < 100) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === 'string' &&
        /^(?:asset_pointer|image_url|url|src|path|file_name|filename)$/.test(key)
      ) {
        if (key === 'asset_pointer' || key === 'image_url' || IMAGE_EXTENSION.test(child))
          found.add(child);
      } else if (child && typeof child === 'object') stack.push(child);
    }
  }
  const text = turn.user ?? turn.ai ?? turn.thinking ?? '';
  for (const match of text.matchAll(/!\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+[^)]+)?\)/g)) {
    const source = match[1] ?? match[2];
    if (source && found.size < 100) found.add(source);
  }
  return [...found];
};

const localReference = (source: string): string | undefined => {
  let value = source;
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  value = value.replace(/\\/g, '/');
  if (/^sandbox:\/(?:mnt\/data\/)?/i.test(value))
    value = value.replace(/^sandbox:\/(?:mnt\/data\/)?/i, '');
  else if (/^(?:file-service|attachment):\/\//i.test(value))
    value = value.replace(/^(?:file-service|attachment):\/\//i, '');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  if (!value || value.includes('\0') || value.startsWith('/') || value.split('/').includes('..'))
    return undefined;
  return value.replace(/^\.\//, '');
};

/** Random access keeps large archives off the JS heap while resolving a few images. */
class FileReader extends Reader<unknown> {
  constructor(
    private readonly handle: Awaited<ReturnType<typeof open>>,
    size: number,
  ) {
    super(undefined);
    this.size = size;
  }
  async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(length) ||
      index < 0 ||
      length < 0 ||
      length > 64 * 1024 ** 2 ||
      index + length > this.size
    )
      throw new Error('Invalid archive bounds');
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const result = await this.handle.read(bytes, offset, length - offset, index + offset);
      if (!result.bytesRead) throw new Error('Truncated archive');
      offset += result.bytesRead;
    }
    return new Uint8Array(bytes);
  }
}

export interface MediaResolver {
  resolveTurns(turns: readonly Turn[], sourceFile: string): Promise<Turn[]>;
  close(): Promise<void>;
}

/** Only explicitly referenced, bounded raster images under the selected source are read. */
export const createMediaResolver = async (
  sourcePath: string,
  signal?: AbortSignal,
): Promise<MediaResolver> => {
  let total = 0;
  let attachedBytes = 0;
  const cache = new Map<string, Asset | null>();
  let archive: ZipReader<unknown> | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const entries: Entry[] = [];
  let folderEntries: string[] | undefined;
  const root = await realpath(dirname(sourcePath));
  const initializeArchive = async () => {
    if (archive || !/\.zip$/i.test(sourcePath)) return;
    handle = await open(sourcePath, 'r');
    const size = (await handle.stat()).size;
    archive = new ZipReader(new FileReader(handle, size), { useWebWorkers: false });
    for await (const entry of archive.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (entries.length >= 100000) throw new Error('Too many archive members');
      entries.push(entry);
    }
  };
  const readReference = async (
    source: string,
    memberSource: string,
  ): Promise<Asset | undefined> => {
    signal?.throwIfAborted();
    const target = localReference(source);
    if (!target || total >= MAX_TOTAL_BYTES) return undefined;
    const cacheKey = `${memberSource}\0${source}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? undefined;
    if (cache.size >= 512) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, null);
    let bytes: Uint8Array | undefined;
    if (/\.zip$/i.test(sourcePath)) {
      await initializeArchive();
      const member = memberSource.startsWith(`${sourcePath}!`)
        ? memberSource.slice(sourcePath.length + 1)
        : '';
      const local = `${dirname(member).replace(/\\/g, '/')}/${target}`.replace(/^\.\//, '');
      const matches = entries.filter(
        (entry) =>
          !entry.directory &&
          !entry.encrypted &&
          IMAGE_EXTENSION.test(entry.filename) &&
          (entry.filename === target ||
            entry.filename === local ||
            basename(entry.filename) === basename(target) ||
            (!extname(target) && basename(entry.filename).startsWith(`${basename(target)}.`))),
      );
      if (matches.length !== 1) return undefined;
      const entry = matches[0]!;
      if (
        entry.uncompressedSize > MAX_IMAGE_BYTES ||
        entry.uncompressedSize + total > MAX_TOTAL_BYTES
      )
        return undefined;
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!('getData' in entry)) return undefined;
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            signal?.throwIfAborted();
            size += chunk.length;
            if (size > MAX_IMAGE_BYTES || size + total > MAX_TOTAL_BYTES)
              throw new Error('Image exceeds limit');
            chunks.push(chunk);
          },
        }),
        { checkSignature: true, useWebWorkers: false, signal },
      );
      bytes = Buffer.concat(chunks);
    } else {
      let targetPath = resolve(root, target);
      if (!extname(target)) {
        folderEntries ??= await readdir(root);
        const matches = folderEntries.filter(
          (name) => IMAGE_EXTENSION.test(name) && name.startsWith(`${basename(target)}.`),
        );
        if (matches.length !== 1) return undefined;
        targetPath = resolve(root, matches[0]!);
      }
      if (!IMAGE_EXTENSION.test(targetPath)) return undefined;
      const canonical = await realpath(targetPath);
      const rel = relative(root, canonical);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
      const stat = await lstat(targetPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > MAX_IMAGE_BYTES ||
        stat.size + total > MAX_TOTAL_BYTES
      )
        return undefined;
      const file = await open(canonical, 'r');
      try {
        // Bound the actual read even if another process grows the source file.
        const buffer = Buffer.alloc(stat.size);
        const result = await file.read(buffer, 0, buffer.length, 0);
        if (result.bytesRead !== stat.size) return undefined;
        bytes = buffer;
      } finally {
        await file.close();
      }
    }
    const mime = bytes && mimeType(bytes);
    if (!bytes || !mime) return undefined;
    total += bytes.length;
    const asset = {
      source,
      label: basename(target),
      url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
    };
    cache.set(cacheKey, asset);
    return asset;
  };
  return {
    async resolveTurns(turns, sourceFile) {
      const result: Turn[] = [];
      for (const turn of turns) {
        signal?.throwIfAborted();
        const assets: Asset[] = [...(turn.assets ?? [])];
        for (const source of references(turn)) {
          if (assets.some((entry) => entry.source === source)) continue;
          try {
            const asset = await readReference(source, sourceFile);
            if (
              asset &&
              !assets.some((entry) => entry.source === asset.source) &&
              attachedBytes + asset.url.length <= Math.ceil((MAX_TOTAL_BYTES * 4) / 3)
            ) {
              assets.push(asset);
              attachedBytes += asset.url.length;
            }
          } catch (error) {
            if (signal?.aborted)
              throw error; /* Leave unresolved/corrupt images as readable placeholders. */
          }
        }
        result.push(assets.length ? { ...turn, assets } : turn);
      }
      return result;
    },
    async close() {
      try {
        await archive?.close();
      } finally {
        await handle?.close();
      }
    },
  };
};
