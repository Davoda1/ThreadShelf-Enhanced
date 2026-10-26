import { useImportJobs } from '../import-jobs';
import { t, useI18n } from '../i18n';
import { useEffect, useCallback } from 'react';
import { Outlet, useRouter, useMatches } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useUIStore } from '../store';
import { useCollectionsQuery, useDeleteCollectionMutation } from '../queries';
import { Sidebar } from '../components/Sidebar';
import { CommandPalette } from '../components/CommandPalette';
import { NewCollectionModal } from '../components/NewCollectionModal';
import { Toaster } from '../components/Toaster';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { confirmDialog, toast } from '../toast';
import { collLabel } from '../utils';
import { ImportStatusIndicator } from '../components/ImportJobsPanel';

export function RootLayout() {
  useI18n();
  const jobs = useImportJobs();
  const router = useRouter();
  const queryClient = useQueryClient();
  const matches = useMatches();
  const isThread = matches.some((m) => m.pathname === '/thread');

  const locale = useUIStore((s) => s.locale);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const theme = useUIStore((s) => s.theme);
  const activeColl = useUIStore((s) => s.activeColl);
  const setActiveColl = useUIStore((s) => s.setActiveColl);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const cmdkOpen = useUIStore((s) => s.cmdkOpen);
  const setCmdkOpen = useUIStore((s) => s.setCmdkOpen);
  const newCollOpen = useUIStore((s) => s.newCollOpen);
  const setNewCollOpen = useUIStore((s) => s.setNewCollOpen);

  const { data: collData } = useCollectionsQuery();
  const collections = collData?.collections ?? ['all', 'chunks'];
  const stats = collData?.stats ?? {};

  const deleteMutation = useDeleteCollectionMutation();

  const closeSidebar = useCallback(() => setSidebarOpen(false), [setSidebarOpen]);
  const refreshData = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['collections'] }),
      queryClient.invalidateQueries({ queryKey: ['files'] }),
      queryClient.invalidateQueries({ queryKey: ['search'] }),
      queryClient.invalidateQueries({ queryKey: ['thread'] }),
    ]);
    toast.success(t('Local index data refreshed.'));
  }, [queryClient]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const deleteCollection = useCallback(
    async (name: string) => {
      if (jobs.data?.jobs.some((job) => job.collection === name && job.collectionLocked)) {
        toast.info(t('Collection replacement in progress. Changes are temporarily blocked.'));
        return;
      }
      if (name === 'chunks' || name === 'threadshelf_conversations') return;
      const ok = await confirmDialog({
        title: t('Delete collection "{value0}"?', { value0: collLabel(name) }),
        message:
          'The index and copies previously uploaded through ThreadShelf are deleted. Files in the original folder you selected remain untouched.',
        confirmLabel: t('Delete'),
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteMutation.mutateAsync(name);
        if (activeColl === name) {
          setActiveColl('all');
          void router.navigate({ to: '/search/$collection', params: { collection: 'all' } });
        }
        toast.success(t('Deleted collection "{value0}".', { value0: collLabel(name) }));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : t('Unknown error'));
      }
    },
    [activeColl, setActiveColl, deleteMutation, router, jobs.data],
  );

  const navigateTo = useCallback(
    (path: '/search' | '/chat' | '/insights' | '/indexing' | '/mcp' | '/settings') => {
      if (path === '/search') {
        void router.navigate({ to: '/search/$collection', params: { collection: activeColl } });
      } else if (path === '/chat') {
        void router.navigate({ to: '/chat', search: {} });
      } else {
        void router.navigate({ to: path });
      }
      closeSidebar();
    },
    [router, closeSidebar, activeColl],
  );

  const startNewChat = useCallback(() => {
    void router.navigate({
      to: '/chat',
      search: { draft: Date.now().toString(36) },
    });
    closeSidebar();
  }, [router, closeSidebar]);

  const startPrivateChat = useCallback(() => {
    void router.navigate({
      to: '/chat',
      search: { private: Date.now().toString(36) },
    });
    closeSidebar();
  }, [router, closeSidebar]);

  const openChat = useCallback(
    (thread: string) => {
      void router.navigate({ to: '/chat', search: { thread } });
      closeSidebar();
    },
    [router, closeSidebar],
  );

  const setCollAndGo = useCallback(
    (c: string) => {
      setActiveColl(c);
      void router.navigate({ to: '/search/$collection', params: { collection: c } });
      closeSidebar();
    },
    [setActiveColl, router, closeSidebar],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName.toLowerCase();
      const editing = tag === 'input' || tag === 'textarea';

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen(!cmdkOpen);
        return;
      }

      if (e.key === 'Escape') {
        if (cmdkOpen) setCmdkOpen(false);
        else if (newCollOpen) setNewCollOpen(false);
        else if (isThread) router.history.back();
        else if (sidebarOpen) closeSidebar();
        return;
      }

      if (!editing && e.key === '/') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('.search-card input')?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    cmdkOpen,
    newCollOpen,
    isThread,
    setCmdkOpen,
    setNewCollOpen,
    router,
    sidebarOpen,
    closeSidebar,
  ]);

  const currentPath = matches[matches.length - 1]?.pathname ?? '/search';
  const currentView = isThread
    ? 'search'
    : currentPath.startsWith('/search')
      ? 'search'
      : currentPath.split('/')[1] || 'search';
  const chatMatch = matches.find((match) => match.pathname === '/chat');
  const chatSearch = chatMatch?.search as { readonly thread?: unknown } | undefined;
  const activeChatId = typeof chatSearch?.thread === 'string' ? chatSearch.thread : '';

  return (
    <div className="app" data-reading={isThread} data-sidebar-open={sidebarOpen}>
      <Sidebar
        view={currentView}
        setView={navigateTo}
        activeColl={activeColl}
        setActiveColl={setCollAndGo}
        onNewChat={startNewChat}
        onNewPrivateChat={startPrivateChat}
        onOpenChat={openChat}
        activeChatId={activeChatId}
        onCmdK={() => {
          setCmdkOpen(true);
          closeSidebar();
        }}
        onNewColl={() => {
          setNewCollOpen(true);
          closeSidebar();
        }}
        onDeleteCollection={deleteCollection}
        collections={collections}
        stats={stats}
      />

      <button
        className="sidebar-scrim"
        onClick={closeSidebar}
        aria-label={t('Close sidebar')}
        tabIndex={sidebarOpen ? 0 : -1}
      />

      <div className="main">
        <ImportStatusIndicator />
        <Outlet />
      </div>

      <CommandPalette
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        setView={navigateTo}
        onNewChat={startNewChat}
        setActiveColl={setCollAndGo}
        collections={collections}
        stats={stats}
        onNewColl={() => {
          setCmdkOpen(false);
          setNewCollOpen(true);
        }}
        onRefresh={() => void refreshData()}
      />

      {newCollOpen && (
        <NewCollectionModal
          open
          onClose={() => setNewCollOpen(false)}
          onCreated={(name) => {
            setCollAndGo(name);
          }}
        />
      )}

      <ConfirmDialog />
      <Toaster />
    </div>
  );
}
