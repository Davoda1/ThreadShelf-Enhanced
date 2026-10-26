import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatNumber, t, useI18n } from '../i18n';
import { confirmDialog, useToastStore } from '../toast';
import { fmtBytes } from '../utils';
import { deleteUploadedFiles, listUploadCollections, listUploadedFiles } from '../upload-storage';

export function UploadStorageModal({ onClose }: { onClose: () => void }) {
  useI18n();
  const queryClient = useQueryClient();
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const restoreActionFocus = useRef(false);
  const [chosen, setChosen] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const collections = useQuery({
    queryKey: ['upload-storage', 'collections'],
    queryFn: ({ signal }) => listUploadCollections(signal),
    retry: 1,
  });
  const names = collections.data?.collections.map((entry) => entry.collection) ?? [];
  const collection = chosen || names[0] || '';
  const cursor = cursors[cursors.length - 1] ?? null;
  const files = useQuery({
    queryKey: ['upload-storage', 'files', collection, cursor],
    queryFn: ({ signal }) => listUploadedFiles(collection, cursor, signal),
    enabled: !!collection,
    refetchInterval: busy ? false : 5000,
    retry: 1,
  });
  const rows = files.data?.files ?? [];
  const locked = !!files.data?.locked;
  const disabled = busy || locked || files.isFetching || !collection || !!files.error;
  const visibleSelected = selected.filter((path) => rows.some((file) => file.path === path));

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    if (!busy && restoreActionFocus.current) {
      restoreActionFocus.current = false;
      closeButton.current?.focus();
    }
  }, [busy]);

  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (useToastStore.getState().confirmState) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
    }
    if (event.key !== 'Tab') return;
    const controls = [
      ...(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]',
      ) ?? []),
    ].filter((element) => element.getClientRects().length);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['upload-storage'] });
  };
  const remove = async (all: boolean) => {
    if (disabled || (!all && !visibleSelected.length)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const confirmed = await confirmDialog({
        title: all
          ? t('Delete all uploaded files in "{collection}"?', { collection })
          : t('Delete {count} selected uploaded files?', {
              count: formatNumber(visibleSelected.length),
            }),
        message: t(
          'This permanently deletes the uploaded originals. Imported conversations and search indexes remain. Images and older conversations that still need these files may become unavailable. Keep a backup if you need to import them again.',
        ),
        confirmLabel: t(all ? 'Delete all uploaded files' : 'Delete selected files'),
        danger: true,
      });
      if (!confirmed) return;
      setChosen(collection);
      const result = await deleteUploadedFiles(
        collection,
        all ? { all: true } : { paths: visibleSelected },
      );
      setSelected([]);
      setCursors([null]);
      setNotice(t('Deleted {count} uploaded files.', { count: formatNumber(result.deleted) }));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Unknown error'));
      await refresh();
    } finally {
      restoreActionFocus.current = true;
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="scrim upload-storage-scrim"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={dialog}
        className="modal-card upload-storage-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-storage-title"
        aria-describedby="upload-storage-description"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={keyboard}
      >
        <div className="modal-head upload-storage-head">
          <div>
            <h3 id="upload-storage-title">{t('Manage uploads')}</h3>
            <p id="upload-storage-description">
              {t('Manage uploaded originals separately from your imported conversations.')}
            </p>
          </div>
          <button ref={closeButton} className="btn sm ghost" disabled={busy} onClick={onClose}>
            {t('Close')}
          </button>
        </div>
        <div className="modal-body upload-storage-body">
          <div className="upload-storage-toolbar">
            <label htmlFor="upload-storage-collection">{t('Collection')}</label>
            <select
              id="upload-storage-collection"
              className="btn sm"
              value={collection}
              disabled={busy || collections.isPending}
              onChange={(event) => {
                setChosen(event.target.value);
                setCursors([null]);
                setSelected([]);
                setError('');
                setNotice('');
              }}
            >
              {!collection && <option value="">{t('No uploaded files.')}</option>}
              {[...new Set([...names, ...(chosen ? [chosen] : [])])].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button
              className="btn sm"
              disabled={busy || files.isFetching || collections.isFetching}
              onClick={() => void refresh()}
            >
              {t('Refresh')}
            </button>
          </div>
          <p className="upload-storage-note">
            {t(
              'Only stored uploads are listed. Incoming transfers and import retry files are managed separately.',
            )}
          </p>
          {locked && (
            <p className="banner info" role="status">
              {t(
                'These uploads are in use. Finish or cancel active imports, or remove finished job history that still needs the originals.',
              )}
            </p>
          )}
          {(error || collections.error || files.error) && (
            <p className="banner err" role="alert">
              {t(error || collections.error?.message || files.error?.message || 'Unknown error')}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {(collections.isPending || (collection && files.isPending)) && (
            <p role="status">{t('Loading uploaded files…')}</p>
          )}
          {!collections.isPending &&
            (!collection || (!files.isPending && !rows.length && !files.error)) && (
              <p>{t('No uploaded files.')}</p>
            )}
          {!!rows.length && (
            <>
              <label className="upload-storage-select-all">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={visibleSelected.length === rows.length}
                  onChange={(event) =>
                    setSelected(event.target.checked ? rows.map((file) => file.path) : [])
                  }
                />
                {t('Select files on this page')}
              </label>
              <ul className="upload-storage-files" aria-label={t('Uploaded files')}>
                {rows.map((file) => (
                  <li key={file.path}>
                    <label>
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={visibleSelected.includes(file.path)}
                        onChange={(event) =>
                          setSelected((values) =>
                            event.target.checked
                              ? [...values, file.path]
                              : values.filter((path) => path !== file.path),
                          )
                        }
                      />
                      <span className="upload-storage-path" title={file.path}>
                        {file.path}
                      </span>
                      <span className="upload-storage-size">{fmtBytes(file.bytes)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          {(cursors.length > 1 || files.data?.nextCursor) && (
            <div className="upload-storage-pagination">
              <button
                className="btn sm"
                disabled={busy || files.isFetching || cursors.length === 1}
                onClick={() => {
                  setCursors((values) => values.slice(0, -1));
                  setSelected([]);
                }}
              >
                {t('Previous')}
              </button>
              <span>{t('Page {page}', { page: formatNumber(cursors.length) })}</span>
              <button
                className="btn sm"
                disabled={busy || files.isFetching || !files.data?.nextCursor}
                onClick={() => {
                  if (files.data?.nextCursor)
                    setCursors((values) => [...values, files.data!.nextCursor]);
                  setSelected([]);
                }}
              >
                {t('Next')}
              </button>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button
            className="btn danger"
            disabled={disabled || !visibleSelected.length}
            onClick={() => void remove(false)}
          >
            {t('Delete selected files')}
          </button>
          <button
            className="btn danger"
            disabled={disabled || !rows.length}
            onClick={() => void remove(true)}
          >
            {t('Delete all uploaded files')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
