import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeLocalStorage } from './safe-storage';
import { normalizeLocale, type Locale } from './i18n/core';
import type {
  FavoriteGenerationModel,
  GenerationProviderId,
  OpenRouterModelSort,
  PinnedConversation,
  RoleFilters,
  SavedSearch,
} from './types';

export type Theme = 'dark' | 'light';

export const savedSearchSignature = (s: Omit<SavedSearch, 'id' | 'savedAt'>): string =>
  [s.q, s.collection, s.mode, s.model ?? '', s.from ?? '', s.to ?? ''].join('\0');

export const pinKey = (p: PinnedConversation): string =>
  [p.collection, p.sourceFile, p.conversationKey ?? ''].join('\0');

export const favoriteModelKey = (model: FavoriteGenerationModel): string =>
  `${model.provider}\0${model.id}`;

const GENERATION_PROVIDERS: readonly GenerationProviderId[] = [
  'llama-cpp',
  'openrouter',
  'strata',
  'openai-compatible',
];

interface UIState {
  generationCatalogSort: OpenRouterModelSort;
  generationFreeOnly: boolean;
  setGenerationCatalogFilters: (sort: OpenRouterModelSort, freeOnly: boolean) => void;
  settingsTab: 'ai' | 'server' | 'tts';
  setSettingsTab: (tab: 'ai' | 'server' | 'tts') => void;
  generationStreaming: boolean;
  setGenerationStreaming: (enabled: boolean) => void;
  generationProvider: GenerationProviderId;
  setGenerationProvider: (provider: GenerationProviderId) => void;
  generationModels: Partial<Record<GenerationProviderId, string>>;
  setGenerationModel: (provider: GenerationProviderId, model: string) => void;
  imageLoadMode: 'click' | 'auto';
  setImageLoadMode: (mode: 'click' | 'auto') => void;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  richRendering: RoleFilters;
  setRichRendering: (role: keyof RoleFilters, enabled: boolean) => void;

  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;

  activeColl: string;
  setActiveColl: (c: string) => void;

  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  cmdkOpen: boolean;
  setCmdkOpen: (open: boolean) => void;

  newCollOpen: boolean;
  setNewCollOpen: (open: boolean) => void;

  roles: RoleFilters;
  toggleRole: (key: keyof RoleFilters) => void;

  modelFilter: string;
  setModelFilter: (m: string) => void;

  savedSearches: SavedSearch[];
  addSavedSearch: (s: Omit<SavedSearch, 'id' | 'savedAt'>) => void;
  removeSavedSearch: (id: string) => void;

  pinnedConversations: PinnedConversation[];
  togglePinned: (p: PinnedConversation) => void;

  favoriteGenerationModels: FavoriteGenerationModel[];
  toggleFavoriteGenerationModel: (model: FavoriteGenerationModel) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      generationCatalogSort: 'most-popular',
      generationFreeOnly: true,
      setGenerationCatalogFilters: (generationCatalogSort, generationFreeOnly) =>
        set({ generationCatalogSort, generationFreeOnly }),
      settingsTab: 'ai',
      setSettingsTab: (settingsTab) => set({ settingsTab }),
      generationStreaming: true,
      setGenerationStreaming: (generationStreaming) => set({ generationStreaming }),
      generationProvider: 'llama-cpp',
      setGenerationProvider: (generationProvider) => set({ generationProvider }),
      generationModels: {},
      setGenerationModel: (provider, model) =>
        set((state) => ({ generationModels: { ...state.generationModels, [provider]: model } })),
      imageLoadMode: 'click',
      setImageLoadMode: (mode) => set({ imageLoadMode: mode === 'auto' ? 'auto' : 'click' }),
      locale: 'en',
      setLocale: (locale) => set({ locale: normalizeLocale(locale) }),
      richRendering: { user: false, thinking: false, ai: true },
      setRichRendering: (role, enabled) =>
        set((state) => ({ richRendering: { ...state.richRendering, [role]: enabled } })),

      theme: 'dark',
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      setTheme: (theme) => set({ theme }),

      activeColl: 'all',
      setActiveColl: (activeColl) => set({ activeColl }),

