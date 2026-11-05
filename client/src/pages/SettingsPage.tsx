import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useUIStore } from '../store';
import { useCollectionsQuery } from '../queries';
import { useI18n } from '../i18n';
import { Topbar } from '../components/Topbar';
import { SettingsView } from '../components/SettingsView';
import { ImageCacheSettings } from '../components/ImageCacheSettings';
import { AppearanceSettings } from '../components/AppearanceSettings';
import { ConversationDisplaySettings } from '../components/ConversationDisplaySettings';
import { GenerationSettings } from '../components/GenerationSettings';
import { ObsidianPanel } from '../components/ObsidianPanel';
import { TtsSettings } from '../tts/TtsSettings';

const SETTINGS_TABS = [
  { id: 'ai', label: 'AI Models' },
  { id: 'server', label: 'Server' },
  { id: 'tts', label: 'Text-to-Speech' },
] as const;

export function SettingsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const tab = useUIStore((state) => state.settingsTab);
  const setTab = useUIStore((state) => state.setSettingsTab);
  const activeColl = useUIStore((s) => s.activeColl);
  const setActiveColl = useUIStore((s) => s.setActiveColl);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const { data } = useCollectionsQuery();
  const stats = data?.stats ?? {};

  const onRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['collections'] });
    await queryClient.invalidateQueries({ queryKey: ['files'] });
  }, [queryClient]);

  const onDeleted = useCallback(() => {
    setActiveColl('all');
    void navigate({ to: '/search/$collection', params: { collection: 'all' } });
  }, [navigate, setActiveColl]);

  return (
    <>
      <Topbar view="settings" activeColl={activeColl} onMenu={() => setSidebarOpen(true)} />
      <div className="main-scroll settings-page" data-settings-tab={tab}>
        <div className="view settings-stack">
          <div className="settings-tabs" role="tablist" aria-label={t('Settings sections')}>
            {SETTINGS_TABS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                id={`settings-tab-${item.id}`}
                role="tab"
                aria-selected={tab === item.id}
                aria-controls="settings-content"
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => {
                  const next =
                    event.key === 'ArrowRight'
                      ? (index + 1) % 3
                      : event.key === 'ArrowLeft'
                        ? (index + 2) % 3
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? 2
                            : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  setTab(SETTINGS_TABS[next]!.id);
                  document.getElementById(`settings-tab-${SETTINGS_TABS[next]!.id}`)?.focus();
                }}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
          <div
            id="settings-content"
            className="settings-content"
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab}`}
            tabIndex={0}
          >
            {/* Keep drafts mounted across tabs. No settings are discarded by navigation. */}
            <div className="settings-group" hidden={tab !== 'server'}>
              <AppearanceSettings />
              <ConversationDisplaySettings />
              <ImageCacheSettings />
              <ObsidianPanel />
            </div>
            <div hidden={tab === 'tts'}>
              <GenerationSettings section={tab === 'server' ? 'server' : 'ai'} />
            </div>
            <div className="settings-group" hidden={tab !== 'tts'}>
              <TtsSettings active={tab === 'tts'} />
            </div>
            <div className="settings-collections" hidden={tab !== 'server'}>
              <SettingsView
                activeColl={activeColl}
                stats={stats}
                onRefresh={onRefresh}
                onDeleted={onDeleted}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
