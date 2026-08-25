import type { Code, CodedSegment } from "./types";

export const MAX_STRIPE_COLUMNS = 5;
export const STRIPE_WIDTH_PX = 3;
export const STRIPE_GAP_PX = 2;

export interface LineRect {
  top: number;
  height: number;
}

export interface StripeSegment {
  codeId: string;
  codeName: string;
  color: string;
  columnIndex: number;
  top: number;
  height: number;
  isDashed: boolean;
  isWholeTurn: boolean;
}

export interface StripeLayoutResult {
  columns: { codeId: string; codeName: string; color: string }[];
  stripes: StripeSegment[];
  overflowCount: number;
  overflowCodes: { id: string; name: string; color: string }[];
}

export interface ComputeStripeLayoutInput {
  coded: CodedSegment[];
  codesById: Map<string, Code>;
  activeCoder: string | null;
  codeFilter: string | null;
  passageHeight: number;
  measureSpans?: (coding: CodedSegment) => LineRect[];
}

/**
 * Assigns columns to codes on a passage based on codebook sort_order,
 * calculates vertical stripe segments, and handles the 5-column cap.
 */
export function computeStripeLayout({
  coded,
  codesById,
  activeCoder,
  codeFilter,
  passageHeight,
  measureSpans,
}: ComputeStripeLayoutInput): StripeLayoutResult {
  // 1. Gather all unique resolved code IDs on this passage
  const presentCodeIds = new Set<string>();
  for (const c of coded) {
    for (const id of c.code_ids) {
      if (codesById.has(id)) {
        if (!codeFilter || id === codeFilter) {
          presentCodeIds.add(id);
        }
      }
    }
  }

  // 2. Sort codes by codebook sort_order, then name
  const sortedCodes: Code[] = Array.from(presentCodeIds)
    .map((id) => codesById.get(id)!)
    .filter(Boolean)
    .sort((a, b) => {
      const orderDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0);
      if (orderDiff !== 0) return orderDiff;
      return a.name.localeCompare(b.name);
    });

  // 3. Assign columns up to MAX_STRIPE_COLUMNS
  const visibleCodes = sortedCodes.slice(0, MAX_STRIPE_COLUMNS);
  const overflowCodes = sortedCodes.slice(MAX_STRIPE_COLUMNS);

  const columnMap = new Map<string, number>();
  visibleCodes.forEach((c, idx) => columnMap.set(c.id, idx));

  // 4. Generate stripe segments
  const stripes: StripeSegment[] = [];

  for (const coding of coded) {
    const isOtherCoder = Boolean(activeCoder && coding.coder_name !== activeCoder);
    const isWholeTurn = coding.char_start === null || coding.char_start === undefined;

    for (const codeId of coding.code_ids) {
      const colIdx = columnMap.get(codeId);
      if (colIdx === undefined) continue; // In overflow

      const code = codesById.get(codeId);
      if (!code) continue;

      if (isWholeTurn) {
        stripes.push({
          codeId,
          codeName: code.name,
          color: code.color,
          columnIndex: colIdx,
          top: 0,
          height: passageHeight,
          isDashed: isOtherCoder,
          isWholeTurn: true,
        });
      } else {
        const rects = measureSpans ? measureSpans(coding) : [];
        if (rects.length === 0) {
          // Fallback if no rects measured
          stripes.push({
            codeId,
            codeName: code.name,
            color: code.color,
            columnIndex: colIdx,
            top: 0,
            height: passageHeight,
            isDashed: isOtherCoder,
            isWholeTurn: false,
          });
        } else {
          for (const r of rects) {
            stripes.push({
              codeId,
              codeName: code.name,
              color: code.color,
              columnIndex: colIdx,
              top: r.top,
              height: r.height,
              isDashed: isOtherCoder,
              isWholeTurn: false,
            });
          }
        }
      }
    }
  }

  return {
    columns: visibleCodes.map((c) => ({ codeId: c.id, codeName: c.name, color: c.color })),
    stripes,
    overflowCount: overflowCodes.length,
    overflowCodes: overflowCodes.map((c) => ({ id: c.id, name: c.name, color: c.color })),
  };
}

/**
 * Merges overlapping or vertically adjacent rects in the same column.
 */
export function mergeAdjacentRects(rects: LineRect[]): LineRect[] {
  if (rects.length <= 1) return rects;
  const sorted = [...rects].sort((a, b) => a.top - b.top);
  const merged: LineRect[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const prev = merged[merged.length - 1];
    const prevBottom = prev.top + prev.height;

    if (current.top <= prevBottom + 1) {
      // Overlapping or adjacent
      const newBottom = Math.max(prevBottom, current.top + current.height);
      prev.height = newBottom - prev.top;
    } else {
      merged.push(current);
    }
  }

  return merged;
}
