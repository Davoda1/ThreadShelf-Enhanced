import { t, useI18n } from '../i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useUIStore, savedSearchSignature, pinKey } from '../store';
import { useHealthQuery, useSearchQuery, useFilesQuery } from '../queries';
import { Icons } from '../icons';
import { collLabel, shortPath, fmtDateShort, moreLikeThisQuery } from '../utils';
import { Empty } from '../components/Empty';
import { ResultCard } from '../components/ResultCard';
import { Topbar } from '../components/Topbar';
import { getProvider } from '../constants';
import type {
  SearchResult,
  ConversationListItem,
  ConversationSort,
  PinnedConversation,
  RoleFilters,
  SavedSearch,
  SearchMode,
} from '../types';

const CONV_PAGE_SIZE = 100;
type OriginFilter = 'all' | 'threadshelf' | 'archive';

const conversationComparator = (
  sort: ConversationSort,
): ((a: ConversationListItem, b: ConversationListItem) => number) => {
  switch (sort) {
    case 'recent':
      // Newest first; conversations without any timestamp sink to the bottom.
      return (a, b) => (b.lastTurnAt ?? '').localeCompare(a.lastTurnAt ?? '');
    case 'longest':
      return (a, b) => (b.turnCount ?? 0) - (a.turnCount ?? 0);
    case 'title':
      return (a, b) =>
        (a.title || a.sourceFile).localeCompare(b.title || b.sourceFile, undefined, {
          sensitivity: 'base',
        });
  }
};

interface RoleChipDef {
  readonly id: string;
  readonly label: string;
  readonly key: keyof RoleFilters;
}

const ROLE_CHIPS: readonly RoleChipDef[] = [
  {
    id: 'user',
    get label() {
      return t('User');
    },
    key: 'user',
  },
  {
    id: 'reasoning',
    get label() {
      return t('Reasoning');
    },
    key: 'thinking',
  },
  {
    id: 'response',
    get label() {
      return t('Response');
    },
    key: 'ai',
  },
];

function SearchLoading() {
  useI18n();
  return (
    <div className="result-list" style={{ marginTop: 16 }}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="shimmer-card" />
      ))}
    </div>
  );
}

