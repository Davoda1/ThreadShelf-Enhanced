import { open, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Reader, ZipReader, type FileEntry } from '@zip.js/zip.js';
import { parseJSON } from './vendor/providers/common.mjs';

const MAX_ARCHIVE_BYTES = 1024 ** 4;
const MAX_DIRECTORY_READ = 64 * 1024 ** 2;
const MAX_ENTRIES = 100000;
const MAX_MANIFEST_BYTES = 1024 ** 2;

/** ZIP directories can be inspected without loading or extracting their members. */
class ArchiveReader extends Reader<unknown> {
  constructor(
    private readonly handle: Awaited<ReturnType<typeof open>>,
    size: number,
    private readonly signal?: AbortSignal,
  ) {
    super(undefined);
    this.size = size;
  }

  async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    this.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(length) ||
      index < 0 ||
      length < 0 ||
      length > MAX_DIRECTORY_READ ||
      index + length > this.size
    ) {
      throw new Error('Invalid ZIP directory bounds');
    }
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      this.signal?.throwIfAborted();
      const result = await this.handle.read(bytes, offset, length - offset, index + offset);
      if (!result.bytesRead) throw new Error('Truncated ZIP directory');
      offset += result.bytesRead;
    }
    return new Uint8Array(bytes);
  }
}

const identity = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(identity).join(',')}]`;
  if (value && typeof value === 'object') {
    const data = value as Record<string, unknown>;
    return `{${Object.keys(data)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${identity(data[key])}`)
      .join(',')}}`;
  }
  // parseJSON preserves integer tokens beyond Number precision as bigint.
  if (typeof value === 'bigint') return value.toString();
  return JSON.stringify(value) ?? 'null';
};

type Discovery = { native: boolean; manifestIdentity?: string };

const discover = async (filename: string, signal?: AbortSignal): Promise<Discovery> => {
  if (!/\.zip$/i.test(filename)) return { native: false };
  signal?.throwIfAborted();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let archive: ZipReader<unknown> | undefined;
  try {
    const info = await lstat(filename);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !Number.isSafeInteger(info.size) ||
      info.size > MAX_ARCHIVE_BYTES
    )
      return { native: false };
    handle = await open(filename, 'r');
    archive = new ZipReader(new ArchiveReader(handle, info.size, signal), { useWebWorkers: false });
    let hasDatabase = false;
    let manifest: FileEntry | undefined;
    const names = new Set<string>();
    for await (const entry of archive.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (names.size >= MAX_ENTRIES || names.has(entry.filename))
        throw new Error('Ambiguous or oversized ZIP directory');
      names.add(entry.filename);
      if (entry.directory) continue;
      if (/^db\/chunk-(?:0|[1-9][0-9]*)\.json$/.test(entry.filename)) hasDatabase = true;
      if (entry.filename === 'manifest.json') manifest = entry;
    }
    if (!manifest) return { native: hasDatabase };
    if (manifest.encrypted || manifest.uncompressedSize > MAX_MANIFEST_BYTES)
      return { native: false };
    const chunks: Uint8Array[] = [];
    let size = 0;
    await manifest.getData(
      new WritableStream<Uint8Array>({
        write(chunk) {
          signal?.throwIfAborted();
          size += chunk.byteLength;
          if (size > MAX_MANIFEST_BYTES)
            throw new Error('ZIP manifest exceeds the discovery limit');
          chunks.push(chunk);
        },
      }),
      { checkSignature: true, useWebWorkers: false, signal },
    );
    const value: unknown = parseJSON(Buffer.concat(chunks));
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).backupVersion === 4
    ) {
      return { native: true, manifestIdentity: identity(value) };
    }
    return { native: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    // Full import owns detailed diagnostics. Discovery must never silently drop
    // malformed, encrypted, or unsupported input from the selected files.
    return { native: false };
  } finally {
    try {
      await archive?.close();
    } finally {
      await handle?.close();
    }
  }
};

export interface NativeBackupGroups {
  readonly groups: readonly string[][];
  readonly diagnostics: string[];
}

/**
 * Match complete-container parts of a Venice v4 backup by the complete manifest.
 * Manifestless parts are associated only when one backup is unambiguous. Every
 * input remains represented; corruption and incomplete backups are diagnosed by
 * the normal importer before any replacement is committed.
 */
export const groupNativeBackupFiles = async (
  files: readonly string[],
  signal?: AbortSignal,
): Promise<NativeBackupGroups> => {
  signal?.throwIfAborted();
  const diagnostics: string[] = [];
  const normal: string[][] = [];
  const manifests = new Map<string, string[]>();
  const orphaned: string[] = [];
  const unique = new Map<string, string>();
  for (const filename of files)
    if (!unique.has(resolve(filename))) unique.set(resolve(filename), filename);
  for (const filename of unique.values()) {
    signal?.throwIfAborted();
    const result = await discover(filename, signal);
    if (result.manifestIdentity) {
      const group = manifests.get(result.manifestIdentity) ?? [];
      group.push(filename);
      manifests.set(result.manifestIdentity, group);
    } else if (result.native) orphaned.push(filename);
    else normal.push([filename]);
  }
  const native = [...manifests.values()].map((group) =>
    group.sort((a, b) => resolve(a).localeCompare(resolve(b))),
  );
  orphaned.sort((a, b) => resolve(a).localeCompare(resolve(b)));
  if (native.length === 1) native[0]!.push(...orphaned);
  else if (orphaned.length) {
    normal.push(...orphaned.map((filename) => [filename]));
    if (native.length > 1)
      diagnostics.push(
        `Cannot associate manifestless Venice backup parts with ${native.length} distinct backups: ${orphaned.join(', ')}. Import each complete backup separately.`,
      );
  }
  const groups = [...normal, ...native].sort((a, b) =>
    resolve(a[0]!).localeCompare(resolve(b[0]!)),
  );
  return { groups, diagnostics };
};
