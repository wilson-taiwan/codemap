import { describe, expect, it } from "vitest";
import {
  duplicateInfo,
  seedLabelsForFiles,
  suggestLabelForFile,
} from "./bulk-import";

describe("suggestLabelForFile", () => {
  it("uses the filename stem", () => {
    expect(suggestLabelForFile("/audio/P07.vtt")).toBe("P07");
    expect(suggestLabelForFile("C:\\audio\\P07 intake.srt")).toBe("P07 intake");
    expect(suggestLabelForFile("no-extension")).toBe("no-extension");
    expect(suggestLabelForFile("/x/.vtt")).toBe("");
  });
});

describe("duplicateInfo", () => {
  it("flags a label the study already holds, case-insensitively", () => {
    const dup = duplicateInfo("p07", ["P07", "P08"]);
    expect(dup.isDuplicate).toBe(true);
    expect(dup.suggestion).toBe("P09");
  });

  it("clears a fresh label and a blank one", () => {
    expect(duplicateInfo("P09", ["P07"]).isDuplicate).toBe(false);
    expect(duplicateInfo("   ", ["P07"]).isDuplicate).toBe(false);
  });

  it("offers no suggestion when the study has no numbering pattern", () => {
    const dup = duplicateInfo("Ada", ["Ada", "Bo"]);
    expect(dup.isDuplicate).toBe(true);
    expect(dup.suggestion).toBe("");
  });
});

describe("seedLabelsForFiles", () => {
  it("seeds stems and bumps duplicates to the next free ID", () => {
    expect(seedLabelsForFiles(["/a/P07.vtt", "/a/P07.srt"], ["P07"])).toEqual([
      "P08",
      "P09",
    ]);
  });

  it("keeps distinct stems as-is", () => {
    expect(seedLabelsForFiles(["/a/P07.vtt", "/a/P08.vtt"], [])).toEqual([
      "P07",
      "P08",
    ]);
  });
});
