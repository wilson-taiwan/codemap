import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const syncChipSource = readFileSync(
  new URL("../components/SyncChip.tsx", import.meta.url),
  "utf8",
);

describe("v0.27 missed-Realtime recovery regression", () => {
  it("does not allow a connected socket to stretch foreground recovery beyond 15 seconds", () => {
    expect(syncChipSource).not.toContain("5 * 60 * 1000");
  });
});