export function SearchPage() {
  useI18n();
  const navigate = useNavigate();
  const { collection: routeCollection } = useParams({ from: '/search/$collection' });
  const {
    q: urlQuery,
    model: urlModel,
    from: urlFrom,
    to: urlTo,
    mode: urlMode,
  } = useSearch({
    from: '/search/$collection',
  });

  // The collection lives in the URL (/search/<collection>) so it is shareable and
  // never silently lost. Keep the store in sync so the sidebar highlight, topbar,
  // and other views agree with the route.
  const activeColl = routeCollection ? decodeURIComponent(routeCollection) : 'all';
  const setActiveColl = useUIStore((s) => s.setActiveColl);
  useEffect(() => {
    setActiveColl(activeColl);
  }, [activeColl, setActiveColl]);

  const roles = useUIStore((s) => s.roles);
  const toggleRole = useUIStore((s) => s.toggleRole);
  const modelFilter = useUIStore((s) => s.modelFilter);
  const setModelFilter = useUIStore((s) => s.setModelFilter);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const savedSearches = useUIStore((s) => s.savedSearches);
  const addSavedSearch = useUIStore((s) => s.addSavedSearch);
  const removeSavedSearch = useUIStore((s) => s.removeSavedSearch);
  const pinnedConversations = useUIStore((s) => s.pinnedConversations);
  const togglePinned = useUIStore((s) => s.togglePinned);

  const [inputValue, setInputValue] = useState(urlQuery ?? '');
  const [submittedQuery, setSubmittedQuery] = useState(urlQuery ?? '');
  const [dateFrom, setDateFrom] = useState(urlFrom ?? '');
  const [dateTo, setDateTo] = useState(urlTo ?? '');
  const [searchMode, setSearchMode] = useState<SearchMode>(
    urlMode === 'keyword' ? 'keyword' : 'semantic',
  );
  const [resultLimit, setResultLimit] = useState(15);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [convFilter, setConvFilter] = useState('');
  const [convSort, setConvSort] = useState<ConversationSort>('recent');
  const [convLimit, setConvLimit] = useState(CONV_PAGE_SIZE);
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');
  const lastAppliedUrlQuery = useRef(urlQuery ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { data: healthData } = useHealthQuery();
  const serverOk = healthData ?? true;

  const activeRoles = useMemo(() => {
    const r: string[] = [];
    if (roles.user) r.push('user');
    if (roles.thinking) r.push('thinking');
    if (roles.ai) r.push('ai');
    return r.length > 0 && r.length < 3 ? r.join(',') : undefined;
  }, [roles]);

  const searchParams = useMemo(
    () => ({
      q: submittedQuery.trim(),
      collection: activeColl,
      n: resultLimit,
      roles: activeRoles,
      keywordBoost: searchMode === 'semantic' && submittedQuery.trim().length <= 40,
      model: (urlModel ?? modelFilter).trim() || undefined,
      from: dateFrom.trim() || undefined,
      to: dateTo.trim() || undefined,
      mode: searchMode,
      origin: originFilter === 'all' ? undefined : originFilter,
    }),
    [
      submittedQuery,
      activeColl,
      resultLimit,
      activeRoles,
      urlModel,
      modelFilter,
      dateFrom,
      dateTo,
      searchMode,
      originFilter,
    ],
  );

  const { data: searchData, isFetching: isSearching } = useSearchQuery(searchParams);

  const showConversations = !submittedQuery.trim() && serverOk;
  const { data: filesData, isLoading: convLoading } = useFilesQuery(activeColl, showConversations);

  const conversations = useMemo(() => {
    const all = filesData?.files ?? [];
    const needle = convFilter.trim().toLowerCase();
    const byText = needle
      ? all.filter((item) =>
          [item.title, item.sourceFile, item.conversationKey, item.collection].some((field) =>
            (field ?? '').toLowerCase().includes(needle),
          ),
        )
      : all;
    const filtered = byText.filter((item) => {
      if (originFilter === 'threadshelf') {
        return item.createdInThreadShelf === true || item.hasThreadShelfTurns === true;
      }
      if (originFilter === 'archive') return item.hasThreadShelfTurns !== true;
      return true;
    });
    return [...filtered].sort(conversationComparator(convSort));
  }, [filesData?.files, convFilter, convSort, originFilter]);

  const visibleConversations = useMemo(
    () => conversations.slice(0, convLimit),
    [conversations, convLimit],
  );

  // New collection, filter, or sort → back to the first page.
  useEffect(() => {
    const id = window.setTimeout(() => setConvLimit(CONV_PAGE_SIZE), 0);
    return () => window.clearTimeout(id);
  }, [activeColl, convFilter, convSort, originFilter]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const nextUrlQuery = urlQuery ?? '';
    if (nextUrlQuery !== lastAppliedUrlQuery.current) {
      const id = window.setTimeout(() => {
        lastAppliedUrlQuery.current = nextUrlQuery;
        setInputValue(nextUrlQuery);
        setSubmittedQuery(nextUrlQuery);
        setDateFrom(urlFrom ?? '');
        setDateTo(urlTo ?? '');
        setSearchMode(urlMode === 'keyword' ? 'keyword' : 'semantic');
      }, 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [urlQuery, urlFrom, urlTo, urlMode]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDateFrom(urlFrom ?? '');
      setDateTo(urlTo ?? '');
    }, 0);
    return () => window.clearTimeout(id);
  }, [urlFrom, urlTo]);

  useEffect(() => {
    const id = window.setTimeout(() => setResultLimit(15), 0);
    return () => window.clearTimeout(id);
  }, [
    submittedQuery,
    activeColl,
    activeRoles,
    urlModel,
    modelFilter,
    dateFrom,
    dateTo,
    searchMode,
    originFilter,
  ]);

  const runSearch = useCallback(
    (modeOverride?: SearchMode) => {
      const q = inputValue.trim();
      const mode = modeOverride ?? searchMode;
      lastAppliedUrlQuery.current = q;
      setSubmittedQuery(q);
      void navigate({
        to: '/search/$collection',
        params: { collection: activeColl },
        search: q
          ? {
              q,
              model: modelFilter.trim() || undefined,
              from: dateFrom.trim() || undefined,
              to: dateTo.trim() || undefined,
              mode: mode === 'keyword' ? 'keyword' : undefined,
            }
          : {},
        replace: true,
      });
    },
    [inputValue, modelFilter, dateFrom, dateTo, navigate, activeColl, searchMode],
  );

  // Emptying the box should take you back to the conversation list, not leave
  // stale results on screen until you also press Enter.
  const clearSearch = useCallback(() => {
    lastAppliedUrlQuery.current = '';
    setInputValue('');
    setSubmittedQuery('');
    inputRef.current?.focus();
    void navigate({
      to: '/search/$collection',
      params: { collection: activeColl },
      search: {},
      replace: true,
    });
  }, [navigate, activeColl]);

  const switchMode = useCallback(
    (mode: SearchMode) => {
      setSearchMode(mode);
      runSearch(mode);
    },
    [runSearch],
  );

  const openResult = useCallback(
    (r: SearchResult) => {
      void navigate({
        to: '/thread',
        search: {
          sourceFile: r.metadata.sourceFile,
          collection: r.metadata.collection ?? activeColl,
          conversationKey: r.metadata.conversationKey,
          q: submittedQuery.trim() || undefined,
          title: r.metadata.title,
          matchIdx: r.metadata.turnIndex,
          provider: r.metadata.provider,
          model: r.metadata.model,
        },
      });
    },
    [activeColl, submittedQuery, navigate],
  );

  // "More like this": re-run a semantic search seeded with the result's text.
  // Pushed (not replaced) so Back returns to the original results.
  const searchSimilar = useCallback(
    (r: SearchResult) => {
      const q = moreLikeThisQuery(r.document);
      if (!q) return;
      setSearchMode('semantic');
      lastAppliedUrlQuery.current = q;
      setInputValue(q);
      setSubmittedQuery(q);
      void navigate({
        to: '/search/$collection',
        params: { collection: activeColl },
        search: {
          q,
          model: modelFilter.trim() || undefined,
          from: dateFrom.trim() || undefined,
          to: dateTo.trim() || undefined,
        },
      });
    },
    [activeColl, modelFilter, dateFrom, dateTo, navigate],
  );

  const openConversation = useCallback(
    (item: ConversationListItem) => {
      void navigate({
        to: '/thread',
        search: {
          sourceFile: item.sourceFile,
          collection: item.collection,
          conversationKey: item.conversationKey,
          title: item.title,
        },
      });
    },
    [navigate],
  );

  const hasQuery = submittedQuery.trim().length > 0;

  // --- Saved searches ---
  const currentSearchSpec = useMemo(
    () => ({
      q: submittedQuery.trim(),
      collection: activeColl,
      mode: searchMode,
      model: (urlModel ?? modelFilter).trim() || undefined,
      from: dateFrom.trim() || undefined,
      to: dateTo.trim() || undefined,
    }),
    [submittedQuery, activeColl, searchMode, urlModel, modelFilter, dateFrom, dateTo],
  );

  const existingSaved = useMemo(() => {
    const signature = savedSearchSignature(currentSearchSpec);
    return savedSearches.find((s) => savedSearchSignature(s) === signature);
  }, [savedSearches, currentSearchSpec]);

  const toggleSaveSearch = useCallback(() => {
    if (existingSaved) removeSavedSearch(existingSaved.id);
    else addSavedSearch(currentSearchSpec);
  }, [existingSaved, removeSavedSearch, addSavedSearch, currentSearchSpec]);

  const runSavedSearch = useCallback(
    (s: SavedSearch) => {
      setSearchMode(s.mode);
      lastAppliedUrlQuery.current = s.q;
      setInputValue(s.q);
      setSubmittedQuery(s.q);
      void navigate({
        to: '/search/$collection',
        params: { collection: s.collection },
        search: {
          q: s.q,
          model: s.model,
          from: s.from,
          to: s.to,
          mode: s.mode === 'keyword' ? 'keyword' : undefined,
        },
      });
    },
    [navigate],
  );

  // --- Pinned conversations ---
  const pinnedForScope = useMemo(
    () =>
      activeColl === 'all'
        ? pinnedConversations
        : pinnedConversations.filter((p) => p.collection === activeColl),
    [pinnedConversations, activeColl],
  );

  const pinnedKeys = useMemo(
    () => new Set(pinnedConversations.map((p) => pinKey(p))),
    [pinnedConversations],
  );

  const pinFor = (item: ConversationListItem): PinnedConversation => ({
    collection: item.collection,
    sourceFile: item.sourceFile,
    conversationKey: item.conversationKey,
    title: item.title,
    provider: item.provider,
  });
  const results = useMemo(() => searchData?.results ?? [], [searchData?.results]);
  const canLoadMore = hasQuery && !isSearching && results.length >= resultLimit && resultLimit < 50;
  const conversationLabel =
    activeColl === 'all'
      ? t('Conversations')
      : t('{collection} conversations', { collection: collLabel(activeColl) });

  // Keyboard navigation over the visible list (search results or conversations).
  const navCount = hasQuery ? results.length : visibleConversations.length;

  const openByIndex = useCallback(
    (i: number) => {
      if (hasQuery) {
        const r = results[i];
        if (r) openResult(r);
      } else {
        const c = visibleConversations[i];
        if (c) openConversation(c);
      }
    },
    [hasQuery, results, visibleConversations, openResult, openConversation],
  );

  useEffect(() => {
    const id = window.setTimeout(() => setSelectedIdx(-1), 0);
    return () => window.clearTimeout(id);
  }, [submittedQuery, activeColl, hasQuery]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName?.toLowerCase();
      const inSearchInput = target === inputRef.current;
      const editing = (tag === 'input' || tag === 'textarea') && !inSearchInput;
      if (editing || navCount === 0) return;

      const down = e.key === 'ArrowDown' || (e.key === 'j' && !inSearchInput);
      const up = e.key === 'ArrowUp' || (e.key === 'k' && !inSearchInput);

      if (down) {
        e.preventDefault();
        if (inSearchInput) inputRef.current?.blur();
        setSelectedIdx((i) => Math.min(navCount - 1, i + 1));
      } else if (up) {
        e.preventDefault();
        setSelectedIdx((i) => (i <= 0 ? 0 : i - 1));
      } else if (e.key === 'Enter' && !inSearchInput && selectedIdx >= 0) {
        e.preventDefault();
        openByIndex(selectedIdx);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navCount, selectedIdx, openByIndex]);

  useEffect(() => {
    if (selectedIdx < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  return (
    <>
      <Topbar view="search" activeColl={activeColl} onMenu={() => setSidebarOpen(true)} />
      <div className="main-scroll">
        <div className="view">
          {!serverOk && (
            <div className="banner err">
              <span className="ico">{Icons.warn}</span>
              <div className="grow">
                <b style={{ fontWeight: 500 }}>{t('Backend unreachable.')}</b>{' '}
                <span style={{ color: 'var(--text-2)' }}>
                  {t('Run ')}
                  <code>npm start</code>
                  {t(' in the project root.')}
                </span>
              </div>
            </div>
          )}

          <div className="search-card">
            <span className="search-ico">{Icons.searchLg}</span>
            <input
              id="searchInput"
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch();
                else if (e.key === 'Escape' && inputValue) {
                  // Handled here so the global Escape binding never sees it.
                  e.preventDefault();
                  e.stopPropagation();
                  clearSearch();
                }
              }}
              placeholder={
                searchMode === 'keyword'
                  ? t('Exact match: identifiers, error strings, code…')
                  : t('Search by meaning across your archive…')
              }
            />
            {inputValue && (
              <button
                id="clearSearch"
                type="button"
                className="search-clear"
                aria-label={t('Clear search')}
                title={t('Clear search (Esc)')}
                onClick={clearSearch}
              >
                {Icons.close}
              </button>
            )}
          </div>

          <div className="search-toolbar">
            <div className="mode-toggle" role="group" aria-label={t('Search mode')}>
              <button
                type="button"
                className="mode-btn"
                data-on={searchMode === 'semantic'}
                title={t('Rank by meaning (local embeddings)')}
                onClick={() => switchMode('semantic')}
              >
                {t('Semantic')}
              </button>
              <button
                type="button"
                className="mode-btn"
                data-on={searchMode === 'keyword'}
                title={t('Exact substring match (case-insensitive)')}
                onClick={() => switchMode('keyword')}
              >
                {t('Exact')}
              </button>
            </div>
            <div className="role-chips">
              {ROLE_CHIPS.map((r) => (
                <button
                  key={r.id}
                  className="role-chip"
                  data-role={r.id}
                  data-on={roles[r.key]}
                  onClick={() => toggleRole(r.key)}
                >
                  <span className="dot" />
                  {r.label}
                </button>
              ))}
            </div>
            <label className="origin-filter">
              <span>{t('origin')}</span>
              <select
                aria-label={t('Filter by conversation origin')}
                value={originFilter}
                onChange={(event) => setOriginFilter(event.target.value as OriginFilter)}
              >
                <option value="all">{t('All')}</option>
                <option value="threadshelf">{t('ThreadShelf')}</option>
                <option value="archive">{t('Clean archive')}</option>
              </select>
            </label>
            <label className="model-filter">
              <span>{t('model')}</span>
              <input
                value={modelFilter}
                onChange={(e) => setModelFilter(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                placeholder={t('gpt-5, claude, gemini...')}
              />
            </label>
            <label className="date-filter">
              <span>{t('from')}</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              />
            </label>
            <label className="date-filter">
              <span>{t('to')}</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              />
            </label>
            <span className="toolbar-spacer" />
            <span className="toolbar-hint">
              <kbd>/</kbd>
              {t(' focus · ')}
              <kbd>↑↓</kbd>
              {t(' navigate · ')}
              <kbd>↵</kbd>
              {t(' open · ')}
              <kbd>Ctrl+K</kbd> {t('commands')}
            </span>
          </div>

          {!hasQuery && (
            <>
              {activeColl === 'all' && (
                <Empty
                  onPick={(q) => {
                    lastAppliedUrlQuery.current = q;
                    setInputValue(q);
                    setSubmittedQuery(q);
                    void navigate({
                      to: '/search/$collection',
                      params: { collection: activeColl },
                      search: { q },
                      replace: true,
                    });
                  }}
                />
              )}

              {savedSearches.length > 0 && (
                <div className="saved-searches">
                  <span className="ss-label">
                    {Icons.star}
                    {t(' Saved')}
                  </span>
                  {savedSearches.map((s) => (
                    <span key={s.id} className="ss-chip">
                      <button
                        type="button"
                        className="ss-run"
                        title={t('Run: {value0}', { value0: s.q })}
                        onClick={() => runSavedSearch(s)}
                      >
                        <span className="ss-q">{s.q}</span>
                        {s.collection !== 'all' && (
                          <span className="ss-tag">{collLabel(s.collection)}</span>
                        )}
                        {s.mode === 'keyword' && <span className="ss-tag">{t('exact')}</span>}
                      </button>
                      <button
                        type="button"
                        className="ss-del"
                        aria-label={t('Delete saved search "{value0}"', { value0: s.q })}
                        onClick={() => removeSavedSearch(s.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {pinnedForScope.length > 0 && (
                <>
                  <div className="results-meta-bar">
                    <span className="h">
                      {t('Pinned ')}
                      <b>{pinnedForScope.length}</b>
                    </span>
                  </div>
                  <div className="result-list">
                    {pinnedForScope.map((p) => {
                      const provider = p.provider ? getProvider(p.provider) : null;
                      const fileName = shortPath(p.sourceFile);
                      return (
                        <button
                          key={pinKey(p)}
                          className="result"
                          onClick={() => openConversation(p as ConversationListItem)}
                        >
                          <div className="result-head">
                            <span className="r-role" data-role="user">
                              {t('pinned')}
                            </span>
                            <span className="r-provider">
                              <span
                                className="pdot"
                                style={{ background: provider?.color ?? 'var(--accent)' }}
                              />
                              <span>{provider?.short ?? collLabel(p.collection)}</span>
                            </span>
                            <span
                              className="pin-toggle"
                              role="button"
                              tabIndex={0}
                              data-on="true"
                              title={t('Unpin')}
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePinned(p);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  togglePinned(p);
                                }
                              }}
                            >
                              {Icons.pinFilled}
                            </span>
                          </div>
                          <div className="r-title" title={p.title || fileName}>
                            {p.title || fileName}
                          </div>
                          <div className="r-foot">
                            <span className="r-source" title={p.sourceFile}>
                              {Icons.folder}
                              <span className="r-source-coll">{collLabel(p.collection)}</span>
                              <span className="slash">/</span>
                              <span className="r-source-file">{fileName}</span>
                            </span>
                            <span className="open-thread">
                              {t('open thread ')}
                              {Icons.arrowRight}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              <div className="results-meta-bar">
                <span className="h">
                  {conversationLabel} <b>{conversations.length}</b>
                </span>
                <label className="conv-sort">
                  <span>{t('sort')}</span>
                  <select
                    value={convSort}
                    onChange={(e) => setConvSort(e.target.value as ConversationSort)}
                    aria-label={t('Sort conversations')}
                  >
                    <option value="recent">{t('Recent')}</option>
                    <option value="longest">{t('Longest')}</option>
                    <option value="title">{t('Title')}</option>
                  </select>
                </label>
                <input
                  className="conv-filter"
                  value={convFilter}
                  onChange={(e) => setConvFilter(e.target.value)}
                  placeholder={t('Filter by title or file…')}
                  aria-label={t('Filter conversations')}
                />
              </div>

              {convLoading ? (
                <SearchLoading />
              ) : conversations.length > 0 ? (
                <div className="result-list" ref={listRef}>
                  {visibleConversations.map((item, i) => {
                    const fileName = shortPath(item.sourceFile);
                    const title = item.title || fileName;
                    const provider = item.provider ? getProvider(item.provider) : null;
                    const lastActive = fmtDateShort(item.lastTurnAt);
                    const pin = pinFor(item);
                    const isPinned = pinnedKeys.has(pinKey(pin));
                    return (
                      <button
                        key={`${item.collection}:${item.sourceFile}:${i}`}
                        className="result"
                        data-selected={i === selectedIdx}
                        aria-selected={i === selectedIdx}
                        onClick={() => openConversation(item)}
                      >
                        <div className="result-head">
                          <span className="r-role" data-role="ai">
                            {t('thread')}
                          </span>
                          {item.hasThreadShelfTurns && (
                            <span className="threadshelf-turn-badge">
                              {item.createdInThreadShelf
                                ? t('Created in ThreadShelf')
                                : t('Continued in ThreadShelf')}
                            </span>
                          )}
                          <span className="r-provider">
                            <span
                              className="pdot"
                              style={{ background: provider?.color ?? 'var(--accent)' }}
                            />
                            <span>{provider?.short ?? collLabel(item.collection)}</span>
                          </span>
                          <span
                            className="pin-toggle"
                            role="button"
                            tabIndex={0}
                            data-on={isPinned}
                            title={isPinned ? t('Unpin') : t('Pin conversation')}
                            onClick={(e) => {
                              e.stopPropagation();
                              togglePinned(pin);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                togglePinned(pin);
                              }
                            }}
                          >
                            {isPinned ? Icons.pinFilled : Icons.pin}
                          </span>
                        </div>
                        <div className="r-title" title={title}>
                          {title}
                        </div>
                        <div className="r-foot">
                          <span className="r-source" title={item.sourceFile}>
                            {Icons.folder}
                            <span className="r-source-coll">{collLabel(item.collection)}</span>
                            <span className="slash">/</span>
                            <span className="r-source-file">{fileName}</span>
                          </span>
                          {item.turnCount != null && (
                            <>
                              <span className="dot" />
                              <span>
                                {item.turnCount}
                                {t(' turns')}
                              </span>
                            </>
                          )}
                          {lastActive && (
                            <>
                              <span className="dot" />
                              <span>{lastActive}</span>
                            </>
                          )}
                          <span className="open-thread">
                            {t('open thread ')}
                            {Icons.arrowRight}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                  {conversations.length > convLimit && (
                    <div className="load-more-row">
                      <button
                        type="button"
                        className="load-more-button"
                        onClick={() => setConvLimit((value) => value + CONV_PAGE_SIZE)}
                      >
                        {t('Show more (')}
                        {conversations.length - convLimit}
                        {t(' left)')}
                      </button>
                    </div>
                  )}
                </div>
              ) : convFilter.trim() ? (
                <div className="empty">
                  <h3>{t('No conversations match the filter.')}</h3>
                  <p>{t('Try a different phrase or clear the filter box.')}</p>
                </div>
              ) : activeColl !== 'all' ? (
                <div className="empty">
                  <h3>{t('No conversations indexed.')}</h3>
                  <p>{t('Index a folder into this collection or switch to another collection.')}</p>
                </div>
              ) : null}
            </>
          )}

          {hasQuery && isSearching && <SearchLoading />}

          {hasQuery && !isSearching && results.length === 0 && (
            <div className="empty">
              <h3>{t('No results found.')}</h3>
              <p>{t('Try another query, broaden your role filters, or index more files.')}</p>
            </div>
          )}

          {hasQuery && !isSearching && results.length > 0 && (
            <>
              <div className="results-meta-bar">
                <span className="h">
                  {t('Results ')}
                  <b>{results.length}</b>
                  <span style={{ marginLeft: 14, color: 'var(--text-3)' }}>
                    {t('in ')}
                    {collLabel(activeColl)}
                  </span>
                </span>
                <button
                  type="button"
                  className="save-search"
                  data-on={!!existingSaved}
                  title={existingSaved ? t('Remove from saved searches') : t('Save this search')}
                  onClick={toggleSaveSearch}
                >
                  {existingSaved ? Icons.starFilled : Icons.star}
                  <span>{existingSaved ? t('Saved') : t('Save search')}</span>
                </button>
              </div>
              <div className="result-list" ref={listRef}>
                {results.map((r, i) => (
                  <ResultCard
                    key={i}
                    result={r}
                    query={submittedQuery}
                    selected={i === selectedIdx}
                    onClick={() => openResult(r)}
                    onMoreLikeThis={() => searchSimilar(r)}
                  />
                ))}
              </div>
              {canLoadMore && (
                <div className="load-more-row">
                  <button
                    type="button"
                    className="load-more-button"
                    onClick={() => setResultLimit((value) => Math.min(value + 15, 50))}
                  >
                    {t('Load more')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
