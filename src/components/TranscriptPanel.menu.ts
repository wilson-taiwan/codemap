import type { Code, CodedSegment } from "../lib/types";
import type { MenuItemSpec } from "./ui/Menu";

export interface CoveredRun {
  start: number;
  end: number;
  wholeTurnOnly?: boolean;
}

/**
 * Resolve all codings that cover a highlighted text run in a passage.
 *
 * A coding covers the run if it is whole-turn, or if its span fully encompasses
 * [run.start, run.end].
 */
export function codingsCoveringRun(
  segmentId: string,
  run: CoveredRun,
  codedSegments: CodedSegment[],
  activeCoder: string,
): { mine: CodedSegment[]; theirs: CodedSegment[] } {
  const matching = codedSegments.filter((c) => {
    if (c.segment_id !== segmentId) return false;
    if (c.char_start == null || c.char_end == null) {
      return true; // Whole-turn covers all runs in this segment
    }
    return c.char_start <= run.start && c.char_end >= run.end;
  });

  return {
    mine: matching.filter((c) => c.coder_name === activeCoder),
    theirs: matching.filter((c) => c.coder_name !== activeCoder),
  };
}

export interface BuildMarkMenuOptions {
  segmentId: string;
  run: CoveredRun;
  codedSegments: CodedSegment[];
  codesById: Map<string, Code>;
  activeCoder: string;
  codeFilter: string | null;
  setCodeFilter: (codeId: string | null) => void;
  openNoteFor: (codedSegmentId: string) => void;
  removeCodeFromCoding: (codingId: string, codeId: string) => Promise<void>;
  clearMemoForCoding: (codingId: string) => Promise<void>;
}

/**
 * Build the span-aware context menu for right-clicking a <mark> highlight.
 *
 * For active coder:
 * - Filter by "<code>" (or Clear filter if active)
 * - Add/Edit note
 * - Remove note (if exists)
 * - Remove code
 * If multiple codings overlap, items are grouped into sections by coding name.
 *
 * For colleague codings:
 * - Only Filter by "<code>" in a section titled with their name.
 */
export function buildMarkMenuItems(options: BuildMarkMenuOptions): MenuItemSpec[] {
  const {
    segmentId,
    run,
    codedSegments,
    codesById,
    activeCoder,
    codeFilter,
    setCodeFilter,
    openNoteFor,
    removeCodeFromCoding,
    clearMemoForCoding,
  } = options;

  const { mine, theirs } = codingsCoveringRun(
    segmentId,
    run,
    codedSegments,
    activeCoder,
  );

  const items: MenuItemSpec[] = [];
  const multipleMine = mine.length > 1;

  for (const coding of mine) {
    const codeNames = coding.code_ids
      .map((id) => codesById.get(id)?.name)
      .filter((n): n is string => Boolean(n));
    const sectionTitle = multipleMine
      ? codeNames.join(" · ") || "Your coding"
      : undefined;

    // 1. Filter action per code in this coding (or single if 1 code)
    for (const codeId of coding.code_ids) {
      const code = codesById.get(codeId);
      const name = code?.name ?? "this code";
      const isFiltered = codeFilter === codeId;

      items.push({
        label: isFiltered ? `Clear filter for "${name}"` : `Filter by "${name}"`,
        icon: "filter",
        section: sectionTitle,
        onSelect: () => setCodeFilter(isFiltered ? null : codeId),
      });
    }

    // 2. Note action (Add note / Edit note)
    const hasNote = Boolean(coding.memo && coding.memo.trim().length > 0);
    items.push({
      label: hasNote ? "Edit note" : "Add note",
      icon: "note",
      section: sectionTitle,
      onSelect: () => openNoteFor(coding.id),
    });

    // 3. Remove note (only if note exists)
    if (hasNote) {
      items.push({
        label: "Remove note",
        icon: "trash",
        section: sectionTitle,
        destructive: true,
        onSelect: () => void clearMemoForCoding(coding.id),
      });
    }

    // 4. Remove code action(s)
    for (const codeId of coding.code_ids) {
      const code = codesById.get(codeId);
      const name = code?.name ?? "code";
      items.push({
        label: `Remove "${name}"`,
        icon: "close",
        section: sectionTitle,
        destructive: true,
        onSelect: () => void removeCodeFromCoding(coding.id, codeId),
      });
    }
  }

  // Colleague codings: Filter only
  for (const coding of theirs) {
    const sectionTitle = coding.coder_name;
    for (const codeId of coding.code_ids) {
      const code = codesById.get(codeId);
      const name = code?.name ?? "code";
      const isFiltered = codeFilter === codeId;

      items.push({
        label: isFiltered ? `Clear filter for "${name}"` : `Filter by "${name}"`,
        icon: "filter",
        section: sectionTitle,
        onSelect: () => setCodeFilter(isFiltered ? null : codeId),
      });
    }
  }

  return items;
}
