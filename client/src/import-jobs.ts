import { useQuery } from '@tanstack/react-query';
import type { IngestResultSummary, IngestStreamEvent } from './types';

export type ImportJobState =
  'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface ImportJob {
  id: string;
  collection: string;
  kind: 'folder' | 'upload' | 'watch';
  state: ImportJobState;
  clearFirst: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress?: IngestStreamEvent & { skippedFiles?: number; memory?: MemoryStatus };
  result?: IngestResultSummary & {
    warnings?: readonly (string | { sourceFile?: string; code?: string; message: string })[];
    skippedDetails?: readonly { sourceFile: string; reason: string }[];
  };
  error?: string;
  cancelRequested: boolean;
  attempts: number;
  safeToClose: boolean;
  collectionLocked: boolean;
}
export interface MemoryStatus {
  totalBytes: number;
  availableBytes: number;
  reserveBytes: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  externalBytes: number;
  processBudgetBytes: number;
  pressure: 'normal' | 'throttled' | 'paused' | 'critical';
  reason: 'available' | 'process' | 'heap' | null;
}

const jsonRequest = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data as T;
};
export const listJobs = (signal?: AbortSignal) =>
  jsonRequest<{ jobs: ImportJob[] }>('/api/import-jobs', { signal });
export const createFolderJob = (
  folderPath: string,
  collection: string,
  clearFirst: boolean,
  signal?: AbortSignal,
) =>
  jsonRequest<{ job: ImportJob }>('/api/import-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath, collection, clearFirst }),
    signal,
  });
export const createUploadJob = (
  files: readonly File[],
  collectionName: string,
  clearFirst: boolean,
  signal?: AbortSignal,
) => {
  const form = new FormData();
  form.append('collectionName', collectionName);
  form.append('clearFirst', String(clearFirst));
  for (const file of files) form.append(file.webkitRelativePath || file.name, file);
  return jsonRequest<{ job: ImportJob }>('/api/import-jobs/upload', {
    method: 'POST',
    body: form,
    signal,
  });
};
export const actOnJob = (id: string, action: 'cancel' | 'retry') =>
  jsonRequest<{ job: ImportJob }>(`/api/import-jobs/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
  });
export const removeJob = (id: string) =>
  jsonRequest<{ deleted: true; id: string }>(`/api/import-jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
export const clearFinishedJobs = () =>
  jsonRequest<{ deleted: number }>('/api/import-jobs', { method: 'DELETE' });
export const importJobProgress = (job: ImportJob): number => {
  // Older persisted jobs can still contain the last pre-publication percentage.
  if (job.state === 'completed') return 100;
  const percent = job.progress?.progressPercent ?? 0;
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
};
export const useImportJobs = () =>
  useQuery({
    queryKey: ['import-jobs'],
    queryFn: ({ signal }) => listJobs(signal),
    refetchInterval: 1500,
    staleTime: 1000,
    retry: 1,
  });
export const useMemoryStatus = () =>
  useQuery({
    queryKey: ['memory-status'],
    queryFn: ({ signal }) => jsonRequest<MemoryStatus>('/api/memory', { signal }),
    refetchInterval: 5000,
    staleTime: 2000,
    retry: 1,
  });
export const useCollectionLock = (collection: string) => {
  const jobs = useImportJobs();
  return jobs.data?.jobs.find((job) => job.collection === collection && job.collectionLocked);
};
