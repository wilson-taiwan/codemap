/**
 * Tests for the stable file-failure contract's frontend half: sentinel
 * parsing, per-category copy, safe action sets, and — critically — that no
 * raw OS/path text can leak into displayed copy.
 */
import { describe, expect, it } from "vitest";
import {
  fileAccessCopy,
  parseFileError,
  recoveryActions,
} from "./file-access";

const wrapped = (category: string, message: string, detail: string) =>
  `CODEMAP_FILE_ERROR|${JSON.stringify({ category, message, detail })}`;

describe("parseFileError", () => {
  it("parses the Rust wire payload", () => {
    const ui = parseFileError(
      wrapped(
        "permission_denied",
        "Fleuron does not have permission to use that location.",
        "/Users/x/secret (os error 5)",
      ),
    );
    expect(ui).not.toBeNull();
    expect(ui!.category).toBe("permission_denied");
    expect(ui!.detail).toContain("os error 5");
  });

  it("returns null for legacy plain-string errors", () => {
    expect(parseFileError("Path is not a directory")).toBeNull();
    expect(parseFileError(undefined)).toBeNull();
    expect(parseFileError(42)).toBeNull();
  });

  it("returns null for corrupted payload instead of throwing", () => {
    expect(parseFileError("CODEMAP_FILE_ERROR|{not json")).toBeNull();
    expect(parseFileError("CODEMAP_FILE_ERROR|{}")).toBeNull();
  });
});

describe("fileAccessCopy", () => {
  it("renders human copy for every category", () => {
    for (const category of [
      "permission_denied",
      "path_unavailable",
      "storage_full",
      "read_only_storage",
      "file_in_use",
      "invalid_project",
    ] as const) {
      const { title, recovery } = fileAccessCopy({
        category,
        message: "",
        detail: "whatever",
      });
      expect(title.length).toBeGreaterThan(10);
      expect(recovery.length).toBeGreaterThan(20);
    }
  });

  it("never includes raw paths, os-error codes, or SQL in copy", () => {
    const ui = parseFileError(
      wrapped(
        "invalid_project",
        "This study could not be opened.",
        "rusqlite failure at /Users/x/study/project.db: malformed schema (11)",
      ),
    )!;
    const { title, recovery } = fileAccessCopy(ui);
    for (const text of [title, recovery]) {
      expect(text).not.toMatch(/\/Users|\.db|os error|SQL|sqlite/i);
    }
  });

  it("denial recovery never recommends Full Disk Access or disabling protection", () => {
    const { recovery } = fileAccessCopy({
      category: "permission_denied",
      message: "x",
      detail: "",
    });
    expect(recovery).not.toMatch(/full disk access|disable/i);
  });
});

describe("recoveryActions", () => {
  it("offers locate-folder for missing/unavailable paths", () => {
    expect(recoveryActions("path_unavailable")).toContain("locate-folder");
  });

  it("never offers remove-recent for transient failures like in-use or full disk", () => {
    expect(recoveryActions("file_in_use")).not.toContain("remove-recent");
    expect(recoveryActions("storage_full")).not.toContain("remove-recent");
  });

  it("always offers a choose-another path forward", () => {
    for (const category of [
      "permission_denied",
      "path_unavailable",
      "storage_full",
      "read_only_storage",
      "file_in_use",
      "invalid_project",
    ] as const) {
      expect(recoveryActions(category)).toContain("choose-another");
    }
  });
});
