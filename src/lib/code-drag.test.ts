import { describe, it, expect } from "vitest";
import { canNest } from "./code-drag";
import type { Code } from "./types";

function makeCode(id: string, parentId: string | null = null): Code {
  return {
    id,
    name: id,
    definition: null,
    inclusion_criteria: null,
    exclusion_criteria: null,
    example: null,
    parent_id: parentId,
    color: "#8a6410",
    sort_order: 0,
    is_retired: false,
    usage_count: 0,
  };
}

describe("code-drag validity rules (canNest)", () => {
  it("allows dragging an independent top-level code onto another top-level code", () => {
    const parent = makeCode("parent");
    const child = makeCode("child");
    const allCodes = [parent, child];

    const res = canNest(child, parent, allCodes);
    expect(res.valid).toBe(true);
  });

  it("disallows dragging a code onto itself", () => {
    const codeA = makeCode("a");
    const res = canNest(codeA, codeA, [codeA]);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("A code cannot be its own parent");
  });

  it("disallows dragging a code that already has children onto another code", () => {
    const parentA = makeCode("parentA");
    const subA = makeCode("subA", "parentA");
    const parentB = makeCode("parentB");
    const allCodes = [parentA, subA, parentB];

    const res = canNest(parentA, parentB, allCodes);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("Move its sub-codes first");
  });

  it("disallows dragging any code onto a target that is itself a sub-code", () => {
    const parent = makeCode("parent");
    const sub = makeCode("sub", "parent");
    const other = makeCode("other");
    const allCodes = [parent, sub, other];

    const res = canNest(other, sub, allCodes);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("Codes nest two levels deep");
  });

  it("disallows dragging a code onto its existing parent", () => {
    const parent = makeCode("parent");
    const child = makeCode("child", "parent");
    const allCodes = [parent, child];

    const res = canNest(child, parent, allCodes);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("Already a sub-code");
  });

  it("allows promoting a child code to top-level when target is null", () => {
    const parent = makeCode("parent");
    const child = makeCode("child", "parent");
    const allCodes = [parent, child];

    const res = canNest(child, null, allCodes);
    expect(res.valid).toBe(true);
  });

  it("disallows promoting an already top-level code when target is null", () => {
    const parent = makeCode("parent");
    const res = canNest(parent, null, [parent]);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("Already a top-level code");
  });
});
