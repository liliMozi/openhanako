export interface Toast {
  id: number;
  text: string;
  type: 'success' | 'error' | 'info' | 'warning';
  errorCode?: string;
  persistent?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
  dedupeKey?: string;
}

export interface ToastSlice {
  toasts: Toast[];
  addToast: (text: string, type?: Toast['type'], duration?: number, opts?: {
    errorCode?: string;
    persistent?: boolean;
    action?: Toast['action'];
    dedupeKey?: string;
  }) => void;
  removeToast: (id: number) => void;
}

const MAX_PERSISTENT = 3;
let _toastId = 0;

export const createToastSlice = (
  set: (partial: Partial<ToastSlice> | ((s: ToastSlice) => Partial<ToastSlice>)) => void,
  get: () => ToastSlice,
): ToastSlice => ({
  toasts: [],
  addToast: (text, type = 'info', duration = 5000, opts = {}) => {
    const id = ++_toastId;

    if (opts.dedupeKey) {
      const existing = get().toasts;
      if (existing.some(t => t.dedupeKey === opts.dedupeKey)) return;
    }

    const persistent = opts.persistent ?? false;

    set((s) => {
      let toasts = [...s.toasts, { id, text, type, ...opts, persistent }];

      const persistentCount = toasts.filter(t => t.persistent).length;
      if (persistentCount > MAX_PERSISTENT) {
        let removed = 0;
        toasts = toasts.filter(t => {
          if (t.persistent && removed < persistentCount - MAX_PERSISTENT) {
            removed++;
            return false;
          }
          return true;
        });
      }

      return { toasts };
    });

    if (!persistent && duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, duration);
    }
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
});
