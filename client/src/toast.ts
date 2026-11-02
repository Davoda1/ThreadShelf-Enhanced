import { create } from 'zustand';

export type ToastType = 'info' | 'success' | 'warning' | 'error' | 'progress';

export interface Toast {
  readonly id: number;
  readonly type: ToastType;
  readonly text: string;
}

export interface ConfirmOptions {
  readonly title: string;
  readonly message?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  readonly id: number;
  readonly resolve: (value: boolean) => void;
}

interface ToastStore {
  toasts: Toast[];
  confirmState: ConfirmState | null;
  pushToast: (text: string, type?: ToastType) => void;
  dismissToast: (id: number) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  resolveConfirm: (value: boolean) => void;
}

let nextId = 1;
const TOAST_TTL = 4000;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  confirmState: null,

  pushToast: (text, type = 'info') => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, type, text }] }));
    setTimeout(
      () => get().dismissToast(id),
      type === 'error' || type === 'warning' ? TOAST_TTL * 2 : TOAST_TTL,
    );
  },

  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      // If a dialog is already open, cancel it so its promise never dangles.
      const pending = get().confirmState;
      if (pending) pending.resolve(false);
      set({ confirmState: { ...options, id: nextId++, resolve } });
    }),

  resolveConfirm: (value) => {
    const current = get().confirmState;
    if (current) current.resolve(value);
    set({ confirmState: null });
  },
}));

/** Imperative helpers for non-component code. */
export const toast = {
  info: (text: string) => useToastStore.getState().pushToast(text, 'info'),
  success: (text: string) => useToastStore.getState().pushToast(text, 'success'),
  warning: (text: string) => useToastStore.getState().pushToast(text, 'warning'),
  progress: (text: string) => useToastStore.getState().pushToast(text, 'progress'),
  error: (text: string) => useToastStore.getState().pushToast(text, 'error'),
};

export const confirmDialog = (options: ConfirmOptions): Promise<boolean> =>
  useToastStore.getState().confirm(options);
