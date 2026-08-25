import type { Code, CodedSegment } from "./types";

/**
 * One stretch of a passage that renders as a single piece.
 *
 * A run is the largest span of text over which the set of codes does not
 * change. Runs never overlap and always tile the whole passage, so rendering is
 * a straight map with no positioning arithmetic.
 */
export interface HighlightRun {
  start: number;
  end: number;
  text: string;
  /** Codes covering this run, in codebook order. Empty means plain text. */
  codes: Code[];
  /** Coders whose highlights cover this run. */
  coders: string[];
  /** Number of code IDs on this run that could not be resolved against the codebook. */
  unresolvedCount: number;
  /** Per-code attribution: which coder(s) applied each code on this run. */
  codeCoders?: { code: Code; coders: string[] }[];
  /**
   * True when every coding covering this run applies to the whole passage.
   * Rendering tints these more lightly: a whole-passage code is a weaker,
   * broader claim than a phrase somebody deliberately dragged over, and drawing
   * both at the same strength would hide the spans inside.
   */
  wholeTurnOnly: boolean;
}

/**
 * Format hover tooltip text attributing codes to coders.
 */
export function formatRunAttribution(
  run: HighlightRun,
  activeCoder?: string | null,
): string {
  const parts: string[] = [];
  if (run.codeCoders && run.codeCoders.length > 0) {
    for (const item of run.codeCoders) {
      const codersDisplay = item.coders
        .map((c) => (activeCoder && c === activeCoder ? "you" : c))
        .join(", ");
      parts.push(`${item.code.name} — ${codersDisplay}`);
    }
  } else if (run.codes.length > 0) {
    const codersDisplay = run.coders
      .map((c) => (activeCoder && c === activeCoder ? "you" : c))
      .join(", ");
    parts.push(`${run.codes.map((c) => c.name).join(", ")} — ${codersDisplay}`);
  }

  if (run.unresolvedCount > 0) {
    const codeWord =
      run.unresolvedCount === 1 ? "1 code" : `${run.unresolvedCount} codes`;
    parts.push(
      `${codeWord} from another coder — not synced to this computer yet`,
    );
  }

  return parts.join("\n");
}

/**
 * Cut `text` into runs at every point where the covering set of codes changes.
 *
 * Overlapping highlights are the normal case, not an edge case: two coders will
 * mark overlapping phrases, and one coder may mark a phrase inside a stretch
 * they already coded. Rather than trying to stack or nest the marks — which
 * cannot be expressed in flat HTML without arbitrary nesting depth — the
 * passage is partitioned at every boundary, and each resulting piece names the
 * full set of codes covering it. Three overlapping spans produce five runs, and
 * the middle one honestly reports all three.
 *
 * Whole-turn codings (null offsets) are included, spanning the entire passage.
 * They used to be excluded, on the reasoning that drawing them over every
 * character would bury the more precise spans inside them. But a code applied
 * to a whole passage *is* a claim about every word in it, and leaving the text
 * plain made whole-passage coding look like it had not been recorded — the one
 * kind of coding with no visible trace in the text. The partitioning already
 * handles the overlap honestly: where a span sits inside a whole-turn coding,
 * that run reports both codes, so the specific claim is still visible as a
 * change in the highlight rather than being lost.
 */