      sidebarOpen: false,
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),

      cmdkOpen: false,
      setCmdkOpen: (cmdkOpen) => set({ cmdkOpen }),

      newCollOpen: false,
      setNewCollOpen: (newCollOpen) => set({ newCollOpen }),

      roles: { user: true, thinking: true, ai: true },
      toggleRole: (key) => set((s) => ({ roles: { ...s.roles, [key]: !s.roles[key] } })),

      modelFilter: '',
      setModelFilter: (modelFilter) => set({ modelFilter }),

      savedSearches: [],
      addSavedSearch: (s) =>
        set((state) => {
          const signature = savedSearchSignature(s);
          if (state.savedSearches.some((item) => savedSearchSignature(item) === signature)) {
            return state;
          }
          const saved: SavedSearch = {
            ...s,
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            savedAt: new Date().toISOString(),
          };
          // Newest first, capped so localStorage stays small.
          return { savedSearches: [saved, ...state.savedSearches].slice(0, 50) };
        }),
      removeSavedSearch: (id) =>
        set((state) => ({ savedSearches: state.savedSearches.filter((s) => s.id !== id) })),

      pinnedConversations: [],
      togglePinned: (p) =>
        set((state) => {
          const key = pinKey(p);
          const exists = state.pinnedConversations.some((item) => pinKey(item) === key);
          return {
            pinnedConversations: exists
              ? state.pinnedConversations.filter((item) => pinKey(item) !== key)
              : [p, ...state.pinnedConversations].slice(0, 100),
          };
        }),

      favoriteGenerationModels: [],
      toggleFavoriteGenerationModel: (model) =>
        set((state) => {
          const key = favoriteModelKey(model);
          const exists = state.favoriteGenerationModels.some(
            (candidate) => favoriteModelKey(candidate) === key,
          );
          return {
            favoriteGenerationModels: exists
              ? state.favoriteGenerationModels.filter(
                  (candidate) => favoriteModelKey(candidate) !== key,
                )
              : [model, ...state.favoriteGenerationModels].slice(0, 100),
          };
        }),
    }),
    {
      name: 'threadshelf:ui',
      storage: createJSONStorage(() => safeLocalStorage),
      merge: (persisted, current) => {
        const saved =
          persisted && typeof persisted === 'object' ? (persisted as Partial<UIState>) : {};
        return {
          ...current,
          ...saved,
          generationCatalogSort: ['default', 'most-popular', 'newest'].includes(
            saved.generationCatalogSort ?? '',
          )
            ? saved.generationCatalogSort!
            : 'most-popular',
          generationFreeOnly: saved.generationFreeOnly !== false,
          settingsTab: current.settingsTab,
          generationStreaming: saved.generationStreaming !== false,
          generationProvider: GENERATION_PROVIDERS.includes(
            saved.generationProvider as GenerationProviderId,
          )
            ? saved.generationProvider!
            : current.generationProvider,
          generationModels: Object.fromEntries(
            GENERATION_PROVIDERS.flatMap((provider) =>
              typeof saved.generationModels?.[provider] === 'string'
                ? [[provider, saved.generationModels[provider]]]
                : [],
            ),
          ),
          locale: normalizeLocale(saved.locale),
          imageLoadMode: saved.imageLoadMode === 'auto' ? 'auto' : 'click',
          richRendering: {
            user: typeof saved.richRendering?.user === 'boolean' ? saved.richRendering.user : false,
            thinking:
              typeof saved.richRendering?.thinking === 'boolean'
                ? saved.richRendering.thinking
                : false,
            ai: typeof saved.richRendering?.ai === 'boolean' ? saved.richRendering.ai : true,
          },
        };
      },
      partialize: (state) => ({
        generationCatalogSort: state.generationCatalogSort,
        generationFreeOnly: state.generationFreeOnly,
        generationStreaming: state.generationStreaming,
        generationProvider: state.generationProvider,
        generationModels: state.generationModels,
        imageLoadMode: state.imageLoadMode,
        locale: state.locale,
        richRendering: state.richRendering,
        theme: state.theme,
        activeColl: state.activeColl,
        roles: state.roles,
        savedSearches: state.savedSearches,
        pinnedConversations: state.pinnedConversations,
        favoriteGenerationModels: state.favoriteGenerationModels,
      }),
    },
  ),
);
