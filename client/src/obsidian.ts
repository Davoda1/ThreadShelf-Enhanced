export interface VaultConfig {
  vaultPath: string;
  allowWrites: boolean;
}
export interface ConnectedVault extends VaultConfig {
  id: string;
  name: string;
}
export interface VaultRegistry {
  version: 1;
  activeId: string;
  vaults: ConnectedVault[];
}
export interface VaultNote {
  path: string;
  content: string;
  revision: string;
}
export interface VaultSearch {
  hits: { path: string; title: string; snippet: string; line: number; heading?: string }[];
  scanned: number;
  skipped: number;
  truncated: boolean;
}
export interface VaultApproval {
  id: string;
  token: string;
  model: string;
  operation?: 'create' | 'edit' | 'delete';
  files: readonly string[];
  expiresAt: string;
  before?: string;
  after?: string;
}
export interface DetectedNoteFolder {
  source: string;
  name: string;
  path: string;
}
const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api/obsidian/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(typeof result.error === 'string' ? result.error : 'Vault operation failed');
  return result as T;
};
const scoped = (path: string, id?: string) =>
  `${path}${path.includes('?') ? '&' : '?'}${id ? `vaultId=${encodeURIComponent(id)}` : ''}`;
export const vaultApi = {
  registry: (signal?: AbortSignal) => request<VaultRegistry>('vaults', { signal }),
  config: (signal?: AbortSignal, id?: string) =>
    request<VaultConfig>(scoped('config', id), { signal }),
  detected: (signal?: AbortSignal) =>
    request<{ folders: DetectedNoteFolder[] }>('detected', { signal }),
  save: (vaultPath: string) =>
    request<VaultConfig>('config', { method: 'PUT', body: JSON.stringify({ vaultPath }) }),
  select: (vaultId: string) =>
    request<VaultRegistry>('active', { method: 'POST', body: JSON.stringify({ vaultId }) }),
  writes: (allowWrites: boolean, id?: string) =>
    request<VaultConfig>(scoped('config', id), {
      method: 'PATCH',
      body: JSON.stringify({ allowWrites }),
    }),
  search: (query: string, id?: string, signal?: AbortSignal) =>
    request<VaultSearch>(scoped(`search?q=${encodeURIComponent(query)}&limit=30`, id), { signal }),
  read: (path: string, id?: string, signal?: AbortSignal) =>
    request<VaultNote>(scoped(`note?path=${encodeURIComponent(path)}`, id), { signal }),
  create: (path: string, content: string, id?: string) =>
    request<VaultNote>(scoped('note', id), {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),
  edit: (note: VaultNote, content: string, id?: string) =>
    request<VaultNote>(scoped('note', id), {
      method: 'PUT',
      body: JSON.stringify({ path: note.path, content, revision: note.revision }),
    }),
  decide: (approval: VaultApproval, approve: boolean, acknowledged: boolean) =>
    request<{ ok: true }>(`approvals/${encodeURIComponent(approval.id)}`, {
      method: 'POST',
      body: JSON.stringify({ token: approval.token, approve, acknowledged }),
    }),
};
