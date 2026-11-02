import { NativeSelect } from './NativeSelect';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  vaultApi,
  type VaultConfig,
  type VaultApproval,
  type VaultNote,
  type VaultSearch,
} from '../obsidian';
import { DirectoryPicker } from './DirectoryPicker';
import { Markdown } from './Markdown';
import { useI18n } from '../i18n';
import { useUIStore } from '../store';
import './obsidian.css';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Vault operation failed';
export const useVaultConfig = () =>
  useQuery({ queryKey: ['obsidian-config'], queryFn: ({ signal }) => vaultApi.config(signal) });
export const useVaultRegistry = () =>
  useQuery({ queryKey: ['obsidian-vaults'], queryFn: ({ signal }) => vaultApi.registry(signal) });
export function VaultWriteToggle({
  config,
  vaultId,
}: {
  readonly config: VaultConfig;
  readonly vaultId?: string;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div>
      <label className="vault-check">
        <input
          type="checkbox"
          checked={config.allowWrites}
          disabled={busy}
          onChange={async (event) => {
            const enabled = event.target.checked;
            setBusy(true);
            setError('');
            try {
              await vaultApi.writes(enabled, vaultId);
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['obsidian-config'] }),
                queryClient.invalidateQueries({ queryKey: ['obsidian-vaults'] }),
              ]);
            } catch (cause) {
              setError(message(cause));
            } finally {
              setBusy(false);
            }
          }}
        />{' '}
        {t('Allow vault writes')}
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function ObsidianChatControls({
  enabled,
  onChange,
  sending,
  external,
  ephemeral,
  vaultId,
  onVaultChange,
}: {
  readonly enabled: boolean;
  readonly onChange: (value: boolean) => void;
  readonly sending: boolean;
  readonly external: boolean;
  readonly ephemeral: boolean;
  readonly vaultId?: string;
  readonly onVaultChange?: (id: string) => void;
}) {
  const { t } = useI18n();
  const { data, error } = useVaultRegistry();
  const selectedId = vaultId ?? data?.activeId ?? '';
  const selected = data?.vaults.find((vault) => vault.id === selectedId);
  return (
    <div className="vault-chat-controls">
      <label className="vault-check">
        <input
          id="chatUseObsidian"
          type="checkbox"
          checked={enabled}
          disabled={sending || !selected}
          onChange={(event) => onChange(event.target.checked)}
        />{' '}
        {t('Notes tools')}
      </label>
      {data?.vaults.length ? (
        <NativeSelect
          className="vault-context-select"
          aria-label={t('Notes context')}
          value={selectedId}
          disabled={sending || !onVaultChange}
          onChange={(event) => onVaultChange?.(event.target.value)}
        >
          {!selected && <option value="">{t('Choose a note folder')}</option>}
          {data.vaults.map((vault) => (
            <option value={vault.id} key={vault.id}>
              {vault.name} · {vault.allowWrites ? t('Writes enabled') : t('Read-only')}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Link to="/settings" onClick={() => useUIStore.getState().setSettingsTab('server')}>
          {t('Connect your notes')}
        </Link>
      )}
      {enabled && (
        <span className="vault-hint">
          {external
            ? t('Retrieved note text is sent to the selected provider.')
            : t('Note tools run locally.')}{' '}
          {ephemeral && t('Private chat does not prevent approved vault writes.')}{' '}
          {selected?.allowWrites
            ? t('Each proposed change requires a preview and approval.')
            : t('Read-only.')}
        </span>
      )}
      {error && <span className="field-error">{message(error)}</span>}
    </div>
  );
}

/** Unified replacement preview: unchanged prefix/suffix collapse; every changed line remains visible. */
export function VaultChangePreview({
  before,
  after,
}: {
  readonly before: string;
  readonly after: string;
}) {
  const { t } = useI18n();
  const oldLines = before.split('\n'),
    newLines = after.split('\n');
  let prefix = 0,
    suffix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix++;
  const removed = oldLines
    .slice(prefix, oldLines.length - suffix)
    .map((line) => `− ${line}`)
    .join('\n');
  const added = newLines
    .slice(prefix, newLines.length - suffix)
    .map((line) => `+ ${line}`)
    .join('\n');
  return (
    <div className="vault-diff" aria-label={t('Proposed note changes')}>
      {before === after ? (
        <p>{t('No content changes.')}</p>
      ) : (
        <>
          {prefix > 0 && (
            <p className="muted">
              {prefix} {t('unchanged leading lines')}
            </p>
          )}
          {removed && (
            <pre className="vault-diff-removed" aria-label={t('Removed lines')}>
              {removed}
            </pre>
          )}
          {added && (
            <pre className="vault-diff-added" aria-label={t('Added lines')}>
              {added}
            </pre>
          )}
          {suffix > 0 && (
            <p className="muted">
              {suffix} {t('unchanged trailing lines')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
export function VaultDeleteApproval({
  approval,
  onDecision,
}: {
  readonly approval: VaultApproval;
  readonly onDecision: () => void;
}) {
  const { t } = useI18n();
  const [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const operation = approval.operation ?? 'delete';
  const decide = async (approve: boolean) => {
    setBusy(true);
    setError('');
    try {
      await vaultApi.decide(approval, approve, approve && checked);
      onDecision();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="vault-approval" role="group" aria-label={t('Review note change')}>
      <header>
        <strong>
          {approval.model}:{' '}
          {t(
            { create: 'Create note', edit: 'Edit note', delete: 'Move notes to trash' }[operation],
          )}
        </strong>
      </header>
      <ul>
        {approval.files.map((path) => (
          <li key={path} title={path}>
            {path}
          </li>
        ))}
      </ul>
      {operation !== 'delete' && (
        <VaultChangePreview before={approval.before ?? ''} after={approval.after ?? ''} />
      )}
      <p>
        {t(
          operation === 'delete'
            ? 'Files move to the vault’s .trash folder.'
            : 'Previous versions of edited notes are retained in .threadshelf-history.',
        )}{' '}
        {t('Approval expires after five minutes.')}
      </p>
      <label className="vault-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={(event) => setChecked(event.target.checked)}
        />{' '}
        {t('I reviewed and approve these exact changes')}
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <footer className="vault-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void decide(false)}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className={`btn ${operation === 'delete' ? 'danger' : 'primary'}`}
          disabled={!checked || busy}
          onClick={() => void decide(true)}
        >
          {t(busy ? 'Applying…' : 'Approve change')}
        </button>
      </footer>
    </section>
  );
}
export function ObsidianPanel() {
  const { t } = useI18n();
  const { data: registry, error: configError } = useVaultRegistry();
  const config = registry?.vaults.find((vault) => vault.id === registry.activeId);
  const { data: detected } = useQuery({
    queryKey: ['note-folders'],
    queryFn: ({ signal }) => vaultApi.detected(signal),
  });
  const queryClient = useQueryClient();
  const [draftPath, setDraftPath] = useState(''),
    [query, setQuery] = useState('');
  const [results, setResults] = useState<VaultSearch | null>(null),
    [note, setNote] = useState<VaultNote | null>(null);
  const [editor, setEditor] = useState<{
    path: string;
    content: string;
    original?: VaultNote;
  } | null>(null);
  const [preview, setPreview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const operation = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['obsidian-vaults'] }),
      queryClient.invalidateQueries({ queryKey: ['obsidian-config'] }),
    ]);
  };
  const clearView = () => {
    setResults(null);
    setNote(null);
    setEditor(null);
    setPreview(false);
  };
  const connect = (path: string) =>
    void operation(async () => {
      await vaultApi.save(path);
      await refresh();
      clearView();
      setDraftPath('');
      setNotice(path ? 'Note folder connected.' : 'Note folder disconnected.');
    });
  return (
    <section className="panel vault-panel" id="obsidianPanel" aria-labelledby="vault-heading">
      <div className="panel-head">
        <h2 id="vault-heading">{t('Markdown notes')}</h2>
        <span className="sub">Obsidian · Logseq · OpenClaw</span>
      </div>
      <div className="panel-body">
        <p>
          {t(
            'Connect folders of Markdown notes. Search and read the current files, or give a chat access to one selected folder. Notes stay in their original location.',
          )}
        </p>
        {!!registry?.vaults.length && (
          <div className="vault-connected">
            <label htmlFor="vault-context">{t('Connected note folders')}</label>
            <NativeSelect
              id="vault-context"
              value={registry.activeId}
              disabled={busy}
              onChange={(event) =>
                void operation(async () => {
                  await vaultApi.select(event.target.value);
                  await refresh();
                  clearView();
                })
              }
            >
              {!config && <option value="">{t('Choose a note folder')}</option>}
              {registry.vaults.map((vault) => (
                <option key={vault.id} value={vault.id}>
                  {vault.name} · {vault.vaultPath}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        {config && (
          <>
            <p className="vault-path" title={config.vaultPath}>
              {config.vaultPath}
            </p>
            <VaultWriteToggle config={config} vaultId={config.id} />
            <button type="button" className="btn ghost" disabled={busy} onClick={() => connect('')}>
              {t('Disconnect selected folder')}
            </button>
          </>
        )}
        <details className="vault-connect" open={!registry?.vaults.length}>
          <summary>{t('Connect another note folder')}</summary>
          {(detected?.folders ?? [])
            .filter((folder) => !registry?.vaults.some((vault) => vault.vaultPath === folder.path))
            .map((folder) => (
              <div className="vault-detected" key={folder.path}>
                <span title={folder.path}>
                  <strong>{folder.name}</strong> · {folder.source}
                  <small>{folder.path}</small>
                </span>
                <button
                  className="btn"
                  type="button"
                  disabled={busy || !registry}
                  onClick={() => connect(folder.path)}
                >
                  {t('Connect')}
                </button>
              </div>
            ))}
          <label htmlFor="obsidianVaultPath">{t('Absolute folder path')}</label>
          <input
            id="obsidianVaultPath"
            value={draftPath}
            onChange={(event) => setDraftPath(event.target.value)}
            placeholder={t('Path on the server computer')}
          />
          <DirectoryPicker initialPath={draftPath} onSelect={setDraftPath} />
          <button
            className="btn"
            type="button"
            disabled={busy || !registry || !draftPath.trim()}
            onClick={() => connect(draftPath)}
          >
            {t('Connect folder')}
          </button>
        </details>
        <p className="vault-hint">
          {t(
            'New folders are read-only. Writes also apply to MCP clients; chat changes always require a preview and approval. Hidden folders, attachments, symlinks and hard links are excluded. These live notes are separate from the conversation database.',
          )}
        </p>
        {config && (
          <>
            <form
              className="vault-search"
              onSubmit={(event) => {
                event.preventDefault();
                void operation(async () => {
                  setResults(await vaultApi.search(query, config.id));
                  setNote(null);
                });
              }}
            >
              <input
                id="obsidianSearchInput"
                aria-label={t('Search notes')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={1000}
                placeholder={t('Words in note text or paths')}
              />
              <button className="btn" disabled={busy || !query.trim()}>
                {t('Search notes')}
              </button>
            </form>
            {results && (
              <div className="vault-results">
                <p role="status">
                  {results.hits.length} {t('results')} · {results.scanned} {t('notes scanned')}
                  {results.skipped > 0 &&
                    ` · ${results.skipped} ${t('unsafe or unreadable files skipped')}`}
                  {results.truncated && ` · ${t('Scan limit reached; results may be incomplete.')}`}
                </p>
                {results.hits.map((hit) => (
                  <button
                    className="vault-result"
                    type="button"
                    disabled={busy}
                    key={hit.path}
                    onClick={() =>
                      void operation(async () => setNote(await vaultApi.read(hit.path, config.id)))
                    }
                  >
                    <strong title={hit.title}>{hit.title}</strong>
                    <span>
                      {hit.path}:{hit.line}
                      {hit.heading && ` · ${hit.heading}`}
                    </span>
                    <pre>{hit.snippet}</pre>
                  </button>
                ))}
              </div>
            )}
            {note && (
              <article className="vault-note">
                <header>
                  <strong>{note.path}</strong>
                  <div className="vault-actions">
                    <a
                      className="btn sm"
                      href={`obsidian://open?path=${encodeURIComponent(`${config.vaultPath.replace(/\\/g, '/')}/${note.path}`)}`}
                    >
                      {t('Open in Obsidian')}
                    </a>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy || !config.allowWrites}
                      onClick={() => {
                        setEditor({ path: note.path, content: note.content, original: note });
                        setPreview(false);
                      }}
                    >
                      {t('Edit note')}
                    </button>
                  </div>
                </header>
                <Markdown text={note.content} />
              </article>
            )}
            {!editor && (
              <button
                className="btn"
                type="button"
                disabled={busy || !config.allowWrites}
                onClick={() => {
                  setEditor({ path: '', content: '' });
                  setPreview(false);
                }}
              >
                {t('Create a Markdown note')}
              </button>
            )}
            {editor && (
              <section className="vault-editor" aria-label={t('Note editor')}>
                <label htmlFor="obsidianNewPath">{t('Relative note path (.md)')}</label>
                <input
                  id="obsidianNewPath"
                  value={editor.path}
                  disabled={!!editor.original || busy || preview}
                  onChange={(event) => setEditor({ ...editor, path: event.target.value })}
                />
                <label htmlFor="obsidianNewContent">Markdown</label>
                <textarea
                  id="obsidianNewContent"
                  rows={8}
                  value={editor.content}
                  disabled={busy || preview}
                  onChange={(event) => setEditor({ ...editor, content: event.target.value })}
                />
                {preview && (
                  <VaultChangePreview
                    before={editor.original?.content ?? ''}
                    after={editor.content}
                  />
                )}
                <div className="vault-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      setEditor(null);
                      setPreview(false);
                    }}
                  >
                    {t('Cancel')}
                  </button>
                  {preview && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setPreview(false)}
                    >
                      {t('Back to editor')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy || !config.allowWrites || !editor.path.trim()}
                    onClick={() => {
                      if (!preview) {
                        setPreview(true);
                        return;
                      }
                      void operation(async () => {
                        const saved = editor.original
                          ? await vaultApi.edit(editor.original, editor.content, config.id)
                          : await vaultApi.create(editor.path, editor.content, config.id);
                        setNote(saved);
                        setEditor(null);
                        setPreview(false);
                        setNotice('Note saved.');
                      });
                    }}
                  >
                    {t(busy ? 'Saving…' : preview ? 'Save reviewed changes' : 'Review changes')}
                  </button>
                </div>
              </section>
            )}
          </>
        )}
        {(error || configError) && (
          <p className="field-error" role="alert">
            {error || message(configError)}
          </p>
        )}
        {notice && <p role="status">{t(notice)}</p>}
      </div>
    </section>
  );
}
