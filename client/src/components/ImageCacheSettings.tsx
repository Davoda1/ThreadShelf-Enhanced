import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n, formatNumber } from '../i18n';
import { confirmDialog, toast } from '../toast';
import { collLabel } from '../utils';

interface ImageCacheStatus {
  enabled: boolean;
  maxBytes: number;
  bytes: number;
  count: number;
  collections: { collection: string; bytes: number; count: number }[];
}
const MIB = 1024 * 1024;
async function cacheRequest(init?: RequestInit, collection?: string): Promise<ImageCacheStatus> {
  const response = await fetch(
    `/api/image-cache${collection === undefined ? '' : `?collection=${encodeURIComponent(collection)}`}`,
    init,
  );
  const body = await response.json();
  if (!response.ok)
    throw new Error(typeof body.error === 'string' ? body.error : 'Image cache request failed.');
  return body as ImageCacheStatus;
}
function CacheControls({ status }: { readonly status: ImageCacheStatus }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState(String(Math.round(status.maxBytes / MIB)));
  const [busy, setBusy] = useState(false);
  const number = Number(limit);
  const validLimit =
    /^\d+$/.test(limit) && Number.isInteger(number) && number >= 16 && number <= 4096;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['image-cache'] });
  const save = async (patch: { enabled?: boolean; maxBytes?: number }) => {
    setBusy(true);
    try {
      await cacheRequest({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      await refresh();
      toast.success(t('Image cache settings saved.'));
    } catch (error) {
      toast.error(t(error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setBusy(false);
    }
  };
  const clear = async (collection?: string) => {
    const accepted = await confirmDialog({
      title:
        collection === undefined
          ? t('Clear all cached images?')
          : t('Clear cached images for {collection}?', { collection: collLabel(collection) }),
      message: t(
        'Only cached image copies are removed. Conversations, uploaded files and the search index remain unchanged.',
      ),
      confirmLabel: t('Clear cache'),
      danger: true,
    });
    if (!accepted) return;
    setBusy(true);
    try {
      await cacheRequest({ method: 'DELETE' }, collection);
      await refresh();
      toast.success(t('Image cache cleared.'));
    } catch (error) {
      toast.error(t(error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setBusy(false);
    }
  };
  const size = (bytes: number) => `${formatNumber(bytes / MIB, { maximumFractionDigits: 1 })} MiB`;
  return (
    <div className="panel-body image-cache-settings">
      <label className="render-setting">
        <input
          id="image-cache-enabled"
          type="checkbox"
          checked={status.enabled}
          disabled={busy}
          onChange={(event) => void save({ enabled: event.target.checked })}
        />
        <span>{t('Cache external images on the server')}</span>
      </label>
      <p className="muted">
        {t(
          'This optional cache is separate from conversations and search data. It stores images only on the server and groups them by collection.',
        )}
      </p>
      <p className="muted">
        {t(
          'Turning caching off keeps existing cached files but stops using them. Clear the cache to remove those copies.',
        )}
      </p>
      <div className="cache-limit">
        <label htmlFor="image-cache-limit">{t('Maximum cache size (MiB)')}</label>
        <input
          id="image-cache-limit"
          type="number"
          min={16}
          max={4096}
          step={1}
          value={limit}
          disabled={busy}
          onChange={(event) => setLimit(event.target.value)}
        />
        <button
          className="btn sm"
          disabled={busy || !validLimit || number * MIB === status.maxBytes}
          onClick={() => void save({ maxBytes: number * MIB })}
        >
          {t('Save')}
        </button>
      </div>
      {!validLimit && (
        <p className="error" role="alert">
          {t('Enter a whole number from 16 to 4096.')}
        </p>
      )}
      <p>
        {t('Cached images: {count} · Used: {size}', {
          count: formatNumber(status.count),
          size: size(status.bytes),
        })}
      </p>
      {status.collections.length > 0 && (
        <div className="file-list">
          {status.collections.map((entry) => (
            <div className="file-row cache-row" key={entry.collection}>
              <span className="name" title={collLabel(entry.collection)}>
                {collLabel(entry.collection)}
              </span>
              <span>
                {formatNumber(entry.count)} · {size(entry.bytes)}
              </span>
              <button
                className="btn sm"
                disabled={busy}
                onClick={() => void clear(entry.collection)}
                aria-label={t('Clear image cache for {collection}', {
                  collection: collLabel(entry.collection),
                })}
              >
                {t('Clear cache')}
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        className="btn danger"
        disabled={busy || status.count === 0}
        onClick={() => void clear()}
      >
        {t('Clear all cached images')}
      </button>
    </div>
  );
}
export function ImageCacheSettings() {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['image-cache'],
    queryFn: ({ signal }) => cacheRequest({ signal }),
    refetchInterval: 15_000,
  });
  return (
    <section className="panel" aria-labelledby="image-cache-heading">
      <div className="panel-head">
        <h2 id="image-cache-heading">{t('Server image cache')}</h2>
      </div>
      {query.isPending && <p className="panel-body">{t('Loading…')}</p>}
      {query.error && (
        <p className="panel-body error" role="alert">
          {t(query.error.message)}{' '}
          <button className="btn sm" onClick={() => void query.refetch()}>
            {t('Try again')}
          </button>
        </p>
      )}
      {query.data && <CacheControls key={query.data.maxBytes} status={query.data} />}
    </section>
  );
}
