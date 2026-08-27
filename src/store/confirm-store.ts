/**
 * The one app-owned confirmation system.
 *
 * Why a store rather than ad-hoc dialogs: v1.1 fragmented prompts across
 * browser alert/confirm and native Tauri dialogs, which looked suspicious
 * right after an install warning and behaved inconsistently for keyboard and
 * screen-reader users. Every app-owned decision funnels through here; native
 * file pickers deliberately stay native (choosing is consent, not danger).
 *
 * Dedupe: a second request with the same `dedupeKey` while a dialog is open
 * joins the first promise — rapid double-clicks can never stack two dialogs.
 * Escape/scrim/cancel resolve false immediately; no promise is ever left
 * hanging after close.
 */
import { create } from "zustand";

export interface ConfirmOptions {
  title: string;
  /** Plain-language impact statement — what specifically will happen. */
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Require the user to type this exact string to enable confirm. */
  typedConfirmation?: string;
  /** Stable identity for coalescing duplicate intents. */
  dedupeKey?: string;
}

interface ConfirmState {
  open: boolean;
  options: ConfirmOptions | null;
  currentResolve: ((value: boolean) => void) | null;
  pendingByKey: Map<string, Promise<boolean>>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  answer: (value: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  open: false,
  options: null,
  currentResolve: null,
  pendingByKey: new Map(),

  confirm: (options) => {
    if (options.dedupeKey && get().open) {
      const existing = get().pendingByKey.get(options.dedupeKey);
      if (existing) return existing;
    }
    // If something is already open under a different key, it finishes first:
    // answering false politely resolves it so only one dialog ever shows.
    if (get().open) {
      get().answer(false);
    }
    const promise = new Promise<boolean>((resolve) => {
      set({ open: true, options, currentResolve: resolve });
    });
    if (options.dedupeKey) {
      const map = new Map(get().pendingByKey);
      map.set(options.dedupeKey, promise);
      set({ pendingByKey: map });
      void promise.then(() => {
        const next = new Map(get().pendingByKey);
        next.delete(options.dedupeKey!);
        set({ pendingByKey: next });
      });
    }
    return promise;
  },

  answer: (value) => {
    const { currentResolve, options } = get();
    set({ open: false, options: null, currentResolve: null });
    // Resolve AFTER state clears so awaiting callers never observe an open
    // dialog that has already been answered.
    currentResolve?.(value);
    void options;
  },
}));

/** Fire-and-forget handle used across stores/components. */
export function appConfirm(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().confirm(options);
}
