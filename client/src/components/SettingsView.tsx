import { useCollectionLock } from '../import-jobs';
import { Link } from '@tanstack/react-router';
import { useUIStore } from '../store';
import { t, useI18n } from '../i18n';
import { useCallback } from 'react';
import type { CollectionStats } from '../types';
import { Icons } from '../icons';
import { collLabel } from '../utils';
import { confirmDialog, toast } from '../toast';
import { useFilesQuery, useClearCollectionMutation, useDeleteCollectionMutation } from '../queries';

interface DangerRowProps {
  readonly title: string;
  readonly desc: string;
  readonly btn: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

function DangerRow({ title, desc, btn, onClick, disabled }: DangerRowProps) {
  useI18n();
  return (
    <div className="danger-row">
      <div>
        <div className="title">{title}</div>
        <div className="desc">{desc}</div>
      </div>
      <button
        className="btn danger"
        onClick={onClick}
        disabled={disabled}
        title={
          disabled
            ? t('Collection replacement in progress. Changes are temporarily blocked.')
            : undefined
        }
      >
        {Icons.trash} {btn}
      </button>
    </div>
  );
}

interface SettingsViewProps {
  readonly activeColl: string;
  readonly stats: Readonly<Record<string, CollectionStats>>;
  readonly onRefresh: () => Promise<void>;
  readonly onDeleted: () => void;
}

export function SettingsView({ activeColl, stats, onRefresh, onDeleted }: SettingsViewProps) {
  useI18n();
  const collectionLock = useCollectionLock(activeColl);
  const isAll = activeColl === 'all' || activeColl === '__all__';
  const { data: filesData } = useFilesQuery(activeColl, !isAll);
  const files = filesData ? [...new Set(filesData.files.map((f) => f.sourceFile))] : null;

  const clearMutation = useClearCollectionMutation();
  const deleteMutation = useDeleteCollectionMutation();

  const doClear = useCallback(async () => {
    if (collectionLock) {
      toast.info(t('Collection replacement in progress. Changes are temporarily blocked.'));
      return;
    }
    if (activeColl === 'threadshelf_conversations') {
      toast.error(t('ThreadShelf conversations are managed from the Chat page.'));
      return;
    }
    const ok = await confirmDialog({
      title: t('Clear indexed data for "{value0}"?', { value0: collLabel(activeColl) }),
      message: 'All vectors are dropped, but the collection itself is kept.',
      confirmLabel: t('Clear data'),
      danger: true,
    });
    if (!ok) return;
    try {
      await clearMutation.mutateAsync(activeColl);
      void onRefresh();
      toast.success(t('Cleared "{value0}".', { value0: collLabel(activeColl) }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('Unknown error'));
    }
  }, [activeColl, onRefresh, clearMutation, collectionLock]);

  const doDelete = useCallback(async () => {
    if (collectionLock) {
      toast.info(t('Collection replacement in progress. Changes are temporarily blocked.'));
      return;
    }
    if (activeColl === 'chunks' || activeColl === 'threadshelf_conversations') {
      toast.error(t('Cannot delete the default collection.'));
      return;
    }
    const ok = await confirmDialog({
      title: t('Delete collection "{value0}"?', { value0: collLabel(activeColl) }),
      message:
        'The index and copies previously uploaded through ThreadShelf are deleted. Files in the original folder you selected remain untouched.',
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteMutation.mutateAsync(activeColl);
      await onRefresh();
      toast.success(t('Deleted "{value0}".', { value0: collLabel(activeColl) }));
      onDeleted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('Unknown error'));
    }
  }, [activeColl, onRefresh, onDeleted, deleteMutation, collectionLock]);

  if (isAll) {
    return (
      <div className="view">
        <div className="section-h">
          <h2>{t('Collection settings')}</h2>
          <span className="desc">{t('Pick a collection from the sidebar to manage it.')}</span>
        </div>
        <div className="banner info">
          <span className="ico">{Icons.info}</span>
          <div className="grow">
            {t('Destructive actions are disabled while ')}
            <b>{t('All collections')}</b>
            {t(' is selected.')}
          </div>
        </div>
      </div>
    );
  }

  const st = stats[activeColl];
  const roles = st?.roles ?? { user: 0, thinking: 0, ai: 0 };
  const totalRoles = roles.user + roles.thinking + roles.ai;

  return (
    <div className="view">
      <div className="section-h">
        <h2>
          <span className="mono" style={{ fontWeight: 500 }}>
            {collLabel(activeColl)}
          </span>
        </h2>
        <span className="desc">{t('Local LanceDB table')}</span>
      </div>

      {collectionLock && (
        <div className="banner info" role="status">
          <span>{t('Collection replacement in progress. Changes are temporarily blocked.')}</span>
          <Link to="/indexing">{t('View import progress')}</Link>
        </div>
      )}
      <div className="panel" style={{ padding: 0 }}>
        <div className="stat-grid">
          <div className="stat">
            <span className="k">{t('files')}</span>
            <span className="v">
              {(st?.files ?? 0).toLocaleString(useUIStore.getState().locale)}
            </span>
            <span className="d">{t('source exports')}</span>
          </div>
          <div className="stat">
            <span className="k">{t('chunks')}</span>
            <span className="v">
              {(st?.chunks ?? 0).toLocaleString(useUIStore.getState().locale)}
            </span>
            <span className="d">{t('indexed vectors')}</span>
          </div>
          <div className="stat">
            <span className="k">{t('user')}</span>
            <span className="v">{roles.user.toLocaleString(useUIStore.getState().locale)}</span>
            <span className="d">{t('user turns')}</span>
          </div>
          <div className="stat">
            <span className="k">{t('response')}</span>
            <span className="v">{roles.ai.toLocaleString(useUIStore.getState().locale)}</span>
            <span className="d">{t('ai turns')}</span>
          </div>
        </div>

        {totalRoles > 0 && (
          <div className="role-dist">
            <div className="role-bar">
              <i className="user" style={{ flex: roles.user }} />
              <i className="thinking" style={{ flex: roles.thinking }} />
              <i className="ai" style={{ flex: roles.ai }} />
            </div>
            <div className="role-legend">
              <span>
                <i className="user" />
                {t('User ')}
                {roles.user}
              </span>
              <span>
                <i className="thinking" />
                {t('Thinking ')}
                {roles.thinking}
              </span>
              <span>
                <i className="ai" />
                {t('Response ')}
                {roles.ai}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>{t('Indexed files')}</h3>
          <span className="sub">
            {st?.files ?? 0}
            {t(' files')}
          </span>
        </div>
        <div className="file-list">
          {files === null && <div className="file-list-empty">{t('Loading…')}</div>}
          {files && files.length === 0 && (
            <div className="file-list-empty">{t('No indexed files.')}</div>
          )}
          {files?.map((f, i) => {
            const short = String(f).replace(/\\/g, '/').split('/').pop();
            return (
              <div key={i} className="file-row">
                <i />
                <span className="name" title={String(f)}>
                  {short}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>{t('Danger zone')}</h3>
          <span className="sub">{t('destructive, irreversible')}</span>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {activeColl === 'threadshelf_conversations' ? (
            <p className="muted">
              {t(
                'This protected collection is maintained automatically from chats created or continued in ThreadShelf.',
              )}
            </p>
          ) : (
            <>
              <DangerRow
                title={t('Clear indexed data')}
                desc={t('Drop all vectors but keep the collection itself.')}
                btn={t('Clear data')}
                onClick={doClear}
                disabled={
                  Boolean(collectionLock) || clearMutation.isPending || deleteMutation.isPending
                }
              />
              <DangerRow
                title={t('Delete collection')}
                desc={t(
                  'Delete the index and ThreadShelf upload copies. Files in your original folder stay untouched.',
                )}
                btn={t('Delete')}
                onClick={doDelete}
                disabled={
                  Boolean(collectionLock) || clearMutation.isPending || deleteMutation.isPending
                }
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
