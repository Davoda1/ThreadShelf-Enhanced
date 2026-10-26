import { useState, useRef, useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createFolderJob, createUploadJob, useImportJobs } from '../import-jobs';
import { ImportJobsPanel } from './ImportJobsPanel';
import { UploadStorageModal } from './UploadStorageModal';
import { t, useI18n, formatNumber } from '../i18n';
import type { FilePreview, IngestProgress, IngestStreamEvent, StatusMessage } from '../types';
import { Icons } from '../icons';
import { api } from '../api';
import { collLabel, fmtTime, isPotentialExport } from '../utils';
import { NewCollectionModal } from './NewCollectionModal';

function formatProgressStep(event: IngestStreamEvent): string {
  const total = event.totalFiles || 1;
  const done = event.processedFiles || 0;
  const phase = (event.phase || '').toLowerCase();

  if (phase === 'uploading')
    return t('Uploading {done} / {total} files', {
      done: formatNumber(done),
      total: formatNumber(total),
    });
  if (phase === 'reading')
    return t('Reading {done} / {total} files', {
      done: formatNumber(done),
      total: formatNumber(total),
    });
  if (phase === 'embedding')
    return event.embeddingTotal !== undefined
      ? t('Embedding {done} / {total} chunks', {
          done: formatNumber(event.embeddingDone ?? 0),
          total: formatNumber(event.embeddingTotal),
        })
      : t('Embedding {done} / {total} files', {
          done: formatNumber(done),
          total: formatNumber(total),
        });
  if (event.status === 'starting')
    return t('Starting 0 / {total} files', { total: formatNumber(total) });
  return t('{done} / {total} files', { done: formatNumber(done), total: formatNumber(total) });
}

function progressFromEvent(event: IngestStreamEvent): IngestProgress {
  const total = event.totalFiles || 1;
  const done = event.processedFiles || 0;

  return {
    pct:
      event.status === 'completed'
        ? 100
        : Math.max(0, Math.min(100, Math.round(event.progressPercent ?? (done / total) * 100))),
    step: formatProgressStep(event),
    chunks: event.totalChunks,
    time: event.elapsedMs,
    file: event.currentFile,
  };
}

function formatCompletedMessage(event: IngestStreamEvent): string {
  const result = event.result;
  if (result?.replacementSkipped)
    return t(
      'The existing collection was kept because a recognized export failed or no valid conversations were found. Review the diagnostics and retry.',
    );
  const fileCount = result?.files?.length ?? 0;
  const conversations = result?.conversations ?? fileCount;
  const errorCount = result?.errors?.length ?? 0;

  const summary = t(
    'Indexed {conversations} conversations as {chunks} chunks from {files} files in {time}.',
    {
      conversations: formatNumber(conversations),
      chunks: formatNumber(result?.ingested ?? 0),
      files: formatNumber(fileCount),
      time: fmtTime(result?.elapsedMs ?? 0),
    },
  );
  return errorCount
    ? `${summary} ${t('Failed files: {count}.', { count: formatNumber(errorCount) })}`
    : summary;
}

interface IndexingViewProps {
  readonly collections: readonly string[];
  readonly onRefresh: () => Promise<void>;
}

type RelativeFile = File & { readonly webkitRelativePath?: string };
type DragFileSystemEntry =
  | {
      readonly isFile: true;
      readonly isDirectory: false;
      readonly name: string;
      file: (success: (file: File) => void, failure: (error: DOMException) => void) => void;
    }
  | {
      readonly isFile: false;
      readonly isDirectory: true;
      readonly name: string;
      createReader: () => {
        readEntries: (
          success: (entries: DragFileSystemEntry[]) => void,
          failure: (error: DOMException) => void,
        ) => void;
      };
    };
type DataTransferItemWithEntry = DataTransferItem & {
  readonly webkitGetAsEntry?: () => unknown;
};

const relativePathOf = (file: RelativeFile): string => file.webkitRelativePath || file.name;

const withRelativePath = (file: File, relativePath: string): RelativeFile => {
  if ((file as RelativeFile).webkitRelativePath) return file as RelativeFile;
  try {
    Object.defineProperty(file, 'webkitRelativePath', {
      configurable: true,
      value: relativePath,
    });
  } catch {
    // Some browsers expose immutable File objects; the filename fallback still works.
  }
  return file as RelativeFile;
};

