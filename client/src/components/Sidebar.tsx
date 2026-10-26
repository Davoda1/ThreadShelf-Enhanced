import { useImportJobs } from '../import-jobs';
import { useUIStore } from '../store';
import { t, useI18n, formatCount } from '../i18n';
import { useState } from 'react';
import type { CollectionStats } from '../types';
import { Icons } from '../icons';
import { useGenerationThreadsQuery } from '../queries';
import { collLabel, compactModel, fmtRelative } from '../utils';
import { ThemeToggle } from './ThemeToggle';
import { GenerationRuntimeBadge } from './GenerationRuntimeBadge';

type RoutePath = '/search' | '/chat' | '/insights' | '/indexing' | '/mcp' | '/settings';

interface NavItem {
  readonly id: RoutePath;
  readonly viewKey: string;
  readonly label: string;
  readonly icon: React.ReactNode;
}

const LIBRARY_ITEMS: readonly NavItem[] = [
  {
    id: '/search',
    viewKey: 'search',
    get label() {
      return t('Search archive');
    },
    icon: Icons.search,
  },
  {
    id: '/insights',
    viewKey: 'insights',
    get label() {
      return t('Insights');
    },
    icon: Icons.chart,
  },
];

const MANAGE_ITEMS: readonly NavItem[] = [
  {
    id: '/indexing',
    viewKey: 'indexing',
    get label() {
      return t('Add data');
    },
    icon: Icons.download,
  },
  {
    id: '/mcp',
    viewKey: 'mcp',
    get label() {
      return t('MCP');
    },
    icon: Icons.plug,
  },
  {
    id: '/settings',
    viewKey: 'settings',
    get label() {
      return t('Settings');
    },
    icon: Icons.settings,
  },
];

interface SidebarProps {
  readonly view: string;
  readonly setView: (v: RoutePath) => void;
  readonly activeColl: string;
  readonly setActiveColl: (c: string) => void;
  readonly onNewChat: () => void;
  readonly onNewPrivateChat: () => void;
  readonly onOpenChat: (id: string) => void;
  readonly activeChatId: string;
  readonly onCmdK: () => void;
  readonly onNewColl: () => void;
  readonly onDeleteCollection: (name: string) => void;
  readonly collections: readonly string[];
  readonly stats: Readonly<Record<string, CollectionStats>>;
}

