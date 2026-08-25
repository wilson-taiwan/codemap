import type { Code } from "./types";
import { canNest, type NestValidity } from "./code-drag";

export const DRAG_START_THRESHOLD_PX = 4;

export interface DragPointerState {
  draggedCode: Code;
  pointerX: number;
  pointerY: number;
  targetCodeId: string | null;
  targetCode: Code | null;
  isOverTopLevelZone: boolean;
  validity: NestValidity;
}

/**
 * Determines whether pointer movement exceeds the drag threshold (4px).
 */
export function shouldStartDrag(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  threshold = DRAG_START_THRESHOLD_PX,
): boolean {
  const dx = currentX - startX;
  const dy = currentY - startY;
  return dx * dx + dy * dy >= threshold * threshold;
}

/**
 * Pure helper to locate a code row or top-level drop zone from a point.
 */
export function resolveDropTarget(
  element: Element | null,
): { targetCodeId: string | null; isTopLevelZone: boolean } {
  if (!element) {
    return { targetCodeId: null, isTopLevelZone: false };
  }

  // 1. Check if hovering top-level drop zone
  const topZone = element.closest("[data-top-level-drop-zone]");
  if (topZone) {
    return { targetCodeId: null, isTopLevelZone: true };
  }

  // 2. Check if hovering a code row
  const row = element.closest("[data-code-row]");
  if (row) {
    const targetCodeId = row.getAttribute("data-code-id");
    return { targetCodeId, isTopLevelZone: false };
  }

  return { targetCodeId: null, isTopLevelZone: false };
}

/**
 * Computes drag validity and preview state based on target hit test.
 */
export function computeDragState({
  draggedCode,
  pointerX,
  pointerY,
  targetCodeId,
  isOverTopLevelZone,
  allCodes,
}: {
  draggedCode: Code;
  pointerX: number;
  pointerY: number;
  targetCodeId: string | null;
  isOverTopLevelZone: boolean;
  allCodes: Code[];
}): DragPointerState {
  if (isOverTopLevelZone) {
    const validity = canNest(draggedCode, null, allCodes);
    return {
      draggedCode,
      pointerX,
      pointerY,
      targetCodeId: null,
      targetCode: null,
      isOverTopLevelZone: true,
      validity,
    };
  }

  if (!targetCodeId) {
    return {
      draggedCode,
      pointerX,
      pointerY,
      targetCodeId: null,
      targetCode: null,
      isOverTopLevelZone: false,
      validity: { valid: false },
    };
  }

  const targetCode = allCodes.find((c) => c.id === targetCodeId) ?? null;
  const validity = targetCode
    ? canNest(draggedCode, targetCode, allCodes)
    : { valid: false };

  return {
    draggedCode,
    pointerX,
    pointerY,
    targetCodeId,
    targetCode,
    isOverTopLevelZone: false,
    validity,
  };
}