const readAllEntries = async (entry: Extract<DragFileSystemEntry, { isDirectory: true }>) => {
  const reader = entry.createReader();
  const all: DragFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<DragFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) break;
    all.push(...batch);
  }
  return all;
};

const filesFromEntry = async (entry: DragFileSystemEntry, prefix = ''): Promise<RelativeFile[]> => {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    return [withRelativePath(file, `${prefix}${file.name}`)];
  }
  const children = await readAllEntries(entry);
  const nested = await Promise.all(
    children.map((child) => filesFromEntry(child, `${prefix}${entry.name}/`)),
  );
  return nested.flat();
};

export function IndexingView({ collections, onRefresh }: IndexingViewProps) {
  useI18n();
  const queryClient = useQueryClient();
  const jobs = useImportJobs();
  const [submittedId, setSubmittedId] = useState('');
  const [dragging, setDragging] = useState(false);
  const [path, setPath] = useState('');
  const [uploadFiles, setUploadFiles] = useState<RelativeFile[] | null>(null);
  const [pickedLabel, setPickedLabel] = useState('');
  const [clearFirst, setClearFirst] = useState(false);
  const [targetColl, setTargetColl] = useState(collections.find((c) => c !== 'all') ?? 'chunks');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [statusMsg, setStatusMsg] = useState<StatusMessage | null>(null);
  const [preview, setPreview] = useState<FilePreview[] | null>(null);
  const [newCollOpen, setNewCollOpen] = useState(false);
  const [uploadsOpen, setUploadsOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const pickerRef = useRef<HTMLInputElement>(null);
  const filesPickerRef = useRef<HTMLInputElement>(null);
  const indexingController = useRef<AbortController | null>(null);

  const copyScript = useCallback(async (file: string) => {
    try {
      const res = await fetch(`/scripts/${file}`);
      if (!res.ok) throw new Error('not found');
      await navigator.clipboard.writeText(await res.text());
      setCopied(file);
      setTimeout(() => setCopied(''), 2500);
    } catch {
      setStatusMsg({
        type: 'err',
        text: t('Could not copy script — open scripts/{value0} manually.', { value0: file }),
      });
    }
  }, []);

  const supported = useMemo(
    () => (uploadFiles ? uploadFiles.filter((f) => isPotentialExport(relativePathOf(f))) : []),
    [uploadFiles],
  );

  const applyPickedFiles = useCallback((files: readonly RelativeFile[]) => {
    if (!files.length) return;

    setPath('');
    setUploadFiles([...files]);
    const first = relativePathOf(files[0]!).replace(/\\/g, '/');
    const folder = first.includes('/') ? first.split('/')[0] : null;
    const sup = files.filter((f) => isPotentialExport(relativePathOf(f)));
    setPickedLabel(
      folder
        ? t('{count} export files from {folder}', { count: formatNumber(sup.length), folder })
        : t('{count} export files selected', { count: formatNumber(sup.length) }),
    );
    setPreview(
      files.map((f) => {
        const relPath = relativePathOf(f);
        return {
          name: relPath.replace(/\\/g, '/').split('/').pop() ?? '',
          ok: isPotentialExport(relPath),
        };
      }),
    );
  }, []);

  const onPickFolder = useCallback(() => {
    const files = pickerRef.current?.files;
    if (!files?.length) return;
    applyPickedFiles(Array.from(files) as RelativeFile[]);
  }, [applyPickedFiles]);

  const onDropFiles = useCallback(
    async (dataTransfer: DataTransfer) => {
      try {
        const entries = Array.from(dataTransfer.items)
          .map(
            (item) =>
              (item as DataTransferItemWithEntry).webkitGetAsEntry?.() as
                DragFileSystemEntry | null | undefined,
          )
          .filter((entry): entry is DragFileSystemEntry => !!entry);
        const files = entries.length
          ? (await Promise.all(entries.map((entry) => filesFromEntry(entry)))).flat()
          : (Array.from(dataTransfer.files) as RelativeFile[]);
        if (!files.length) {
          setPickedLabel('Drop did not include readable files. Use Choose folder instead.');
          return;
        }
        applyPickedFiles(files);
      } catch (e) {
        setPickedLabel(`Drop failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
      }
    },
    [applyPickedFiles],
  );

  const onUsePath = useCallback(async () => {
    if (!path.trim()) return;
    setUploadFiles(null);
    setPreview(null);
    setPickedLabel('Checking…');
    try {
      const d = await api.ingestPreview(path, targetColl);
      const duplicatePaths = new Set(d.duplicates.map((item) => item.sourceFile));
      setPickedLabel(
        `${d.files.length} export files found${
          duplicatePaths.size ? `, ${duplicatePaths.size} will be re-indexed` : ''
        }`,
      );
      setPreview(
        d.files.map((f) => {
          const name = String(f).replace(/\\/g, '/').split('/').pop() ?? '';
          return {
            name,
            ok: true,
            note: duplicatePaths.has(f) ? 're-index' : '',
          };
        }),
      );
    } catch (e) {
      setPickedLabel(`Error: ${e instanceof Error ? e.message : 'Unknown'}`);
    }
  }, [path, targetColl]);

  const doIndex = useCallback(async () => {
    const useUpload = uploadFiles && supported.length > 0;
    let coll = targetColl;
    if (useUpload && coll === 'chunks') {
      const first = relativePathOf(uploadFiles[0]!).replace(/\\/g, '/');
      if (first.includes('/')) coll = first.split('/').filter(Boolean)[0] ?? coll;
    }
    if (!useUpload && !path.trim()) {
      setStatusMsg({ type: 'err', text: t('Choose a folder or enter a path.') });
      return;
    }
    setRunning(true);
    setSubmittedId('');
    setProgress({
      pct: 0,
      step: t(
        useUpload
          ? 'Uploading files. Keep this tab open until the server confirms receipt.'
          : 'Submitting import job…',
      ),
    });
    setStatusMsg(null);
    const controller = new AbortController();
    indexingController.current = controller;
    try {
      // Include local image companions while unrelated documents remain previewed as skipped.
      const files = useUpload
        ? uploadFiles.filter(
            (file) =>
              isPotentialExport(relativePathOf(file)) ||
              /\.(?:png|jpe?g|gif|webp)$/i.test(file.name),
          )
        : [];
      const accepted = useUpload
        ? await createUploadJob(files, coll, clearFirst, controller.signal)
        : await createFolderJob(path, coll, clearFirst, controller.signal);
      setSubmittedId(accepted.job.id);
      setStatusMsg({
        type: 'info',
        text: t('Files received. You can close this tab; processing continues on the server.'),
      });
      await queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    } catch (e) {
      setStatusMsg({
        type: controller.signal.aborted ? 'info' : 'err',
        text: controller.signal.aborted
          ? t('Transfer stopped. Check the job list before submitting again.')
          : e instanceof Error
            ? e.message
            : t('Unknown error'),
      });
    } finally {
      if (indexingController.current === controller) indexingController.current = null;
      setRunning(false);
      setProgress(null);
      void onRefresh();
    }
  }, [uploadFiles, supported, targetColl, path, clearFirst, onRefresh, queryClient]);

  const submitted = jobs.data?.jobs.find((job) => job.id === submittedId);
  const displayedProgress = running
    ? progress
    : submitted &&
        ['queued', 'running', 'paused', 'interrupted'].includes(submitted.state) &&
        submitted.progress
      ? progressFromEvent(submitted.progress)
      : null;
  const displayedStatus =
    submitted && ['completed', 'failed', 'cancelled'].includes(submitted.state)
      ? {
          type: submitted.state === 'completed' ? 'info' : 'err',
          text:
            submitted.error ||
            (submitted.state === 'cancelled'
              ? t('Import cancelled.')
              : formatCompletedMessage({ status: 'completed', result: submitted.result })),
        }
      : statusMsg;

  const realCollections = collections.filter((c) => c !== 'all');

  return (
    <div className="view">
      <div className="section-h indexing-heading">
        <h2>{t('Index a folder')}</h2>
        <span className="desc">
          {t(
            'Local parse → chunk → embed → write to LanceDB. Your chat data stays on this machine.',
          )}
        </span>
        <button className="btn sm manage-uploads-button" onClick={() => setUploadsOpen(true)}>
          {t('Manage uploads')}
        </button>
      </div>

      <details className="panel export-guides" style={{ marginBottom: 16 }}>
        <summary
          style={{ cursor: 'pointer', padding: '12px 14px', fontWeight: 500, listStyle: 'revert' }}
        >
          {Icons.info}
          {t(' Where to get your data (export guides)')}
        </summary>
        <div
          style={{
            padding: '4px 14px 16px',
            fontSize: 13,
            color: 'var(--text-2)',
            display: 'grid',
            gap: 16,
          }}
        >
          <div>
            <b style={{ color: 'var(--text-1)' }}>{t('OpenRouter')}</b>
            {t(
              ' — no built-in export. Run a browser-console script, then index the downloaded folder:',
            )}
            <ol style={{ margin: '6px 0', paddingLeft: 20, lineHeight: 1.7 }}>
              <li>{t('Open openrouter.ai signed in, with your chat list visible.')}</li>
              <li>
                {t('Open DevTools → Console (')}
                <kbd>F12</kbd>).
              </li>
              <li>{t('Copy a script below, paste into the console, press Enter.')}</li>
              <li>{t('Allow “multiple downloads” if asked; then index the folder here.')}</li>
            </ol>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn sm"
                onClick={() => void copyScript('openrouter-export-all.js')}
              >
                {Icons.copy}{' '}
                {copied === 'openrouter-export-all.js'
                  ? t('Copied!')
                  : t('Copy “export all chats” script')}
              </button>
              <button
                className="btn sm"
                onClick={() => void copyScript('openrouter-export-browser.js')}
              >
                {Icons.copy}{' '}
                {copied === 'openrouter-export-browser.js'
                  ? t('Copied!')
                  : t('Copy “single chat” script')}
              </button>
            </div>
          </div>

          <div>
            <b style={{ color: 'var(--text-1)' }}>{t('LM Studio')}</b>
            {t(' — point at its local conversation folder (paste into “paste path” below):')}
            <ul style={{ margin: '6px 0', paddingLeft: 20, lineHeight: 1.8 }}>
              <li>
                {t('Windows: ')}
                <code>%USERPROFILE%\.lmstudio\conversations\</code>
              </li>
              <li>
                {t('macOS / Linux: ')}
                <code>~/.lmstudio/conversations/</code>
              </li>
              <li>
                {t('Older builds: ')}
                <code>~/.cache/lm-studio/conversations/</code>
              </li>
            </ul>
          </div>

          <div>
            <b style={{ color: 'var(--text-1)' }}>{t('Google AI Studio')}</b>
            {t(
              ' — download your Google Drive “Google AI Studio” folder, unzip it, and index that folder (files may have no extension — that’s fine). Text chats and Imagen prompt histories are supported.',
            )}
          </div>

          <div>
            <b style={{ color: 'var(--text-1)' }}>{t('ChatGPT / Claude')}</b>
            {t(' — use the app’s official data export, then index the ')}
            <code>conversations.json</code>
            {t(' it produces.')}
          </div>
        </div>
      </details>

      <div
        className="drop-zone"
        data-dragging={dragging}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void onDropFiles(e.dataTransfer);
        }}
      >
        <div className="ico-big">{Icons.folder}</div>
        <h3>{t('Drop export files or a folder here')}</h3>
        <p>
          {t(
            'Import JSON, HTML, ZIP archives, or folders from ChatGPT/OpenAI, Claude/Anthropic, Google AI Studio, Gemini Takeout, OpenRouter, LM Studio, Grok, Meta, and Venice. ThreadShelf Local Reader and ChatGPT Export Processor formats are supported. Subfolders are included; account metadata files are skipped automatically.',
          )}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <input
            id="exportFileInput"
            ref={filesPickerRef}
            type="file"
            accept=".json,.html,.htm,.zip"
            multiple
            hidden
            onChange={(event) => {
              applyPickedFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = '';
            }}
          />
          <input
            id="folderFileInput"
            ref={pickerRef}
            type="file"
            style={{ display: 'none' }}
            {...({
              webkitdirectory: '',
              directory: '',
            } as React.InputHTMLAttributes<HTMLInputElement>)}
            multiple
            onChange={onPickFolder}
          />
          <button className="btn primary" onClick={() => pickerRef.current?.click()}>
            {Icons.folder}
            {t(' Choose folder')}
          </button>
          <button className="btn" onClick={() => filesPickerRef.current?.click()}>
            {Icons.plus}
            {t(' Choose files')}
          </button>
          {pickedLabel && (
            <span
              id="folderChosenLabel"
              className="mono"
              style={{ fontSize: 12, color: 'var(--text-2)' }}
            >
              {pickedLabel}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', margin: '4px 0' }}>
          {t('or paste path')}
        </div>
        <div className="path-input">
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t('/absolute/path/to/exports')}
          />
          <button className="btn" onClick={onUsePath} disabled={!path}>
            {Icons.arrowRight}
            {t(' Use path')}
          </button>
        </div>
      </div>

      <div className="ingest-options">
        <label style={{ color: 'var(--text-3)' }}>{t('Target collection')}</label>
        <select
          id="targetCollectionSelect"
          value={targetColl}
          onChange={(e) => setTargetColl(e.target.value)}
          className="btn sm"
          style={{ padding: '0 8px', background: 'var(--bg-2)' }}
        >
          {realCollections.map((c) => (
            <option key={c} value={c}>
              {collLabel(c)}
            </option>
          ))}
        </select>
        <button
          id="newCollectionBtnIndexing"
          className="btn sm"
          onClick={() => setNewCollOpen(true)}
          title={t('Create a new collection')}
        >
          {Icons.plus}
          {t(' New')}
        </button>
        <label>
          <input
            type="checkbox"
            checked={clearFirst}
            onChange={(e) => setClearFirst(e.target.checked)}
          />{' '}
          {t('Clear collection first')}
        </label>
        <button id="ingestBtn" className="btn primary" onClick={doIndex} disabled={running}>
          {Icons.zap} {running ? t('Uploading…') : t('Index folder')}
        </button>
        {running && (
          <button
            id="stopIngestBtn"
            className="btn danger"
            onClick={() => indexingController.current?.abort()}
          >
            {t('Cancel transfer')}
          </button>
        )}
      </div>

      {preview && preview.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h3>{t('Ingest preview')}</h3>
            <span className="sub">
              {preview.filter((f) => f.ok).length}
              {t(' ok · ')}
              {preview.filter((f) => !f.ok).length} {t('skipped')}
            </span>
          </div>
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            {preview.slice(0, 60).map((f, i) => (
              <div key={i} className="ingest-preview-row">
                <span style={{ color: f.ok ? 'var(--success)' : 'var(--text-4)' }}>
                  {f.ok ? Icons.check : '·'}
                </span>
                <span
                  className="ingest-preview-name"
                  title={f.name}
                  style={{
                    color: f.ok ? 'var(--text-1)' : 'var(--text-3)',
                  }}
                >
                  {f.name}
                </span>
                <span className="ingest-preview-note">{t(f.note || (f.ok ? '' : 'skipped'))}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {displayedProgress && (
        <div className="progress-panel">
          <div className="progress-head">
            <span className="step">
              <b>{displayedProgress.step}</b>
            </span>
            <span className="pct">{formatNumber(displayedProgress.pct)}%</span>
          </div>
          <div className="progress-bar-new">
            <i style={{ width: `${formatNumber(displayedProgress.pct)}%` }} />
          </div>
          {displayedProgress.chunks != null && (
            <div className="progress-details-new">
              {t('Chunks: ')}
              <strong>{formatNumber(displayedProgress.chunks)}</strong>
              <span style={{ color: 'var(--text-4)' }}>·</span>
              {t('Time: ')}
              <strong>{fmtTime(displayedProgress.time ?? 0)}</strong>
            </div>
          )}
          {displayedProgress.file && (
            <div className="progress-file">{displayedProgress.file.replace(/^.*[\\/]/, '')}</div>
          )}
        </div>
      )}

      {displayedStatus && (
        <div id="ingestStatus" className={`banner ${displayedStatus.type}`}>
          <span className="ico">{displayedStatus.type === 'err' ? Icons.warn : Icons.check}</span>
          <div className="grow">{displayedStatus.text}</div>
        </div>
      )}

      <ImportJobsPanel onRefresh={onRefresh} />
      {uploadsOpen && <UploadStorageModal onClose={() => setUploadsOpen(false)} />}

      {newCollOpen && (
        <NewCollectionModal
          open
          onClose={() => setNewCollOpen(false)}
          onCreated={(name) => {
            setTargetColl(name);
            void onRefresh();
          }}
        />
      )}
    </div>
  );
}
