import { describe, expect, it } from "vitest";
import {
  shouldStartDrag,
  resolveDropTarget,
  computeDragState,
} from "./pointer-drag";
import type { Code } from "./types";

function mockCode(partial: Partial<Code> & { id: string; name: string }): Code {
  return {
    color: "#ff0000",
    definition: "",
    inclusion_criteria: "",
    exclusion_criteria: "",
    example: "",
    parent_id: null,
    sort_order: 0,
    is_retired: false,
    usage_count: 0,
    ...partial,
  };
}

describe("pointer-drag", () => {
  it("only starts drag after moving past threshold (4px)", () => {
    expect(shouldStartDrag(100, 100, 100, 100)).toBe(false);
    expect(shouldStartDrag(100, 100, 102, 102)).toBe(false); // sqrt(8) ~ 2.8px
    expect(shouldStartDrag(100, 100, 104, 100)).toBe(true); // 4px
    expect(shouldStartDrag(100, 100, 103, 103)).toBe(true); // sqrt(18) ~ 4.24px
  });

  it("resolves top-level drop zone from DOM element", () => {
    const fakeZone = {
      closest: (sel: string) => (sel === "[data-top-level-drop-zone]" ? {} : null),
    } as unknown as Element;

    const target = resolveDropTarget(fakeZone);
    expect(target.isTopLevelZone).toBe(true);
    expect(target.targetCodeId).toBe(null);
  });

  it("resolves code row from DOM element", () => {
    const fakeRow = {
      closest: (sel: string) => {
        if (sel === "[data-code-row]") {
          return {
            getAttribute: (attr: string) => (attr === "data-code-id" ? "code-123" : null),
          };
        }
        return null;
      },
    } as unknown as Element;

    const target = resolveDropTarget(fakeRow);
    expect(target.isTopLevelZone).toBe(false);
    expect(target.targetCodeId).toBe("code-123");
  });

  it("computes valid drop state on a valid target code", () => {
    const parentCode = mockCode({ id: "p1", name: "Parent" });
    const childCode = mockCode({ id: "c1", name: "Child" });
    const allCodes = [parentCode, childCode];

    const state = computeDragState({
      draggedCode: childCode,
      pointerX: 150,
      pointerY: 200,
      targetCodeId: "p1",
      isOverTopLevelZone: false,
      allCodes,
    });

    expect(state.validity.valid).toBe(true);
    expect(state.targetCode?.id).toBe("p1");
  });

  it("rejects nesting when target is itself a child", () => {
    const topParent = mockCode({ id: "p1", name: "Top" });
    const subParent = mockCode({ id: "p2", name: "Sub", parent_id: "p1" });
    const childCode = mockCode({ id: "c1", name: "Child" });
    const allCodes = [topParent, subParent, childCode];

    const state = computeDragState({
      draggedCode: childCode,
      pointerX: 150,
      pointerY: 200,
      targetCodeId: "p2",
      isOverTopLevelZone: false,
      allCodes,
    });

    expect(state.validity.valid).toBe(false);
    expect(state.validity.reason).toContain("two levels");
  });

  it("computes valid drop on top-level drop zone when code is currently nested", () => {
    const nestedCode = mockCode({ id: "c1", name: "Child", parent_id: "p1" });
    const allCodes = [nestedCode];

    const state = computeDragState({
      draggedCode: nestedCode,
      pointerX: 150,
      pointerY: 50,
      targetCodeId: null,
      isOverTopLevelZone: true,
      allCodes,
    });

    expect(state.validity.valid).toBe(true);
    expect(state.isOverTopLevelZone).toBe(true);
  });
});
