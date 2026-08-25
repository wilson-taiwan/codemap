/**
 * Export configuration model and methodology presets.
 *
 * Qualitative methodologies have distinct evidentiary requirements for artifacts:
 * - Reflexive Thematic Analysis (Braun & Clarke 2006, 2019, 2021): Focuses on organic,
 *   meaning-based patterns. Coding frequencies / counts are intentionally omitted by default
 *   because frequency does not equal importance and invites misleading quantitative readings.
 * - Qualitative Content Analysis (Schreier 2012, Hsieh & Shannon 2005): Systematically
 *   describes the meaning of qualitative material through categories and frequencies.
 * - Framework Analysis (Gale et al. 2013, Ritchie & Spencer 1994): Structures data into a
 *   participant-by-code thematic matrix to facilitate cross-case and within-case comparison.
 */

export type ExportItem =
  | "codebook"
  | "coded-segments"
  | "report-html"
  | "report-pdf"
  | "framework-matrix"
  | "memos"
  | "counts";

export type PresetId = "reflexive-ta" | "content-analysis" | "framework-analysis";

export type ExportPreset = PresetId | "custom";

export interface ExportConfig {
  preset: ExportPreset;
  items: ExportItem[];
  includeParticipantScope: "all" | "selected";
  selectedParticipantIds?: string[];
  includeCoderScope: "all" | "active-coder";
}

export interface PresetDescription {
  id: PresetId;
  label: string;
  subtitle: string;
  rationale: string;
  defaultItems: ExportItem[];
}

export const PRESETS: Record<PresetId, PresetDescription> = {
  "reflexive-ta": {
    id: "reflexive-ta",
    label: "Reflexive thematic analysis",
    subtitle: "Narrative report with extracts and code definitions. Coding counts omitted.",
    rationale:
      "Braun & Clarke (2006, 2019, 2021) emphasize that in reflexive TA, frequency of coding does not indicate theme importance. Coding counts are omitted to avoid misleading quantitative inferences.",
    defaultItems: ["report-html", "report-pdf", "coded-segments", "codebook", "memos"],
  },
  "content-analysis": {
    id: "content-analysis",
    label: "Qualitative content analysis",
    subtitle: "Category structure, coding counts, frequency tables, and extracts.",
    rationale:
      "Content analysis (Schreier 2012) uses category frequencies alongside narrative extracts to demonstrate descriptive distribution across the corpus.",
    defaultItems: ["report-html", "report-pdf", "coded-segments", "codebook", "counts", "memos"],
  },
  "framework-analysis": {
    id: "framework-analysis",
    label: "Framework analysis",
    subtitle: "Participant-by-code thematic matrix, summaries, and coded extracts.",
    rationale:
      "The Framework Method (Gale et al. 2013) generates a structured case-by-code matrix displaying illustrative snippets across all participants and codes.",
    defaultItems: [
      "report-html",
      "report-pdf",
      "coded-segments",
      "framework-matrix",
      "codebook",
      "counts",
      "memos",
    ],
  },
};

export const ALL_EXPORT_ITEMS: { id: ExportItem; label: string; description: string; group: "report" | "data" }[] = [
  {
    id: "report-html",
    label: "HTML report (report.html)",
    description: "Self-contained styled document ready to open or print to PDF",
    group: "report",
  },
  {
    id: "report-pdf",
    label: "Report (report.pdf)",
    description: "A formatted PDF of the report above, ready to share or attach.",
    group: "report",
  },
  {
    id: "codebook",
    label: "Codebook & definitions",
    description: "Hierarchical code structure, definitions, criteria, and colors",
    group: "report",
  },
  {
    id: "memos",
    label: "Memos & notes",
    description: "Analytic notes attached to passages and interview memos",
    group: "report",
  },
  {
    id: "counts",
    label: "Code frequencies & counts",
    description: "Usage totals and rollup counts for parent and sub-codes",
    group: "report",
  },
  {
    id: "coded-segments",
    label: "Coded segments (coded-segments.csv)",
    description: "Tabular extract of all coded passages with speaker, quote, and timestamp",
    group: "data",
  },
  {
    id: "framework-matrix",
    label: "Framework matrix (framework-matrix.csv)",
    description: "Participant-by-code grid with quote snippets and sub-code rollup",
    group: "data",
  },
];

export function getDefaultConfig(preset: PresetId = "reflexive-ta"): ExportConfig {
  return {
    preset,
    items: [...PRESETS[preset].defaultItems],
    includeParticipantScope: "all",
    includeCoderScope: "all",
  };
}

export function describePreset(id: PresetId): PresetDescription {
  return PRESETS[id];
}

/**
 * Checks whether an export config has diverged from its declared preset's defaults.
 */
export function isCustom(config: ExportConfig): boolean {
  if (config.preset === "custom") return true;
  const presetDef = PRESETS[config.preset as PresetId];
  if (!presetDef) return true;

  const defaultSet = new Set(presetDef.defaultItems);
  const currentSet = new Set(config.items);

  if (defaultSet.size !== currentSet.size) return true;
  for (const item of defaultSet) {
    if (!currentSet.has(item)) return true;
  }
  return false;
}

export function setPreset(config: ExportConfig, preset: PresetId): ExportConfig {
  return {
    ...config,
    preset,
    items: [...PRESETS[preset].defaultItems],
  };
}

export function toggleItem(config: ExportConfig, item: ExportItem): ExportConfig {
  const hasItem = config.items.includes(item);
  const nextItems = hasItem
    ? config.items.filter((i) => i !== item)
    : [...config.items, item];
  return {
    ...config,
    preset: "custom",
    items: nextItems,
  };
}