export function Sidebar({
  view,
  setView,
  activeColl,
  setActiveColl,
  onNewChat,
  onNewPrivateChat,
  onOpenChat,
  activeChatId,
  onCmdK,
  onNewColl,
  onDeleteCollection,
  collections,
  stats,
}: SidebarProps) {
  useI18n();
  const jobs = useImportJobs();
  const isLocked = (collection: string) =>
    Boolean(jobs.data?.jobs.some((job) => job.collection === collection && job.collectionLocked));
  const [showEmpty, setShowEmpty] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(view === 'chat');
  const {
    data: generationThreads,
    isLoading: chatsLoading,
    refetch: refetchChats,
  } = useGenerationThreadsQuery();
  const chats = generationThreads?.threads ?? [];
  const realCollections = collections.filter((c) => c !== 'all');
  const totalFiles = realCollections.reduce((a, c) => a + (stats[c]?.files ?? 0), 0);
  const totalChunks = realCollections.reduce((a, c) => a + (stats[c]?.chunks ?? 0), 0);

  const isEmptyCollection = (c: string): boolean => {
    const s = stats[c];
    return (s?.chunks ?? 0) === 0 && (s?.files ?? 0) === 0 && (s?.conversations ?? 0) === 0;
  };
  // Keep the active collection visible even when empty so the selection never
  // vanishes from under the user.
  const emptyCollections = realCollections.filter((c) => isEmptyCollection(c) && c !== activeColl);
  const visibleCollections = realCollections.filter(
    (c) => showEmpty || !isEmptyCollection(c) || c === activeColl,
  );
  // Short by design: this line shares a ~150px sidebar row with the collection
  // name, and "conversations" spelled out wrapped it onto a second line.
  const collectionCountLabel = (s: CollectionStats | undefined): string => {
    const conversations = s?.conversations ?? 0;
    if (conversations > 0) {
      return formatCount(conversations, 'thread');
    }
    return formatCount(s?.files ?? 0, 'file');
  };

  const collectionCountTitle = (s: CollectionStats | undefined): string => {
    const conversations = s?.conversations ?? 0;
    const left =
      conversations > 0
        ? formatCount(conversations, 'conversation')
        : formatCount(s?.files ?? 0, 'file');
    return `${left} · ${formatCount(s?.chunks ?? 0, 'chunk')}`;
  };

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="sb-logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none" focusable="false">
            <circle cx="14" cy="14" r="6.5" stroke="currentColor" strokeWidth="2.4" />
            <path d="M19 19l5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            <path
              d="M14 9.5v2M14 16.5v2M9.5 14h2M16.5 14h2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="sb-name">
          <b>{t('ThreadShelf Enhanced')}</b>
          <span>
            {t('v')}
            {__APP_VERSION__}
            {t(' · local')}
          </span>
        </div>
      </div>

      <section className="sb-chat-panel" aria-label={t('Conversations')}>
        <div className="sb-chat-create">
          <button id="sidebarNewChatButton" className="sb-new-chat" onClick={onNewChat}>
            {Icons.spark}
            <span>{t('New chat')}</span>
          </button>
          <button
            id="sidebarPrivateChatButton"
            className="sb-private-chat"
            aria-label={t('Start private conversation')}
            title={t('Start a private chat that is cleared with this tab')}
            onClick={onNewPrivateChat}
          >
            {Icons.ghost}
          </button>
        </div>

        <div className="sb-chat-history">
          <button
            id="sidebarChatHistoryToggle"
            className="sb-chat-history-toggle"
            aria-expanded={chatsOpen}
            onClick={() => {
              const nextOpen = !chatsOpen;
              setChatsOpen(nextOpen);
              if (nextOpen) void refetchChats();
            }}
          >
            <span className="ico">{Icons.chat}</span>
            <span className="label">{t('Your chats')}</span>
            {chats.length > 0 && <em>{chats.length}</em>}
            <span className="sb-chat-chevron" aria-hidden="true">
              ▾
            </span>
          </button>
          {chatsOpen && (
            <div className="sb-chat-history-list">
              {chatsLoading && <span className="sb-chat-history-empty">{t('Loading chats…')}</span>}
              {!chatsLoading && chats.length === 0 && (
                <span className="sb-chat-history-empty">{t('No saved chats yet.')}</span>
              )}
              {chats.map((thread) => (
                <button
                  key={thread.id}
                  className="sb-chat-item"
                  data-active={thread.id === activeChatId}
                  title={thread.title}
                  onClick={() => onOpenChat(thread.id)}
                >
                  <strong>{thread.title}</strong>
                  <span
                    title={t('{value0}{value1} messages', {
                      value0: thread.model ? `${compactModel(thread.model)} · ` : '',
                      value1: thread.turnCount,
                    })}
                  >
                    {fmtRelative(thread.updatedAt) || t('just now')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <button className="sb-cmdk" onClick={onCmdK}>
        {Icons.search}
        <span>{t('Quick jump…')}</span>
        <kbd>Ctrl+K</kbd>
      </button>

      <div className="sb-section">
        <span>{t('Library')}</span>
      </div>

      <nav className="sb-list" style={{ flex: '0 0 auto' }}>
        {LIBRARY_ITEMS.map((n) => (
          <button
            key={n.id}
            id={n.viewKey === 'indexing' ? 'indexingNavBtn' : undefined}
            className="sb-item"
            data-active={view === n.viewKey}
            onClick={() => setView(n.id)}
          >
            <span className="ico">{n.icon}</span>
            <span className="label">{n.label}</span>
          </button>
        ))}
      </nav>

      <div className="sb-section">
        <span>{t('Archive collections')}</span>
        <button title={t('New collection')} onClick={onNewColl}>
          {Icons.plus}
        </button>
      </div>

      <div className="sb-list sb-collections">
        <button
          id="collection-all"
          className="sb-coll"
          data-active={activeColl === 'all'}
          onClick={() => setActiveColl('all')}
        >
          <span className="sb-coll-dot" style={{ background: 'var(--accent)' }} />
          <span className="sb-coll-meta">
            <b>{t('All collections')}</b>
            <span>
              {totalFiles}
              {t(' files · ')}
              {totalChunks.toLocaleString(useUIStore.getState().locale)}
              {t(' chunks')}
            </span>
          </span>
        </button>

        {visibleCollections.map((c) => {
          const s = stats[c];
          return (
            <div key={c} className="sb-coll-row">
              <button
                id={`collection-${c}`}
                className="sb-coll"
                data-active={activeColl === c}
                onClick={() => setActiveColl(c)}
              >
                <span className="sb-coll-dot" />
                <span className="sb-coll-meta">
                  <b>{collLabel(c)}</b>
                  <span title={collectionCountTitle(s)}>
                    {collectionCountLabel(s)} ·{' '}
                    {(s?.chunks ?? 0).toLocaleString(useUIStore.getState().locale)}
                    {t(' chunks')}
                  </span>
                </span>
              </button>
              {c !== 'chunks' && c !== 'threadshelf_conversations' && (
                <button
                  id={`delete-collection-${c}`}
                  className="sb-coll-delete"
                  disabled={isLocked(c)}
                  title={
                    isLocked(c)
                      ? t('Collection replacement in progress. Changes are temporarily blocked.')
                      : t('Delete {value0}', { value0: collLabel(c) })
                  }
                  aria-label={t('Delete {value0}', { value0: collLabel(c) })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteCollection(c);
                  }}
                >
                  {Icons.trash}
                </button>
              )}
            </div>
          );
        })}

        {emptyCollections.length > 0 && (
          <button
            id="toggleEmptyCollections"
            className="sb-coll-empty-toggle"
            onClick={() => setShowEmpty((value) => !value)}
          >
            {showEmpty
              ? t('Hide empty collections')
              : t('Show {value0} empty', { value0: emptyCollections.length })}
          </button>
        )}
      </div>

      <div className="sb-section sb-manage-section">
        <span>{t('Manage')}</span>
      </div>
      <nav className="sb-list sb-manage-list">
        {MANAGE_ITEMS.map((n) => (
          <button
            key={n.id}
            id={n.viewKey === 'indexing' ? 'indexingNavBtn' : undefined}
            className="sb-item"
            data-active={view === n.viewKey}
            onClick={() => setView(n.id)}
          >
            <span className="ico">{n.icon}</span>
            <span className="label">{n.label}</span>
          </button>
        ))}
      </nav>

      <div className="sb-footer">
        <GenerationRuntimeBadge />
        <div className="sb-footer-row">
          <span
            className="sb-status"
            title={t(
              'Local backend · paraphrase-multilingual embeddings · LanceDB storage. Model runtime and eject live in the chat model menu.',
            )}
          >
            {t('local · :')}
            {window.location.port || '80'}
          </span>
          <ThemeToggle variant="icon" />
        </div>
      </div>
    </aside>
  );
}
