import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdir,
  readFile,
  writeFile,
  stat,
  lstat,
  rm,
  rename,
  cp,
  copyFile,
  statfs,
} from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { dataPath, packagePath } from '../paths.js';
import { downloadToFile, sha256File } from '../generation/downloader.js';
import { withInterprocessLock } from '../interprocess-lock.js';
import { extractTarGz, extractZip, regularFiles, safeMember } from './archive.js';
import { windowsRuntimeAsset, installWindowsRuntime } from './windows-runtime.js';

export type Engine = 'pocket' | 'kokoro';
export type TtsEvent = Record<string, unknown>;
interface Asset {
  url: string;
  sha256: string;
  size: number;
  kind: 'file' | 'python-archive' | 'pocket-archive' | 'wheel' | 'windows-runtime';
  target: string;
  filename?: string;
  engine?: Engine;
}
interface Inventory {
  path: string;
  size: number;
  sha256: string;
}
interface Active {
  schema: 1;
  version: string;
  engines: Engine[];
  platform: string;
  inventory: Inventory[];
}
export interface AssetPlan {
  fingerprint: string;
  engines: Engine[];
  requestedEngines: Engine[];
  platform: string;
  downloadBytes: number;
  requiredFreeBytes: number;
  diskSpaceEstimate: true;
  files: { name: string; bytes: number; cached: boolean }[];
  licenses: string[];
}
const require = createRequire(import.meta.url);
const cpu = require(packagePath('tts', 'cpu.cjs')) as {
  ENGINE_REVISIONS: Record<Engine, string>;
  synthesizeCPU: (args: Record<string, unknown>) => Promise<Buffer>;
  workerEnvironment: (assets: string, work: string, threads: number) => NodeJS.ProcessEnv;
};
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const engineList = (value: unknown): Engine[] => {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 2 ||
    value.some((e) => !['pocket', 'kokoro'].includes(e))
  )
    throw new Error('Choose Pocket, Kokoro, or both local voice engines.');
  return [...new Set(value as Engine[])].sort();
};
const atomic = async (file: string, value: unknown): Promise<void> => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
};
export class TtsAssetManager {
  readonly root: string;
  readonly platform: string;
  private busy = false;
  private installAbort: AbortController | undefined;
  cancelInstallation(): void {
    this.installAbort?.abort(new DOMException('Speech installation cancelled.', 'AbortError'));
  }
  private verified = new Map<string, string>();
  private leases = new Map<string, number>();
  constructor(
    root = dataPath('tts'),
    platform = `${process.platform}-${process.arch}`,
    private readonly options: {
      manifest?: Asset[];
      smoke?: (root: string, engines: Engine[], signal?: AbortSignal) => Promise<void>;
      fetchImpl?: typeof fetch;
    } = {},
  ) {
    this.root = root;
    this.platform = platform;
  }
  private get activeFile(): string {
    return join(this.root, 'assets', 'active.json');
  }
  private get downloads(): string {
    return join(this.root, 'assets', 'downloads');
  }
  private get versions(): string {
    return join(this.root, 'assets', 'versions');
  }
  private async active(): Promise<Active | null> {
    try {
      const raw = await readFile(this.activeFile, 'utf8');
      if (raw.length > 32 * 1024 ** 2) throw new Error('Speech inventory is too large');
      const a = JSON.parse(raw) as Active;
      if (
        a.schema !== 1 ||
        !/^[a-f0-9]{64}$/.test(a.version) ||
        a.platform !== this.platform ||
        !Array.isArray(a.inventory) ||
        a.inventory.length > 100000
      )
        throw new Error('Invalid installed speech inventory');
      engineList(a.engines);
      for (const row of a.inventory) {
        safeMember(row.path);
        if (!/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 0)
          throw new Error('Invalid speech inventory entry');
      }
      return a;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  /** Both locks exclude workers and newly prepared, not-yet-published trees. */
  private async retireOldVersionsLocked(): Promise<void> {
    const active = await this.active();
    if (!active) return;
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(this.versions, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        /^[a-f0-9]{64}$/.test(entry.name) &&
        entry.name !== active.version &&
        !this.leases.has(entry.name)
      ) {
        await rm(join(this.versions, entry.name), { recursive: true, force: true });
        this.forgetVerifiedVersion(entry.name);
      }
    }
    // Another process may already have removed a version whose metadata this
    // manager cached. Keep only the active snapshot and locally leased trees.
    for (const key of this.verified.keys()) {
      const version = key.slice(0, key.indexOf('/'));
      if (version !== active.version && !this.leases.has(version)) this.verified.delete(key);
    }
  }
  private forgetVerifiedVersion(version: string): void {
    for (const key of this.verified.keys())
      if (key.startsWith(version + '/')) this.verified.delete(key);
  }
  private async retireOldVersions(): Promise<void> {
    try {
      await withInterprocessLock(
        join(this.root, 'assets', 'installation'),
        () =>
          withInterprocessLock(
            join(this.root, 'assets', 'usage'),
            () => this.retireOldVersionsLocked(),
            { timeoutMs: 0 },
          ),
        { timeoutMs: 0 },
      );
    } catch {
      // Installation has already committed. An active worker or transient file
      // lock must not turn working voices into an installation failure. Workers
      // retry retirement when releasing their usage lease; a later repair also retries.
    }
  }
  async status(): Promise<Record<string, unknown>> {
    let a: Active | null = null,
      warning: string | undefined,
      changing = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let candidate: Active | null;
      try {
        candidate = await this.active();
      } catch (error) {
        warning =
          error instanceof Error ? error.message : 'Local voice installation requires repair.';
        break;
      }
      let verificationError: unknown;
      try {
        if (candidate) {
          const folder = join(this.versions, candidate.version);
          for (const row of candidate.inventory) {
            const s = await lstat(join(folder, row.path));
            if (!s.isFile() || s.isSymbolicLink() || s.size !== row.size)
              throw new Error(
                'Local speech files are missing or changed. Download again to repair.',
              );
            const key = candidate.version + '/' + row.path;
            const identity = [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, row.sha256].join(':');
            if (this.verified.get(key) !== identity) {
              if ((await sha256File(join(folder, row.path))) !== row.sha256)
                throw new Error(
                  'Local speech files failed verification. Download again to repair.',
                );
              this.verified.set(key, identity);
            }
          }
        }
      } catch (error) {
        verificationError = error;
      }
      try {
        // Installation can publish and retire a snapshot during these awaits.
        // Recheck even after successful verification so an uninstall or engine
        // change cannot be reported as the previously installed selection.
        if ((await this.active())?.version !== candidate?.version) {
          if (candidate) this.forgetVerifiedVersion(candidate.version);
          if (attempt < 2) continue;
          changing = true;
          warning =
            'Local voices changed while checking. Wait for installation to finish, then retry.';
          break;
        }
      } catch (error) {
        verificationError = error;
      }
      if (verificationError) {
        warning =
          verificationError instanceof Error
            ? verificationError.message
            : 'Local voice installation requires repair.';
      } else {
        a = candidate;
      }
      break;
    }
    return {
      supported: ['linux-x64', 'win32-x64'].includes(this.platform),
      platform: this.platform,
      busy: this.busy || changing,
      engines: Object.fromEntries(
        (['pocket', 'kokoro'] as Engine[]).map((e) => [
          e,
          { installed: !!a?.engines.includes(e), revision: cpu.ENGINE_REVISIONS[e] },
        ]),
      ),
      ...(warning ? { warning } : {}),
    };
  }
  private async manifest(): Promise<Asset[]> {
    return (
      this.options.manifest ||
      (
        JSON.parse(await readFile(packagePath('tts', 'cpu', 'assets-manifest.json'), 'utf8')) as {
          assets: Asset[];
        }
      ).assets
    );
  }
  private async selection(engines: Engine[]): Promise<Asset[]> {
    const all = await this.manifest();
    if (!this.options.manifest && this.platform === 'win32-x64')
      all.push(await windowsRuntimeAsset());
    return all.filter((a) => {
      if (!a.target.startsWith('common/') && !a.target.startsWith(this.platform + '/'))
        return false;
      const engine =
        a.engine ||
        (a.target.includes('/pocket/') || a.kind === 'pocket-archive'
          ? 'pocket'
          : a.target.includes('/kokoro/') || a.kind === 'wheel'
            ? 'kokoro'
            : undefined);
      return !engine || engines.includes(engine);
    });
  }
  private async verifiedDownload(a: Asset): Promise<boolean> {
    const file = join(this.downloads, a.sha256);
    try {
      const s = await lstat(file);
      return (
        s.isFile() &&
        !s.isSymbolicLink() &&
        s.size === a.size &&
        (await sha256File(file)) === a.sha256
      );
    } catch {
      return false;
    }
  }
  async plan(request: unknown): Promise<AssetPlan> {
    const requestedEngines = engineList(request);
    if (!['linux-x64', 'win32-x64'].includes(this.platform))
      throw new Error(
        'Local voices currently support Linux x64 and Windows x64; API speech remains available.',
      );
    let old: Active | null = null;
    try {
      old = await this.active();
    } catch {
      /* Repair preserves valid requested engines only. */
    }
    const engines = engineList([...new Set([...requestedEngines, ...(old?.engines || [])])]);
    const selected = await this.selection(engines);
    const unique = [...new Map(selected.map((a) => [a.sha256, a])).values()];
    const files = [];
    let downloadBytes = 0;
    for (const a of unique) {
      if (
        !Number.isSafeInteger(a.size) ||
        a.size < 1 ||
        !a.url.startsWith('https://') ||
        !/^[a-f0-9]{64}$/.test(a.sha256)
      )
        throw new Error('Invalid pinned speech download manifest');
      const cached = await this.verifiedDownload(a);
      files.push({ name: a.filename || basename(a.target), bytes: a.size, cached });
      if (!cached) downloadBytes += a.size;
    }
    // Conservative bound, not a falsely precise extracted-size claim. Includes
    // retained previous working files, unpacking scratch and the download cache.
    const requiredFreeBytes =
      downloadBytes +
      selected.reduce((n, a) => n + a.size * (a.kind === 'file' ? 1 : 8), 0) +
      256 * 1024 ** 2;
    const fingerprint = digest({
      schema: 1,
      platform: this.platform,
      engines,
      selected,
      revision: cpu.ENGINE_REVISIONS,
    });
    return {
      fingerprint,
      engines,
      requestedEngines,
      platform: this.platform,
      downloadBytes,
      requiredFreeBytes,
      diskSpaceEstimate: true,
      files,
      licenses: [
        'Pocket code: MIT; model: CC-BY-4.0; voice-specific attribution',
        'Kokoro model and voices: Apache-2.0',
        'eSpeak NG and Phonemizer: GPL-3.0; matching source included',
        ...(this.platform === 'win32-x64'
          ? ['Microsoft Visual Studio 2022 C++ runtime redistribution terms']
          : []),
      ],
    };
  }
  async install(
    request: unknown,
    fingerprint: unknown,
    onEvent: (event: TtsEvent) => void,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (this.busy) throw new Error('A local voice installation is already running.');
    this.busy = true;
    const installAbort = new AbortController();
    this.installAbort = installAbort;
    signal = signal ? AbortSignal.any([signal, installAbort.signal]) : installAbort.signal;
    try {
      return await withInterprocessLock(
        join(this.root, 'assets', 'installation'),
        async () => {
          const plan = await this.plan(request);
          if (plan.fingerprint !== fingerprint)
            throw new Error('The local voice plan changed. Review the download again.');
          await mkdir(this.downloads, { recursive: true, mode: 0o700 });
          await mkdir(this.versions, { recursive: true, mode: 0o700 });
          const { readdir } = await import('node:fs/promises');
          for (const entry of await readdir(this.versions))
            if (/^\.stage-[a-f0-9]{24}$/.test(entry))
              await rm(join(this.versions, entry), { recursive: true, force: true });
          const space = await statfs(this.root);
          if (Number(space.bavail) * Number(space.bsize) < plan.requiredFreeBytes)
            throw new Error(
              'Not enough free disk space for local voices, staging and retained working files.',
            );
          const selected = await this.selection(plan.engines),
            unique = [...new Map(selected.map((a) => [a.sha256, a])).values()];
          let completed = 0;
          for (const a of unique) {
            signal?.throwIfAborted();
            if (await this.verifiedDownload(a)) continue;
            const boundedFetch: typeof fetch = async (input, init) => {
              const response = await (this.options.fetchImpl || fetch)(input, init);
              if (response.url && !response.url.startsWith('https://'))
                throw new Error('Speech downloads cannot redirect to insecure HTTP.');
              if (!response.body) return response;
              let bytes = 0;
              const body = response.body.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                    bytes += chunk.length;
                    if (bytes > a.size)
                      throw new Error('Speech download exceeds its declared size');
                    controller.enqueue(chunk);
                  },
                }),
              );
              return new Response(body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            };
            await downloadToFile(a.url, join(this.downloads, a.sha256), {
              sha256: a.sha256,
              expectedBytes: a.size,
              signal,
              fetchImpl: boundedFetch,
              onProgress: (p) =>
                onEvent({
                  state: 'downloading',
                  file: a.filename || basename(a.target),
                  downloadedBytes: completed + p.downloadedBytes,
                  totalBytes: plan.downloadBytes,
                }),
            });
            completed += a.size;
          }
          signal?.throwIfAborted();
          onEvent({
            state: 'verifying',
            downloadedBytes: plan.downloadBytes,
            totalBytes: plan.downloadBytes,
          });
          const stage = join(this.versions, `.stage-${randomBytes(12).toString('hex')}`);
          await mkdir(stage, { mode: 0o700 });
          try {
            for (const a of selected) {
              signal?.throwIfAborted();
              const local = a.target.split('/').slice(1).join('/');
              safeMember(local);
              const target = join(stage, local),
                file = join(this.downloads, a.sha256);
              if (a.kind === 'file') {
                await mkdir(dirname(target), { recursive: true });
                await copyFile(file, target);
              } else if (a.kind === 'windows-runtime') {
                await installWindowsRuntime(file, stage, plan.engines.includes('pocket'), signal);
              } else if (a.kind === 'wheel') {
                await mkdir(target, { recursive: true });
                await extractZip(file, target, true, signal);
              } else {
                const unpack = join(stage, `.unpack-${randomBytes(6).toString('hex')}`);
                await mkdir(unpack);
                if (a.url.endsWith('.zip')) await extractZip(file, unpack, false, signal);
                else await extractTarGz(file, unpack, signal);
                let source = join(unpack, 'python');
                if (a.kind === 'pocket-archive') {
                  const matches = (await regularFiles(unpack)).filter((p) =>
                    ['pocket-tts', 'pocket-tts.exe'].includes(basename(p)),
                  );
                  if (matches.length !== 1)
                    throw new Error('Speech engine archive has no unique executable');
                  source = dirname(join(unpack, matches[0]!));
                }
                await mkdir(dirname(target), { recursive: true });
                await cp(source, target, {
                  recursive: true,
                  errorOnExist: true,
                  force: false,
                  dereference: false,
                });
                await rm(unpack, { recursive: true, force: true });
              }
            }
            await cp(
              packagePath('tts', 'cpu', 'support', 'common', 'licenses'),
              join(stage, 'licenses'),
              { recursive: true },
            );
            signal?.throwIfAborted();
            onEvent({
              state: 'installing',
              downloadedBytes: plan.downloadBytes,
              totalBytes: plan.downloadBytes,
            });
            if (this.options.smoke) await this.options.smoke(stage, plan.engines, signal);
            else await this.smoke(stage, plan.engines, signal);
            const inventory: Inventory[] = [];
            for (const file of await regularFiles(stage)) {
              signal?.throwIfAborted();
              const path = join(stage, file);
              inventory.push({
                path: file,
                size: (await stat(path)).size,
                sha256: await sha256File(path),
              });
            }
            const version = digest({
              fingerprint: plan.fingerprint,
              inventory,
              installation: randomBytes(16).toString('hex'),
            });
            const destination = join(this.versions, version);
            try {
              await rename(stage, destination);
            } catch (e) {
              if (!['EEXIST', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code || ''))
                throw e;
              await rm(stage, { recursive: true, force: true });
            }
            signal?.throwIfAborted();
            await atomic(this.activeFile, {
              schema: 1,
              version,
              engines: plan.engines,
              platform: this.platform,
              inventory,
            } satisfies Active);
            await this.retireOldVersions();
            onEvent({
              state: 'ready',
              downloadedBytes: plan.downloadBytes,
              totalBytes: plan.downloadBytes,
            });
            return { ...(await this.status()), busy: false };
          } finally {
            await rm(stage, { recursive: true, force: true });
          }
        },
        { timeoutMs: 1000, signal },
      );
    } finally {
      this.busy = false;
      if (this.installAbort === installAbort) this.installAbort = undefined;
    }
  }
  private async smoke(stage: string, engines: Engine[], signal?: AbortSignal): Promise<void> {
    const work = join(stage, '.readiness');
    await mkdir(work);
    try {
      for (const engine of engines) {
        signal?.throwIfAborted();
        await cpu.synthesizeCPU({
          provider: engine,
          voice: engine === 'pocket' ? 'alba' : 'am_michael',
          text: 'Ready.',
          assetsDir: stage,
          workDir: work,
          signal,
          streamingEnabled: false,
        });
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  async withAssets<T>(
    engine: Engine,
    fn: (path: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await withInterprocessLock(
        join(this.root, 'assets', 'usage'),
        async () => {
          const state = await this.status();
          const usable = state.engines as Record<Engine, { installed: boolean }>;
          const a = await this.active();
          if (!a?.engines.includes(engine) || !usable[engine].installed)
            throw new Error(
              'Download local voices in Text-to-Speech settings before using this engine.',
            );
          this.leases.set(a.version, (this.leases.get(a.version) || 0) + 1);
          try {
            return await fn(join(this.versions, a.version));
          } finally {
            const count = (this.leases.get(a.version) || 1) - 1;
            if (count) this.leases.set(a.version, count);
            else this.leases.delete(a.version);
          }
        },
        { timeoutMs: 30000, signal },
      );
    } finally {
      // Release usage before acquiring installation: keep one lock order even
      // when installation publishes a new version while this worker is reading.
      await this.retireOldVersions();
    }
  }
  async uninstall(request: unknown): Promise<Record<string, unknown>> {
    const engines = engineList(request);
    if (this.busy || this.leases.size)
      throw new Error(
        'Stop local speech and wait for installation to finish before removing local voices.',
      );
    return withInterprocessLock(
      join(this.root, 'assets', 'installation'),
      async () =>
        withInterprocessLock(
          join(this.root, 'assets', 'usage'),
          async () => {
            const active = await this.active();
            if (!active) return this.status();
            const remaining = active.engines.filter((e) => !engines.includes(e));
            if (!remaining.length) {
              await rm(this.activeFile, { force: true });
              await rm(this.versions, { recursive: true, force: true });
            } else {
              const keep = await this.selection(remaining);
              const stage = join(this.versions, `.stage-${randomBytes(12).toString('hex')}`);
              const source = join(this.versions, active.version);
              await mkdir(stage, { recursive: true });
              try {
                const roots = new Set(keep.map((a) => a.target.split('/').slice(1).join('/')));
                roots.add('licenses');
                for (const root of roots)
                  await cp(join(source, root), join(stage, root), { recursive: true });
                const inventory: Inventory[] = [];
                for (const path of await regularFiles(stage))
                  inventory.push({
                    path,
                    size: (await stat(join(stage, path))).size,
                    sha256: await sha256File(join(stage, path)),
                  });
                const version = digest({
                  remaining,
                  inventory,
                  installation: randomBytes(16).toString('hex'),
                });
                await rename(stage, join(this.versions, version));
                await atomic(this.activeFile, {
                  ...active,
                  version,
                  engines: remaining,
                  inventory,
                });
                const { readdir } = await import('node:fs/promises');
                for (const old of await readdir(this.versions))
                  if (old !== version)
                    await rm(join(this.versions, old), { recursive: true, force: true });
              } finally {
                await rm(stage, { recursive: true, force: true });
              }
            }
            const keepHashes = new Set(
              (await this.selection(remaining.length ? remaining : [])).map((a) => a.sha256),
            );
            const { readdir } = await import('node:fs/promises');
            for (const name of await readdir(this.downloads).catch(() => []))
              if (
                /^[a-f0-9]{64}(\.part)?$/.test(name) &&
                (!remaining.length || !keepHashes.has(name.replace(/\.part$/, '')))
              )
                await rm(join(this.downloads, name), { force: true });
            return this.status();
          },
          { timeoutMs: 1000 },
        ),
      { timeoutMs: 1000 },
    );
  }
}
export const ttsAssets = new TtsAssetManager();
