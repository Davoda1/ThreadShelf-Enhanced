/** Adapted from ThreadShelf v1.4.1 (MIT); Enhanced adds a locked, multi-vault registry. */
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataPath } from '../paths.js';
import { withInterprocessLock } from '../interprocess-lock.js';

export interface VaultConfig {
  readonly vaultPath: string;
  readonly allowWrites: boolean;
}
export interface ConnectedVault extends VaultConfig {
  readonly id: string;
  readonly name: string;
}
export interface VaultRegistry {
  readonly version: 1;
  readonly activeId: string;
  readonly vaults: readonly ConnectedVault[];
}
export const DEFAULT_VAULT_CONFIG: VaultConfig = { vaultPath: '', allowWrites: false };
const EMPTY: VaultRegistry = { version: 1, activeId: '', vaults: [] };
const configPath = (): string => process.env.OBSIDIAN_CONFIG_PATH || dataPath('obsidianConfig');
let configQueue: Promise<unknown> = Promise.resolve();
/** Preserve same-process invocation order; SQLite remains authoritative across processes. */
const withConfigLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const operation = configQueue.then(() => withInterprocessLock(configPath(), fn));
  configQueue = operation.catch(() => undefined);
  return operation;
};

const vaultId = (path: string): string =>
  createHash('sha256').update(path).digest('hex').slice(0, 24);
const record = (vaultPath: string, allowWrites: boolean): ConnectedVault => ({
  id: vaultId(vaultPath),
  name: basename(vaultPath),
  vaultPath,
  allowWrites,
});

export const getVaultRegistry = async (): Promise<VaultRegistry> => {
  try {
    const text = await readFile(configPath(), 'utf8');
    if (text.length > 256 * 1024) throw new Error('Configuration too large');
    const raw = JSON.parse(text) as Record<string, unknown>;
    // Existing upstream configuration is read without mutation; the next explicit save upgrades it.
    if (typeof raw.vaultPath === 'string' && typeof raw.allowWrites === 'boolean') {
      const vault = raw.vaultPath ? record(raw.vaultPath, raw.allowWrites) : undefined;
      return vault ? { version: 1, activeId: vault.id, vaults: [vault] } : EMPTY;
    }
    if (
      raw.version !== 1 ||
      typeof raw.activeId !== 'string' ||
      !Array.isArray(raw.vaults) ||
      raw.vaults.length > 32
    )
      throw new Error('Invalid vault configuration');
    const ids = new Set<string>();
    const vaults = raw.vaults.map((entry: unknown) => {
      const value = entry as ConnectedVault | null;
      if (
        !value ||
        typeof value.vaultPath !== 'string' ||
        !isAbsolute(value.vaultPath) ||
        value.vaultPath.length > 4096 ||
        typeof value.allowWrites !== 'boolean' ||
        value.id !== vaultId(value.vaultPath) ||
        ids.has(value.id)
      )
        throw new Error('Invalid vault entry');
      ids.add(value.id);
      return record(value.vaultPath, value.allowWrites);
    });
    if (raw.activeId && !ids.has(raw.activeId)) throw new Error('Invalid active vault');
    return { version: 1, activeId: raw.activeId, vaults };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw new Error(
      'Cannot read Obsidian configuration; preserve the file and repair it before continuing',
      { cause: error },
    );
  }
};
export const getVaultConfig = async (id?: string): Promise<VaultConfig> => {
  const registry = await getVaultRegistry();
  const selected = id ?? registry.activeId;
  const vault = registry.vaults.find((entry) => entry.id === selected);
  if (id && !vault) throw new Error('The selected vault is no longer connected');
  return vault
    ? { vaultPath: vault.vaultPath, allowWrites: vault.allowWrites }
    : DEFAULT_VAULT_CONFIG;
};
export const getVaultConfigForRoot = async (root: string): Promise<VaultConfig> => {
  const registry = await getVaultRegistry();
  const vault = registry.vaults.find((entry) => entry.vaultPath === root);
  if (!vault) throw new Error('Vault changed or was disconnected; start a new request');
  return vault;
};
const writeConfig = async (next: VaultRegistry): Promise<void> => {
  const destination = configPath();
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};
export const setVaultWritePermission = async (
  allowWrites: unknown,
  id?: string,
): Promise<VaultConfig> => {
  if (typeof allowWrites !== 'boolean') throw new Error('allowWrites must be a boolean');
  return withConfigLock(async () => {
    const current = await getVaultRegistry();
    const selected = id ?? current.activeId;
    const target = current.vaults.find((vault) => vault.id === selected);
    if (!target) throw new Error('Connect an Obsidian vault in Settings first');
    await writeConfig({
      ...current,
      vaults: current.vaults.map((vault) =>
        vault.id === selected ? { ...vault, allowWrites } : vault,
      ),
    });
    return { vaultPath: target.vaultPath, allowWrites };
  });
};
const DEVICE_NAMESPACE = /^[\\/]{2}[?.][\\/]/;
export const canonicalVaultRoot = async (root: string): Promise<string> => {
  if (!root || !isAbsolute(root) || root.length > 4096 || root.includes('\0'))
    throw new Error('Choose an absolute vault directory');
  if (DEVICE_NAMESPACE.test(root)) throw new Error('Device paths cannot be used as a vault');
  const absolute = resolve(root);
  let current = parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    const stat = await lstat(current).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      throw new Error('Vault directories must exist and cannot be symbolic links or junctions');
  }
  return realpath(absolute);
};
export const saveVaultConfig = async (input: unknown): Promise<VaultConfig> => {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('vaultPath is required');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'vaultPath' && key !== 'allowWrites'))
    throw new Error('Only vaultPath and allowWrites can be saved');
  if (typeof raw.vaultPath !== 'string') throw new Error('vaultPath is required');
  if (raw.allowWrites !== undefined && typeof raw.allowWrites !== 'boolean')
    throw new Error('allowWrites must be a boolean');
  const requestedPath = raw.vaultPath.trim();
  return withConfigLock(async () => {
    const vaultPath = requestedPath ? await canonicalVaultRoot(requestedPath) : '';
    const current = await getVaultRegistry();
    if (!vaultPath) {
      // Disconnect the selected folder, not every connected folder.
      await writeConfig({
        ...current,
        activeId: '',
        vaults: current.vaults.filter((vault) => vault.id !== current.activeId),
      });
      return DEFAULT_VAULT_CONFIG;
    }
    const old = current.vaults.find((vault) => vault.vaultPath === vaultPath);
    if (!old && current.vaults.length >= 32)
      throw new Error('At most 32 note folders may be connected');
    const next = record(
      vaultPath,
      typeof raw.allowWrites === 'boolean' ? raw.allowWrites : (old?.allowWrites ?? false),
    );
    await writeConfig({
      version: 1,
      activeId: next.id,
      vaults: [...current.vaults.filter((vault) => vault.id !== next.id), next],
    });
    return { vaultPath, allowWrites: next.allowWrites };
  });
};
export const selectVault = async (id: unknown): Promise<VaultRegistry> => {
  if (typeof id !== 'string') throw new Error('A connected vault identifier is required');
  return withConfigLock(async () => {
    const current = await getVaultRegistry();
    if (!current.vaults.some((vault) => vault.id === id))
      throw new Error('The selected vault is no longer connected');
    const next = { ...current, activeId: id };
    await writeConfig(next);
    return next;
  });
};
