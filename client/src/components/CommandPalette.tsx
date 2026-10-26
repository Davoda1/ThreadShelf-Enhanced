import { t, useI18n } from '../i18n';
import { useState, useEffect, useRef } from 'react';
import type { CollectionStats } from '../types';
import { Icons } from '../icons';
import { collLabel } from '../utils';

type RoutePath = '/search' | '/chat' | '/insights' | '/indexing' | '/mcp' | '/settings';

interface PaletteItem {
  readonly id: string;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly meta?: string;
  readonly action: () => void;
}

interface PaletteGroup {
  readonly label: string;
  readonly items: PaletteItem[];
}

interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly setView: (v: RoutePath) => void;
  readonly onNewChat: () => void;
  readonly setActiveColl: (c: string) => void;
  readonly collections: readonly string[];
  readonly stats: Readonly<Record<string, CollectionStats>>;
  readonly onNewColl: () => void;
  readonly onRefresh: () => void;
}

export function CommandPalette({
  open,
  onClose,
  setView,
  onNewChat,
  setActiveColl,
  collections,
  stats,
  onNewColl,
  onRefresh,
}: CommandPaletteProps) {
  useI18n();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => {
        setQuery('');
        setActiveIdx(0);
        inputRef.current?.focus();
      }, 30);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  if (!open) return null;

  const groups: PaletteGroup[] = [
    {
      label: t('Go to'),
      items: [
        {
          id: 'go-search',
          label: t('Search archive'),
          icon: Icons.search,
          action: () => setView('/search'),
        },
        {
          id: 'go-chat',
          label: t('Chat history'),
          icon: Icons.chat,
          action: () => setView('/chat'),
        },
        {
          id: 'go-insights',
          label: t('Insights'),
          icon: Icons.chart,
          action: () => setView('/insights'),
        },
        {
          id: 'go-indexing',
          label: t('Indexing'),
          icon: Icons.download,
          action: () => setView('/indexing'),
        },
        { id: 'go-mcp', label: t('MCP'), icon: Icons.plug, action: () => setView('/mcp') },
        {
          id: 'go-settings',
          label: t('Settings'),
          icon: Icons.settings,
          action: () => setView('/settings'),
        },
      ],
    },
    {
      label: t('Collections'),
      items: [
        {
          id: 'coll-all',
          label: t('All collections'),
          icon: Icons.scope,
          action: () => setActiveColl('all'),
        },
        ...collections
          .filter((c) => c !== 'all')
          .map((c) => ({
            id: `coll-${c}`,
            label: collLabel(c),
            icon: Icons.database,
            meta: `${stats[c]?.files ?? 0} files`,
            action: () => setActiveColl(c),
          })),
      ],
    },
    {
      label: t('Actions'),
      items: [
        { id: 'a-chat', label: t('New chat'), icon: Icons.spark, action: onNewChat },
        { id: 'a-new', label: t('New collection…'), icon: Icons.plus, action: onNewColl },
        {
          id: 'a-index',
          label: t('Index a folder'),
          icon: Icons.folder,
          action: () => setView('/indexing'),
        },
        { id: 'a-refresh', label: t('Refresh stats'), icon: Icons.refresh, action: onRefresh },
      ],
    },
  ];

  const filtered = groups
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => !query || it.label.toLowerCase().includes(query.toLowerCase())),
    }))
    .filter((g) => g.items.length > 0);

  const allItems = filtered.flatMap((g) => g.items);
  const clamped = Math.min(activeIdx, allItems.length - 1);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % Math.max(1, allItems.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + allItems.length) % Math.max(1, allItems.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      allItems[clamped]?.action();
      onClose();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  let flatIndex = 0;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          {Icons.searchLg}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('Search commands, collections, or actions…')}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="cmdk-list">
          {filtered.map((g) => (
            <div key={g.label}>
              <div className="cmdk-group-h">{g.label}</div>
              {g.items.map((it) => {
                const idx = flatIndex++;
                return (
                  <button
                    key={it.id}
                    className="cmdk-item"
                    data-active={idx === clamped}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => {
                      it.action();
                      onClose();
                    }}
                  >
                    <span className="ico">{it.icon}</span>
                    <span>{it.label}</span>
                    {it.meta && <span className="meta">{it.meta}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {allItems.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
              {t('No matches')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
