import { isMac, shortcut } from "../lib/platform";

export type GuideCategory =
  | "getting-started"
  | "sync"
  | "shortcuts"
  | "troubleshooting"
  | "reflexive-ta";

export interface GuideSection {
  id: string;
  category: GuideCategory;
  title: string;
  whenToUse: string;
  steps: string[];
  expectedResults: string[];
  commonMistakes?: string[];
  relatedSectionIds?: string[];
}

export const GUIDE_CATEGORIES: { id: GuideCategory; label: string }[] = [
  { id: "getting-started", label: "Getting started" },
  { id: "sync", label: "How sync works" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
  { id: "troubleshooting", label: "Troubleshooting" },
  { id: "reflexive-ta", label: "Reflexive TA" },
];

export const USER_GUIDE_SECTIONS: GuideSection[] = [
  {
    id: "getting-started",
    category: "getting-started",
    title: "Quick reference: getting started",
    whenToUse: "Opening Codemap, starting a study, or joining an existing study.",
    steps: [
      "Starting a study: Click 'Set up a new study' on the home screen. Name your study and choose a local folder.",
      "Joining a study: Click 'Join a study' and paste the 8-character study key sent by your colleague.",
      "Importing transcripts: Add participant IDs (e.g. P01, P02) and point Codemap at your local .docx or .vtt transcript files.",
      "Coding text: Select any text passage in the transcript to open the coding bubble and apply or create codes.",
    ],
    expectedResults: [
      "Your project is stored locally as an SQLite database (project.db).",
      "Codes and coding decisions sync automatically in the background.",
    ],
    relatedSectionIds: ["sync-with-your-coder", "shortcuts", "troubleshooting"],
  },
  {
    id: "sync-with-your-coder",
    category: "sync",
    title: "How sync works (and what never leaves your computer)",
    whenToUse: "Understanding collaboration, privacy, and data flow in Codemap.",
    steps: [
      "Only opaque IDs and hashes travel to the sync server (segment hashes, code IDs, coder name, and timestamps).",
      "Transcripts and free-text memos NEVER leave your computer and are never uploaded to the sync server.",
      "Colleagues load identical transcripts locally; matching segment hashes connect their coding to yours automatically.",
      "Sync runs silently in the background when changes settle and whenever you open a study.",
    ],
    expectedResults: [
      "Both coders see shared coding highlights and attribution without sending files back and forth.",
      "HIPAA / IRB compliance: raw participant quotes remain strictly local on each machine.",
    ],
    commonMistakes: [
      "Typing slightly different Participant IDs (e.g. P7 vs P07) — IDs decide interview identity, so ensure they match your protocol exactly.",
    ],
    relatedSectionIds: ["getting-started", "troubleshooting"],
  },
  {
    id: "shortcuts",
    category: "shortcuts",
    title: "Keyboard shortcuts",
    whenToUse: "Navigating transcripts and coding rapidly without leaving the keyboard.",
    steps: [
      `${shortcut("mod", "1")} to ${shortcut("mod", "6")}: Instantly apply one of your 6 recent codes to the selected text.`,
      `${shortcut("mod", "Z")}: Undo the last coding action or hierarchy drag-to-nest.`,
      `${isMac ? shortcut("mod", "shift", "Z") : shortcut("mod", "Y")}: Redo the undone action.`,
      `${shortcut("mod", "alt", "ArrowRight")}: Nest focused code under the preceding sibling.`,
      `${shortcut("mod", "alt", "ArrowLeft")}: Move focused code back to top level.`,
      "ArrowUp / ArrowDown: Navigate between transcript passages.",
      `${shortcut("mod", "shift", "E")}: Open project export options (CSV & Markdown).`,
      "?: Toggle this User Guide reference.",
    ],
    expectedResults: [
      "Fluent keyboard-driven coding without reaching for the mouse.",
    ],
    relatedSectionIds: ["getting-started", "troubleshooting"],
  },
  {
    id: "troubleshooting",
    category: "troubleshooting",
    title: "Troubleshooting: near-miss IDs, missing transcripts & conflicts",
    whenToUse: "Diagnosing unlinked transcripts, missing highlights, or sync issues.",
    steps: [
      "Near-miss Participant IDs: If your colleague typed 'P07' and you typed 'P7', Codemap warns you. Re-name the participant in Interview Settings to match.",
      "Missing transcript file: If a participant has coding from a colleague but no local transcript text, use 'Link transcripts' to point to the local .docx/.vtt file.",
      "Unresolved code highlights: A neutral dotted highlight indicates a code from a colleague that is still pulling or syncing.",
      "Offline work: You can code freely while offline. All changes queue locally and reconcile automatically once reconnected.",
    ],
    expectedResults: [
      "All coding aligns across the team with zero data loss.",
    ],
    relatedSectionIds: ["sync-with-your-coder", "shortcuts"],
  },
  {
    id: "reflexive-ta",
    category: "reflexive-ta",
    title: "Reflexive thematic analysis principles",
    whenToUse: "Designing codebooks and collaborating organically in Braun & Clarke reflexive TA.",
    steps: [
      "Codes evolve organically: Create, rename, nest, or retire codes as your conceptual understanding deepens.",
      "Overlapping codes: Two coders marking overlapping phrases is normal; hover highlights to view coder attribution.",
      "Two-level hierarchy: Drag sub-codes onto parent categories, use right-click 'Move into ▸', or press ⌘⌥→ to nest.",
    ],
    expectedResults: [
      "A rich, collaborative codebook that captures nuanced interpretations.",
    ],
    relatedSectionIds: ["getting-started", "sync-with-your-coder"],
  },
];

const ALIASES: Record<string, string> = {
  "workspace-overview": "getting-started",
  "add-code": "getting-started",
  "import-vtt-first": "getting-started",
  "apply-codes": "getting-started",
  "keyboard-shortcuts": "shortcuts",
};

export function getGuideSection(id: string): GuideSection | undefined {
  const targetId = ALIASES[id] ?? id;
  return (
    USER_GUIDE_SECTIONS.find((s) => s.id === targetId) ??
    USER_GUIDE_SECTIONS[0]
  );
}

export function searchGuideSections(query: string): GuideSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return USER_GUIDE_SECTIONS;
  return USER_GUIDE_SECTIONS.filter((s) => {
    const text = [
      s.title,
      s.whenToUse,
      ...s.steps,
      ...s.expectedResults,
      ...(s.commonMistakes ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return text.includes(q);
  });
}
