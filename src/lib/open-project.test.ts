import { describe, expect, it } from "vitest";
import { PROJECT_EXT, PROJECT_EXTENSIONS } from "./open-project";

// These two constants mirror `PROJECT_EXT` / `PROJECT_EXTS` in
// `src-tauri/src/db.rs`. They must agree, or the picker offers folders the
// backend then refuses to open.
describe("project extensions", () => {
  it("creates new projects as .fleuron", () => {
    expect(PROJECT_EXT).toBe(".fleuron");
  });

  it("keeps every pre-rename extension openable", () => {
    expect([...PROJECT_EXTENSIONS]).toEqual(["fleuron", "codemap", "qcproj"]);
  });

  it("offers the current extension first in the picker", () => {
    expect(PROJECT_EXTENSIONS[0]).toBe(PROJECT_EXT.replace(".", ""));
  });
});
