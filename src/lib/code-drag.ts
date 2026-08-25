import type { Code } from "./types";

export interface NestValidity {
  valid: boolean;
  reason?: string;
}

/**
 * Pure helper to validate whether a dragged code can be nested under target
 * (or promoted to top-level if target is null).
 */
export function canNest(
  dragged: Code,
  target: Code | null,
  allCodes: Code[],
): NestValidity {
  if (target === null) {
    // Dropping on background / top-level drop zone
    if (dragged.parent_id === null) {
      return { valid: false, reason: "Already a top-level code" };
    }
    return { valid: true };
  }

  if (dragged.id === target.id) {
    return { valid: false, reason: "A code cannot be its own parent" };
  }

  // A code with children cannot be nested under another code (mirrors db.rs:824)
  const draggedHasChildren = allCodes.some(
    (c) => c.parent_id === dragged.id && !c.is_retired,
  );
  if (draggedHasChildren) {
    return {
      valid: false,
      reason: "Move its sub-codes first",
    };
  }

  // A target that is itself a child cannot accept children (mirrors db.rs:808, 2-level limit)
  if (target.parent_id !== null) {
    return {
      valid: false,
      reason: "Codes nest two levels deep",
    };
  }

  // Already a child of this target
  if (dragged.parent_id === target.id) {
    return {
      valid: false,
      reason: "Already a sub-code",
    };
  }

  return { valid: true };
}
