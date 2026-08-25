import { create } from "zustand";
import { api } from "../lib/api";

interface GuideStore {
  isOpen: boolean;
  activeSectionId: string;
  searchQuery: string;
  openGuide: (sectionId?: string) => void;
  closeGuide: () => void;
  setActiveSection: (id: string) => void;
  setSearchQuery: (query: string) => void;
}

export const useGuideStore = create<GuideStore>((set, get) => ({
  isOpen: false,
  activeSectionId: "getting-started",
  searchQuery: "",

  openGuide: (sectionId) => {
    const id = sectionId ?? get().activeSectionId;
    set({ isOpen: true, activeSectionId: id, searchQuery: "" });
    api
      .getAppPreferences()
      .then((prefs) =>
        api.setAppPreferences({
          ...prefs,
          last_guide_section_id: id,
        }),
      )
      .catch(() => {});
  },

  closeGuide: () => set({ isOpen: false, searchQuery: "" }),

  setActiveSection: (id) => {
    set({ activeSectionId: id });
    api
      .getAppPreferences()
      .then((prefs) =>
        api.setAppPreferences({
          ...prefs,
          last_guide_section_id: id,
        }),
      )
      .catch(() => {});
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
}));

export async function loadLastGuideSection(): Promise<string> {
  try {
    const prefs = await api.getAppPreferences();
    return prefs.last_guide_section_id ?? "getting-started";
  } catch {
    return "getting-started";
  }
}
