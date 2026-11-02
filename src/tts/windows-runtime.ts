/** Pinned Microsoft app-local CRT support; never executes a redistributable installer. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { packagePath } from '../paths.js';
import { safeMember } from './archive.js';

export interface WindowsRuntimeAsset {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly kind: 'windows-runtime';
  readonly target: string;
  readonly filename: string;
}
export interface WindowsRuntimeManifest {
  readonly schema: 1;
  readonly version: string;
  readonly asset: WindowsRuntimeAsset;
  readonly files: readonly { member: string; name: string; size: number; sha256: string }[];
}
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const manifest = async (): Promise<WindowsRuntimeManifest> =>
  JSON.parse(
    await readFile(packagePath('tts', 'cpu', 'windows-runtime-manifest.json'), 'utf8'),
  ) as WindowsRuntimeManifest;
export const windowsRuntimeAsset = async (): Promise<WindowsRuntimeAsset> =>
  (await manifest()).asset;

const directory = async (stage: string, relativePath: string): Promise<string> => {
  const root = await realpath(stage);
  let target = root;
  for (const part of safeMember(relativePath).split('/')) {
    target = join(target, part);
    await mkdir(target, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(target);
    const rel = relative(root, await realpath(target));
    if (!stat.isDirectory() || stat.isSymbolicLink() || rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Unsafe Windows speech runtime directory');
  }
  return target;
};

/** Internal pure extraction seam; the installer always supplies the packaged pin. */
export const extractWindowsRuntime = async (
  archive: string,
  stage: string,
  trusted: WindowsRuntimeManifest,
  includePocket: boolean,
  signal?: AbortSignal,
): Promise<void> => {
  signal?.throwIfAborted();
  const stat = await lstat(archive);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== trusted.asset.size ||
    stat.size > 16 * 1024 ** 2
  )
    throw new Error('Windows speech runtime archive size is invalid');
  const raw = await readFile(archive);
  if (raw.length !== trusted.asset.size || sha256(raw) !== trusted.asset.sha256)
    throw new Error('Windows speech runtime archive checksum mismatch');
  const wanted = new Map(trusted.files.map((file) => [safeMember(file.member), file]));
  if (wanted.size !== trusted.files.length || wanted.size < 1 || wanted.size > 32)
    throw new Error('Invalid Windows speech runtime inventory');
  const names = new Set<string>();
  for (const file of wanted.values()) {
    if (
      !/^[a-z0-9_]+\.dll$/i.test(file.name) ||
      names.has(file.name.toLowerCase()) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > 2 * 1024 ** 2
    )
      throw new Error('Invalid Windows speech runtime member');
    names.add(file.name.toLowerCase());
  }
  const destinations = [await directory(stage, 'runtime/python')];
  if (includePocket) destinations.push(await directory(stage, 'engines/pocket'));
  const reader = new ZipReader(new Uint8ArrayReader(raw));
  const verified: { name: string; bytes: Uint8Array }[] = [];
  let count = 0;
  const seen = new Set<string>();
  try {
    for await (const item of reader.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (++count > 128) throw new Error('Too many Windows speech runtime archive entries');
      const path = safeMember(item.filename);
      if (seen.has(path)) throw new Error('Duplicate Windows speech runtime archive member');
      seen.add(path);
      const expected = wanted.get(path);
      if (!expected) continue; // Do not unpack debug_nonredist or unrelated package payloads.
      const mode = (item.externalFileAttributes >>> 16) & 0xffff;
      if (
        item.directory ||
        (mode & 0o170000) === 0o120000 ||
        item.uncompressedSize !== expected.size
      )
        throw new Error('Invalid Windows speech runtime archive member');
      const bytes = await item.getData!(new Uint8ArrayWriter(), { checkSignature: true, signal });
      if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256)
        throw new Error('Windows speech runtime DLL checksum mismatch');
      verified.push({ name: expected.name, bytes });
      wanted.delete(path);
    }
    if (wanted.size) throw new Error('Windows speech runtime archive is incomplete');
    // Nothing is published before every selected DLL has passed its individual pin.
    for (const { name, bytes } of verified) {
      for (const destination of destinations) {
        signal?.throwIfAborted();
        const target = join(destination, name);
        const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1))
          throw new Error('Unsafe existing Windows speech runtime DLL');
        // The fresh unpublished staging tree may contain an older Python-bundled copy.
        const handle = await open(target, existing ? 'w' : 'wx', 0o644);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
  } finally {
    await reader.close();
  }
};
export const installWindowsRuntime = async (
  archive: string,
  stage: string,
  includePocket: boolean,
  signal?: AbortSignal,
): Promise<void> => extractWindowsRuntime(archive, stage, await manifest(), includePocket, signal);
