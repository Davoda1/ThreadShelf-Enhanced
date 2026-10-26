import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  actOnJob,
  clearFinishedJobs,
  importJobProgress,
  removeJob,
  useImportJobs,
  useMemoryStatus,
  type ImportJob,
  type ImportJobState,
} from '../import-jobs';
import { formatNumber, t, useI18n } from '../i18n';
import { fmtTime } from '../utils';
import { confirmDialog } from '../toast';

const stateLabel: Record<ImportJobState, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};
const phaseLabel: Record<string, string> = {
  uploading: 'Receiving files',
  reading: 'Reading exports',
  parsing: 'Reading exports',
  normalizing: 'Preparing conversations',
  embedding: 'Embedding',
  publishing: 'Publishing collection',
  writing: 'Writing index',
  memory: 'Waiting for memory',
  staging: 'Preparing files',
};
const active = (job: ImportJob) =>
  ['queued', 'running', 'paused', 'interrupted'].includes(job.state);

export function ImportJobsPanel({ onRefresh }: { onRefresh: () => Promise<void> }) {
  useI18n();
  const jobs = useImportJobs();
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const known = useRef(new Map<string, ImportJobState>());
  useEffect(() => {
    let changed = false;
    const next = new Map<string, ImportJobState>();
    for (const job of jobs.data?.jobs ?? []) {
      const previous = known.current.get(job.id);
      if (
        previous &&
        previous !== job.state &&
        ['completed', 'failed', 'cancelled'].includes(job.state)
      )
        changed = true;
      next.set(job.id, job.state);
    }
    known.current = next;
    if (changed) void onRefresh();
  }, [jobs.data, onRefresh]);
  const runAction = async (perform: () => Promise<void>) => {
    // Acquire before opening a confirmation: the dialog and error state are shared.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await perform();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Unknown error'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const refreshJobs = () => queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
  const action = (job: ImportJob, kind: 'cancel' | 'retry' | 'remove') =>
    runAction(async () => {
      if (
        kind === 'cancel' &&
        !(await confirmDialog({
          title: t('Cancel this import?'),
          message: t('Processing will stop at a safe boundary. The job history remains available.'),
          confirmLabel: t('Cancel import'),
          danger: true,
        }))
      )
        return;
      if (kind === 'remove') {
        if (
          !(await confirmDialog({
            title: t('Remove this import from history?'),
            message: t(
              "Imported conversations stay unchanged. This job's progress, diagnostics and retry option will be removed.",
            ),
            confirmLabel: t('Remove from history'),
            danger: true,
          }))
        )
          return;
        await removeJob(job.id);
        setNotice(t('Import removed from history.'));
      } else {
        await actOnJob(job.id, kind);
      }
      await refreshJobs();
    });
  const clearHistory = () =>
    runAction(async () => {
      if (
        !(await confirmDialog({
          title: t('Clear finished import jobs?'),
          message: t(
            'Remove completed, failed and cancelled jobs from every collection, including older jobs not shown here. Their progress, diagnostics and retry options will be removed. Imported conversations stay unchanged. Active and interrupted jobs are kept.',
          ),
          confirmLabel: t('Clear finished jobs'),
          danger: true,
        }))
      )
        return;
      const result = await clearFinishedJobs();
      setNotice(
        t('Finished import jobs removed: {count}.', { count: formatNumber(result.deleted) }),
      );
      await refreshJobs();
    });
  return (
    <section className="panel import-jobs" aria-label={t('Import jobs')}>
      <div className="panel-head">
        <div className="import-jobs-title">
          <h3>{t('Import jobs')}</h3>
          <span className="sub">{t('Progress is saved on the server.')}</span>
        </div>
        <button
          id="clearFinishedImportJobs"
          className="btn sm import-jobs-clear"
          aria-label={t('Clear all finished jobs')}
          title={t('Clear finished jobs')}
          disabled={busy || !jobs.data?.jobs.length}
          onClick={() => void clearHistory()}
        >
          {t('Clear all')}
        </button>
      </div>
      {jobs.error && <p className="banner err">{t('Could not refresh import progress.')}</p>}
      {error && (
        <p className="banner err" role="alert">
          {t(error)}
        </p>
      )}
      {notice && (
        <p className="import-jobs-notice" role="status">
          {notice}
        </p>
      )}
      {!jobs.data?.jobs.length && <p className="import-jobs-empty">{t('No import jobs yet.')}</p>}
      {(jobs.data?.jobs ?? []).slice(0, 20).map((job) => {
        const progress = job.progress;
        const percent = importJobProgress(job);
        const warnings = job.result?.warnings ?? [];
        const errors = job.result?.errors ?? [];
        return (
          <article className="import-job" key={job.id} data-state={job.state} data-job-id={job.id}>
            <div className="import-job-heading">
              <strong>{job.collection}</strong>
              <span className="import-job-state">{t(stateLabel[job.state])}</span>
            </div>
            {job.collectionLocked && (
              <p className="import-lock-label">
                {t('Collection replacement in progress. Changes are temporarily blocked.')}
              </p>
            )}
            {active(job) && (
              <p>
                {t('Files received. You can close this tab; processing continues on the server.')}
              </p>
            )}
            <div className="import-job-metrics">
              <span>
                {t(
                  active(job)
                    ? (phaseLabel[progress?.phase ?? ''] ?? 'Waiting to start')
                    : stateLabel[job.state],
                )}
              </span>
              <span>
                {t('{done} / {total} files', {
                  done: formatNumber(progress?.processedFiles ?? 0),
                  total: formatNumber(progress?.totalFiles ?? 0),
                })}
              </span>
              {progress?.embeddingTotal !== undefined && (
                <span>
                  {t('{done} / {total} chunks', {
                    done: formatNumber(progress.embeddingDone ?? 0),
                    total: formatNumber(progress.embeddingTotal),
                  })}
                </span>
              )}
              <span>{fmtTime(progress?.elapsedMs ?? job.result?.elapsedMs ?? 0)}</span>
            </div>
            <progress max={100} value={percent} aria-label={t('Import progress')} />
            {progress?.currentFile && (
              <p className="import-job-file" title={progress.currentFile}>
                {progress.currentFile.replace(/^.*[\\/]/, '')}
              </p>
            )}
            {job.result && (
              <p>
                {t('{conversations} conversations; {chunks} indexed chunks.', {
                  conversations: formatNumber(job.result.conversations ?? 0),
                  chunks: formatNumber(job.result.ingested ?? 0),
                })}
              </p>
            )}
            {job.result?.replacementSkipped && (
              <p className="banner err">
                {t('The existing collection was kept. No replacement was published.')}
              </p>
            )}
            {job.error && <p className="banner err">{job.error}</p>}
            {!!(warnings.length || errors.length || job.result?.skippedFiles?.length) && (
              <details>
                <summary>{t('Skipped files and diagnostics')}</summary>
                <ul>
                  {job.result?.skippedFiles?.map((file) => (
                    <li key={`skip-${file}`}>
                      {t('Skipped')}: {file}
                    </li>
                  ))}
                  {warnings.map((warning, i) => (
                    <li key={`warning-${i}`}>
                      {typeof warning === 'string'
                        ? warning
                        : `${warning.sourceFile ? `${warning.sourceFile}: ` : ''}${warning.message}`}
                    </li>
                  ))}
                  {errors.map((message, i) => (
                    <li key={`error-${i}`}>{message}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="import-job-actions">
              {active(job) && (
                <button
                  className="btn sm danger"
                  disabled={busy || job.cancelRequested}
                  onClick={() => void action(job, 'cancel')}
                >
                  {t(job.cancelRequested ? 'Stopping safely…' : 'Cancel import')}
                </button>
              )}
              {['failed', 'cancelled', 'interrupted'].includes(job.state) && (
                <button
                  className="btn sm"
                  disabled={busy}
                  onClick={() => void action(job, 'retry')}
                >
                  {t('Retry import')}
                </button>
              )}
              {!active(job) && (
                <button
                  className="btn sm"
                  aria-label={t('Clear this import from history')}
                  title={t('Remove from history')}
                  disabled={busy}
                  onClick={() => void action(job, 'remove')}
                >
                  {t('Clear')}
                </button>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}

export function ImportStatusIndicator() {
  useI18n();
  const jobs = useImportJobs();
  const memory = useMemoryStatus();
  const current = jobs.data?.jobs.find((job) => job.state === 'running' || job.state === 'paused');
  const pressure = memory.data && memory.data.pressure !== 'normal';
  if (!current && !pressure) return null;
  return (
    <div className="import-status-indicator" role="status">
      <Link to="/indexing">
        {current ? `${current.collection}: ${t(stateLabel[current.state])}` : t('Import status')}
      </Link>
      {current?.collectionLocked && <span>{t('Collection temporarily read-only')}</span>}
      {memory.data && (
        <span>
          {t('Server memory: {used} GiB', {
            used: formatNumber(memory.data.rssBytes / 1024 ** 3, { maximumFractionDigits: 1 }),
          })}
        </span>
      )}
      {pressure && (
        <span>
          {t(
            memory.data!.pressure === 'throttled'
              ? 'Processing reduced to save memory'
              : 'Waiting for available memory',
          )}
        </span>
      )}
    </div>
  );
}
