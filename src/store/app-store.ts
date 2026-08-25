import { create } from "zustand";
import { api } from "../lib/api";
import type { AppPreferences, MembershipSummary } from "../lib/types";

/**
 * A one-shot request from one part of the UI to another — the next-step coach
 * asking the codebook to open its add form, for example. Consumers clear it
 * as soon as they act on it.
 */
export type UiIntent = "add-code" | "import-vtt" | "new-interview";

/** What the user chose. "system" defers to the OS; the default is "light". */
export type ThemePreference = "light" | "dark" | "system";

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

/**
 * Put the resolved theme on the document root, where the stylesheet reads it.
 *
 * Written directly rather than through React because the tokens have to be in
 * place before the first paint — routing it through a component would show a
 * frame of the wrong theme on every launch.
 */
export function applyTheme(theme: ThemePreference) {
  document.documentElement.dataset.theme = theme;
}

export function shouldShowFirstRunSignIn(
  initialized: boolean,
  signinPromptSeen: boolean | undefined,
  signedIn: boolean,
): boolean {
  return initialized && !signinPromptSeen && !signedIn;
}

interface AppStore {
  preferences: AppPreferences;
  initialized: boolean;
  autoOpenFailed: string | null;
  showAbout: boolean;
  showSetup: boolean;
  showJoinStudy: boolean;
  joinStudyMembership: MembershipSummary | null;
  showSettings: boolean;
  intent: UiIntent | null;
  setIntent: (intent: UiIntent | null) => void;
  loadPreferences: () => Promise<void>;
  setReopenLastProject: (value: boolean) => Promise<void>;
  setSigninPromptSeen: (value: boolean) => Promise<void>;
  setPanelWidths: (codebook: number, memos: number) => Promise<void>;
  setCoachDismissed: (value: boolean) => Promise<void>;
  setMergeSameSpeaker: (value: boolean) => Promise<void>;
  setTheme: (theme: ThemePreference) => Promise<void>;
  setSyncServer: (url: string, anonKey: string) => Promise<void>;
  clearAutoOpenFailed: () => void;
  openAbout: () => void;
  closeAbout: () => void;
  openSetup: () => void;
  closeSetup: () => void;
  openJoinStudy: () => void;
  openJoinStudyForMembership: (m: MembershipSummary) => void;
  closeJoinStudy: () => void;
  openSettings: () => void;
  closeSettings: () => void;
}

const defaultPrefs: AppPreferences = {
  reopen_last_project: false,
  signin_prompt_seen: false,
  last_guide_section_id: null,
  panel_widths: null,
  coach_dismissed: false,
  merge_same_speaker: true,
  theme: "light",
  coder_identities: {},
  sync_url: null,
  sync_anon_key: null,
};

export const useAppStore = create<AppStore>((set, get) => ({
  preferences: defaultPrefs,
  initialized: false,
  autoOpenFailed: null,
  showAbout: false,
  showSetup: false,
  showJoinStudy: false,
  joinStudyMembership: null,
  showSettings: false,
  intent: null,

  setIntent: (intent) => set({ intent }),

  loadPreferences: async () => {
    try {
      const prefs = await api.getAppPreferences();
      // A project saved before this preference existed has no theme; light is
      // the default, so an absent value and "light" mean the same thing.
      applyTheme(isThemePreference(prefs.theme) ? prefs.theme : "light");
      set({ preferences: prefs, initialized: true });
    } catch {
      set({ preferences: defaultPrefs, initialized: true });
    }
  },

  setReopenLastProject: async (value) => {
    const prefs = { ...get().preferences, reopen_last_project: value };
    const saved = await api.setAppPreferences(prefs);
    set({ preferences: saved });
  },

  setSigninPromptSeen: async (value) => {
    const prefs = { ...get().preferences, signin_prompt_seen: value };
    set({ preferences: prefs });
    try {
      const saved = await api.setAppPreferences(prefs);
      set({ preferences: saved });
    } catch {
      // Cosmetic / preference fallback
    }
  },

  setPanelWidths: async (codebook, memos) => {
    const prefs = {
      ...get().preferences,
      panel_widths: { codebook, memos },
    };
    const saved = await api.setAppPreferences(prefs);
    set({ preferences: saved });
  },

  setTheme: async (theme) => {
    // Painted first, saved second. The write can fail — a full disk, a locked
    // preferences file — and a theme that snaps back after a click would be a
    // worse bug than a preference that fails to persist.
    applyTheme(theme);
    const prefs = { ...get().preferences, theme };
    set({ preferences: prefs });
    try {
      const saved = await api.setAppPreferences(prefs);
      set({ preferences: saved });
    } catch {
      // Cosmetic — the choice still applies for this session.
    }
  },

  setCoachDismissed: async (value) => {
    const prefs = { ...get().preferences, coach_dismissed: value };
    set({ preferences: prefs });
    try {
      const saved = await api.setAppPreferences(prefs);
      set({ preferences: saved });
    } catch {
      // Preference is cosmetic — a failed write shouldn't undo the click.
    }
  },

  setMergeSameSpeaker: async (value) => {
    const prefs = { ...get().preferences, merge_same_speaker: value };
    set({ preferences: prefs });
    try {
      const saved = await api.setAppPreferences(prefs);
      set({ preferences: saved });
    } catch {
      // Read again at the next import; a failed write costs one session.
    }
  },

  setSyncServer: async (url, anonKey) => {
    const prefs = {
      ...get().preferences,
      sync_url: url || null,
      sync_anon_key: anonKey || null,
    };
    const saved = await api.setAppPreferences(prefs);
    set({ preferences: saved });
  },

  clearAutoOpenFailed: () => set({ autoOpenFailed: null }),

  openAbout: () => set({ showAbout: true }),
  closeAbout: () => set({ showAbout: false }),
  openSetup: () => set({ showSetup: true }),
  closeSetup: () => set({ showSetup: false }),
  openJoinStudy: () => set({ showJoinStudy: true, joinStudyMembership: null }),
  openJoinStudyForMembership: (m) =>
    set({ showJoinStudy: true, joinStudyMembership: m }),
  closeJoinStudy: () =>
    set({ showJoinStudy: false, joinStudyMembership: null }),
  openSettings: () => set({ showSettings: true }),
  closeSettings: () => set({ showSettings: false }),
}));
