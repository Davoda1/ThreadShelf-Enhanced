import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { extractWindowsRuntime, windowsRuntimeAsset } from '../src/tts/windows-runtime.js';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixture = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-msvc-'));
  try {
    const bytes = Buffer.from('synthetic-runtime-payload');
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add('Contents/VC/x64/CRT/example.dll', new Uint8ArrayReader(bytes));
    await writer.add(
      'Contents/debug_nonredist/debug.dll',
      new Uint8ArrayReader(Buffer.from('not redistributable')),
    );
    const zip = await writer.close();
    const file = join(dir, 'runtime.vsix');
    await writeFile(file, zip);
    const stage = join(dir, 'stage');
    await mkdir(stage);
    const manifest = {
      schema: 1,
      version: 'synthetic',
      asset: {
        url: 'https://example.invalid/synthetic.vsix',
        sha256: sha(zip),
        size: zip.length,
        kind: 'windows-runtime',
        target: 'win32-x64/runtime/python',
        filename: 'synthetic.vsix',
      },
      files: [
        {
          member: 'Contents/VC/x64/CRT/example.dll',
          name: 'example.dll',
          size: bytes.length,
          sha256: sha(bytes),
        },
      ],
    };
    await fn({ dir, file, stage, manifest, bytes });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
it('pins the official Microsoft shared runtime download without bundled binaries', async () => {
  const asset = await windowsRuntimeAsset();
  assert.equal(new URL(asset.url).hostname, 'download.visualstudio.microsoft.com');
  assert.equal(asset.sha256, '4aaf54db0bfc9435f7c3660e1a00237a4b556042bfeea64bde44c2e0194e6ee5');
  assert.equal(asset.size, 3224191);
  assert.equal(asset.kind, 'windows-runtime');
});
it('extracts only individually verified release DLLs to requested application locations', () =>
  fixture(async ({ file, stage, manifest, bytes }) => {
    await extractWindowsRuntime(file, stage, manifest, true);
    assert.deepEqual(await readFile(join(stage, 'runtime/python/example.dll')), bytes);
    assert.deepEqual(await readFile(join(stage, 'engines/pocket/example.dll')), bytes);
    assert.deepEqual(await readdir(join(stage, 'runtime/python')), ['example.dll']);
    assert.deepEqual(await readdir(stage), ['engines', 'runtime']);
  }));
it('does not create a Pocket directory for Kokoro-only installations', () =>
  fixture(async ({ file, stage, manifest }) => {
    await extractWindowsRuntime(file, stage, manifest, false);
    assert.deepEqual(await readdir(stage), ['runtime']);
  }));
it('refuses changed compressed bytes or member checksum mismatches', () =>
  fixture(async ({ file, stage, manifest }) => {
    await assert.rejects(
      extractWindowsRuntime(
        file,
        stage,
        { ...manifest, asset: { ...manifest.asset, sha256: 'f'.repeat(64) } },
        true,
      ),
      /checksum/,
    );
    await assert.rejects(
      extractWindowsRuntime(
        file,
        stage,
        { ...manifest, files: [{ ...manifest.files[0], sha256: 'f'.repeat(64) }] },
        true,
      ),
      /checksum/,
    );
    assert.deepEqual(await readdir(join(stage, 'runtime/python')), []);
  }));
it('rejects absent expected members instead of declaring a partial runtime ready', () =>
  fixture(async ({ file, stage, manifest }) => {
    await assert.rejects(
      extractWindowsRuntime(
        file,
        stage,
        { ...manifest, files: [{ ...manifest.files[0], member: 'Contents/missing.dll' }] },
        true,
      ),
      /incomplete/,
    );
  }));
it('rejects unsafe destinations and cancellation', () =>
  fixture(async ({ dir, file, stage, manifest }) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(extractWindowsRuntime(file, stage, manifest, true, controller.signal), {
      name: 'AbortError',
    });
    const outside = join(dir, 'outside');
    await mkdir(outside);
    try {
      await symlink(outside, join(stage, 'runtime'), 'dir');
    } catch {
      return;
    }
    await assert.rejects(extractWindowsRuntime(file, stage, manifest, true), /Unsafe/);
    assert.deepEqual(await readdir(outside), []);
  }));
