export interface UploadedFile {
  path: string;
  bytes: number;
  modifiedAt: number;
}
export interface UploadFilePage {
  files: UploadedFile[];
  nextCursor: string | null;
  locked: boolean;
}

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || response.statusText);
  return value as T;
};

export const listUploadCollections = (signal?: AbortSignal) =>
  request<{ collections: { collection: string }[] }>('/api/uploads', { signal });

export const listUploadedFiles = (
  collection: string,
  cursor: string | null,
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams({ limit: '100' });
  if (cursor) query.set('cursor', cursor);
  return request<UploadFilePage>(`/api/uploads/${encodeURIComponent(collection)}?${query}`, {
    signal,
  });
};

export const deleteUploadedFiles = (
  collection: string,
  selection: { paths: string[] } | { all: true },
) =>
  request<{ deleted: number; bytes: number }>(`/api/uploads/${encodeURIComponent(collection)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(selection),
  });
