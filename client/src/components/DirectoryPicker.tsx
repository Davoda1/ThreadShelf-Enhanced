import { t, useI18n } from '../i18n';
import { useState } from 'react';
import { api } from '../api';
import type { DirectoryBrowserResponse } from '../types';

interface DirectoryPickerProps {
  readonly initialPath?: string;
  readonly onSelect: (path: string) => void;
}

export function DirectoryPicker({ initialPath, onSelect }: DirectoryPickerProps) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DirectoryBrowserResponse | null>(null);
  const [path, setPath] = useState(initialPath || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const browse = async (nextPath?: string) => {
    setLoading(true);
    setError('');
    try {
      const response = await api.generationDirectories(nextPath);
      setData(response);
      setPath(response.path);
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not browse system folders.');
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <div className="directory-picker-launch">
        <button
          className="btn sm"
          type="button"
          disabled={loading}
          onClick={() => void browse(path)}
        >
          {loading ? t('Opening…') : t('Browse system folders…')}
        </button>
        {error && <span className="field-error">{t(error)}</span>}
      </div>
    );
  }

  return (
    <div className="directory-picker">
      <div className="directory-picker-bar">
        <button
          className="btn sm"
          type="button"
          disabled={!data?.parent || loading}
          onClick={() => void browse(data?.parent)}
        >
          {t('Up')}
        </button>
        <input
          aria-label={t('System folder path')}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void browse(path);
          }}
        />
        <button
          className="btn sm"
          type="button"
          disabled={loading}
          onClick={() => void browse(path)}
        >
          {t('Go')}
        </button>
        <button className="btn sm" type="button" onClick={() => setOpen(false)}>
          {t('Close')}
        </button>
      </div>
      <div className="directory-picker-roots">
        {data?.roots.map((root) => (
          <button type="button" key={root.path} onClick={() => void browse(root.path)}>
            {root.name}
          </button>
        ))}
      </div>
      {error && <div className="field-error">{t(error)}</div>}
      <div className="directory-picker-list" role="listbox" aria-label={t('System folders')}>
        {data?.directories.map((directory) => (
          <button
            type="button"
            role="option"
            aria-selected="false"
            key={directory.path}
            onClick={() => void browse(directory.path)}
          >
            <span aria-hidden="true">▸</span>
            {directory.name}
          </button>
        ))}
        {data?.directories.length === 0 && <span>{t('No subdirectories')}</span>}
      </div>
      {data?.truncated && <span className="sub">{t('Showing the first 500 directories.')}</span>}
      <div className="directory-picker-foot">
        <span title={data?.path}>{data?.path}</span>
        <button
          className="btn primary sm"
          type="button"
          onClick={() => {
            if (data?.path) onSelect(data.path);
            setOpen(false);
          }}
        >
          {t('Add this folder')}
        </button>
      </div>
    </div>
  );
}
