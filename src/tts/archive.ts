import { createReadStream } from 'node:fs';
import { mkdir, open, lstat, readdir, copyFile, chmod, readFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, posix } from 'node:path';
import { createGunzip } from 'node:zlib';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

const MAX_EXPANDED = 2 * 1024 ** 3;
const MAX_FILE = 512 * 1024 ** 2;
const MAX_FILES = 100_000;
const unsafeCharacter = (value: string): boolean =>
  [...value].some((c) => c.charCodeAt(0) < 32 || c === ':');
/** Install archives only into a fresh private staging tree. Never retain links. */
export const safeMember = (name: string): string => {
  const clean = name.replace(/^\.\//, '').replace(/\/$/, '');
  if (
    !clean ||
    name.includes('\\') ||
    unsafeCharacter(name) ||
    name.startsWith('/') ||
    clean.split('/').some((p) => !p || p === '..' || p === '.')
  )
    throw new Error('Unsafe speech archive member');
  return clean;
};
const contained = (root: string, name: string): string => {
  const result = resolve(root, safeMember(name));
  if (relative(root, result).startsWith('..'))
    throw new Error('Speech archive escaped its staging directory');
  return result;
};
const octal = (bytes: Buffer): number => {
  if (bytes[0]! & 0x80) throw new Error('Unsupported speech archive size encoding');
  const value = parseInt(bytes.toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid speech archive size');
  return value;
};
const cstring = (value: Buffer): string => value.toString('utf8').replace(/\0.*$/s, '');
function parsePax(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    const length = Number(data.subarray(offset, space).toString());
    if (space < offset || !Number.isInteger(length) || length < 4 || offset + length > data.length)
      throw new Error('Invalid archive metadata');
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) result[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return result;
}
export async function extractTarGz(
  archive: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const input = createReadStream(archive).pipe(createGunzip());
  const abort = (): void => {
    input.destroy(new Error('Speech installation cancelled'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  const iterator = input[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0),
    done = false,
    total = 0,
    count = 0;
  const read = async (size: number): Promise<Buffer> => {
    while (pending.length < size && !done) {
      signal?.throwIfAborted();
      const next = await iterator.next();
      done = !!next.done;
      if (!done) {
        total += next.value.length;
        if (total > MAX_EXPANDED) throw new Error('Speech archive expansion limit exceeded');
        pending = Buffer.concat([pending, next.value]);
      }
    }
    if (pending.length < size) throw new Error('Incomplete speech archive');
    const result = pending.subarray(0, size);
    pending = pending.subarray(size);
    return result;
  };
  const names = new Set<string>(),
    links = new Map<string, string>();
  let pax: Record<string, string> = {},
    longName = '',
    longLink = '';
  try {
    for (;;) {
      const header = await read(512);
      if (header.every((b) => b === 0)) break;
      const sum = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
      if (sum !== octal(header.subarray(148, 156)))
        throw new Error('Invalid speech archive checksum');
      let size = octal(header.subarray(124, 136));
      const type = String.fromCharCode(header[156] || 48);
      if (['x', 'g', 'L', 'K'].includes(type)) {
        if (size > 1024 * 1024) throw new Error('Speech archive metadata too large');
        const data = await read(size);
        if (size % 512) await read(512 - (size % 512));
        if (type === 'x') pax = parsePax(data);
        else if (type === 'g') {
          const global = parsePax(data);
          if (Object.keys(global).some((k) => ['path', 'linkpath', 'size'].includes(k)))
            throw new Error('Unsafe global archive metadata');
        } else if (type === 'L') longName = cstring(data).replace(/\n$/, '');
        else longLink = cstring(data).replace(/\n$/, '');
        continue;
      }
      const prefix = cstring(header.subarray(345, 500));
      const name = safeMember(
        pax.path ||
          longName ||
          [prefix, cstring(header.subarray(0, 100))].filter(Boolean).join('/'),
      );
      if (pax.size !== undefined) {
        size = Number(pax.size);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid archive member size');
      }
      const link = pax.linkpath || longLink || cstring(header.subarray(157, 257));
      pax = {};
      longName = '';
      longLink = '';
      if (++count > MAX_FILES || size > MAX_FILE)
        throw new Error('Speech archive member limit exceeded');
      if (names.has(name)) throw new Error('Duplicate speech archive member');
      names.add(name);
      const target = contained(destination, name);
      if (type === '5') {
        if (size) throw new Error('Invalid archive directory');
        await mkdir(target, { recursive: true, mode: 0o700 });
      } else if (type === '0' || type === '\0') {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const out = await open(target, 'wx', 0o600);
        try {
          let remaining = size;
          while (remaining) {
            const bytes = await read(Math.min(remaining, 64 * 1024));
            await out.writeFile(bytes);
            remaining -= bytes.length;
          }
        } finally {
          await out.close();
        }
        await chmod(target, octal(header.subarray(100, 108)) & 0o111 ? 0o755 : 0o644);
      } else if (type === '1' || type === '2') {
        if (size || !link || link.startsWith('/') || link.includes('\\') || unsafeCharacter(link))
          throw new Error('Unsafe archive link');
        const linkName = posix.normalize(
          type === '2' ? posix.join(posix.dirname(name), link) : link,
        );
        safeMember(linkName);
        links.set(name, linkName);
      } else throw new Error('Unsupported special speech archive member');
      if (size % 512) await read(512 - (size % 512));
    }
    const resolving = new Set<string>();
    const materialize = async (name: string): Promise<void> => {
      const sourceName = links.get(name);
      if (!sourceName) return;
      if (resolving.has(name)) throw new Error('Cyclic archive link');
      resolving.add(name);
      await materialize(sourceName);
      const source = contained(destination, sourceName),
        target = contained(destination, name);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('Archive link must target a regular file');
      total += info.size;
      if (total > MAX_EXPANDED) throw new Error('Speech archive link expansion limit exceeded');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      await chmod(target, info.mode & 0o777);
      links.delete(name);
      resolving.delete(name);
    };
    for (const name of [...links.keys()]) await materialize(name);
  } finally {
    signal?.removeEventListener('abort', abort);
    input.destroy();
  }
}
export async function extractZip(
  archive: string,
  destination: string,
  wheel: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const raw = await readFile(archive);
  if (raw.length > 128 * 1024 ** 2) throw new Error('Speech ZIP archive exceeds limit');
  const reader = new ZipReader(new Uint8ArrayReader(raw));
  let count = 0,
    total = 0;
  const seen = new Set<string>();
  try {
    for await (const item of reader.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (++count > MAX_FILES) throw new Error('Too many speech archive entries');
      let name = safeMember(item.filename);
      if (item.directory) continue;
      const mode = (item.externalFileAttributes >>> 16) & 0xffff;
      if ((mode & 0o170000) === 0o120000) throw new Error('Speech ZIP links are forbidden');
      if (wheel) {
        const parts = name.split('/');
        if (parts[0]?.endsWith('.data') && ['purelib', 'platlib'].includes(parts[1] || ''))
          name = parts.slice(2).join('/');
      }
      if (seen.has(name)) throw new Error('Duplicate speech archive member');
      seen.add(name);
      total += item.uncompressedSize;
      if (item.uncompressedSize > 128 * 1024 ** 2 || total > MAX_EXPANDED)
        throw new Error('Speech archive expansion limit exceeded');
      const target = contained(destination, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const bytes = await item.getData!(new Uint8ArrayWriter(), { checkSignature: true, signal });
      const file = await open(target, 'wx', mode & 0o111 ? 0o755 : 0o644);
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
    }
  } finally {
    await reader.close();
  }
}
export async function regularFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Links are forbidden in installed speech assets');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push(relative(root, path).split('\\').join('/'));
      else throw new Error('Special speech asset file');
    }
  };
  await walk(root);
  return result.sort();
}