export function highlightRuns(
  text: string,
  coded: CodedSegment[],
  codesById: Map<string, Code>,
): HighlightRun[] {
  const spans = coded
    .map((c) => ({
      // A whole-turn coding (null offsets) covers the passage end to end.
      ...(c.char_start == null || c.char_end == null
        ? { wholeTurn: true }
        : { wholeTurn: false }),
      ...c,
    }))
    .map((c) => ({
      // Clamped because a passage can be re-imported with a corrected
      // transcript: same id, different length. An offset past the end would
      // otherwise produce a run with negative width and drop text.
      start: c.wholeTurn
        ? 0
        : Math.max(0, Math.min(c.char_start as number, text.length)),
      end: c.wholeTurn
        ? text.length
        : Math.max(0, Math.min(c.char_end as number, text.length)),
      codeIds: c.code_ids,
      coder: c.coder_name,
      wholeTurn: c.wholeTurn,
    }))
    .filter((s) => s.end > s.start);

  if (spans.length === 0) {
    return [
      {
        start: 0,
        end: text.length,
        text,
        codes: [],
        coders: [],
        unresolvedCount: 0,
        wholeTurnOnly: false,
      },
    ];
  }

  const boundaries = new Set<number>([0, text.length]);
  for (const s of spans) {
    boundaries.add(s.start);
    boundaries.add(s.end);
  }
  const points = [...boundaries].sort((a, b) => a - b);

  const runs: HighlightRun[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;

    const covering = spans.filter((s) => s.start <= start && s.end >= end);
    const codeIds = new Set(covering.flatMap((s) => s.codeIds));
    const resolvedCodes: Code[] = [];
    let unresolvedCount = 0;
    for (const id of codeIds) {
      const code = codesById.get(id);
      if (code) {
        resolvedCodes.push(code);
      } else {
        unresolvedCount++;
      }
    }
    resolvedCodes.sort((a, b) => a.sort_order - b.sort_order);

    const codeCoders = resolvedCodes.map((c) => ({
      code: c,
      coders: [
        ...new Set(
          covering.filter((s) => s.codeIds.includes(c.id)).map((s) => s.coder),
        ),
      ].sort(),
    }));

    runs.push({
      start,
      end,
      text: text.slice(start, end),
      codes: resolvedCodes,
      coders: [...new Set(covering.map((s) => s.coder))].sort(),
      unresolvedCount,
      codeCoders,
      wholeTurnOnly: covering.length > 0 && covering.every((s) => s.wholeTurn),
    });
  }

  // Adjacent runs carrying the same codes are one run. Without this, a span
  // that merely *touches* another (P07 coded 0–10, Sam coded 10–20) leaves a
  // seam in the middle of a word for no reason the reader can see.
  const merged: HighlightRun[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    const sameCodes =
      prev &&
      prev.codes.length === run.codes.length &&
      prev.codes.every((c, i) => c.id === run.codes[i].id) &&
      prev.unresolvedCount === run.unresolvedCount &&
      prev.coders.length === run.coders.length &&
      prev.coders.every((c, i) => c === run.coders[i]) &&
      prev.wholeTurnOnly === run.wholeTurnOnly;

    if (sameCodes) {
      prev.end = run.end;
      prev.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }

  return merged;
}

/**
 * Character offsets of the current selection within `container`.
 *
 * Counts through the rendered text rather than trusting the DOM node offsets:
 * a highlighted passage is a row of `<mark>` and text nodes, so
 * `range.startOffset` is an offset into whichever fragment the drag happened to
 * begin in, not into the passage. Measuring a range that runs from the start of
 * the container to the selection's start gives the real index, and it stays
 * correct however the passage is chopped up.
 *
 * Returns null when there is no selection, when it is collapsed, or when it
 * escapes the container — a drag that runs off the end of one passage into the
 * next must not code a span that spills across both.
 */
export function selectionOffsets(
  container: HTMLElement,
): { start: number; end: number; text: string } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return null;
  }

  const preceding = range.cloneRange();
  preceding.selectNodeContents(container);
  preceding.setEnd(range.startContainer, range.startOffset);

  return trimmedSpan(preceding.toString().length, range.toString());
}

/**
 * Turn a raw selection into the span that gets stored.
 *
 * Split out from the DOM reading above so the arithmetic — which is where an
 * off-by-one would silently shift every highlight and every exported quote by a
 * character — is testable without a DOM. The function above is then a thin
 * shell whose only job is producing these two numbers.
 *
 * Edges are trimmed because dragging across a phrase almost always picks up a
 * leading or trailing space, and that space is not cosmetic once stored: it
 * widens the highlight past the words it marks, and it lands inside the quoted
 * extract in the CSV export.
 */
export function trimmedSpan(
  rawStart: number,
  raw: string,
): { start: number; end: number; text: string } | null {
  if (raw.trim().length === 0) return null;

  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const start = rawStart + leading;
  const end = rawStart + raw.length - trailing;

  if (end <= start) return null;

  return { start, end, text: raw.slice(leading, raw.length - trailing) };
}
