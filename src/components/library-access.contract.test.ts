/**
 * Task `local-library-access` frontend guards.
 *
 * Rendered-behavior coverage of the default-path and denial-recovery journeys
 * lives in the Playwright suite; these static checks pin the exact disclosure
 * sentences and ban resurfaced handoff/Box language in setup surfaces so a
 * careless copy edit cannot silently regress the trust contract between runs
 * of the heavier gates.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const HERE = import.meta.dirname;
const REPO_ROOT = resolve(HERE, "..", "..");

/** Whitespace-insensitive view of SOURCE TEXT (not just strings). */
const flat = (text: string) => text.replace(/\s+/g, " ");

/** Drop // line comments so prose about history isn't mistaken for copy. */
const withoutComments = (text: string) =>
  text.replace(/^[^"'`]*\/\/.*$/gm, "");

const read = (...parts: string[]) => readFileSync(resolve(HERE, ...parts), "utf8");

describe("folder-scan disclosure is persistent and accurate", () => {
  const panel = flat(read("TranscriptLinkPanel.tsx"));

  it("shows scope/local-processing/no-upload before any picker opens", () => {
    expect(panel).toContain("directly inside the folder you choose");
    expect(panel).toContain("not subfolders");
    expect(panel).toContain("Files are processed on this computer");
    expect(panel).toContain("transcript text is not uploaded");
  });

  it("renders scan failures as neutral recovery, not raw errors", () => {
    expect(panel).toContain("Choose another folder");
    expect(panel).toContain("How to fix access");
    // The classified-error path must go through parseFileError.
    expect(panel).toContain("parseFileError(e)");
  });
});

describe("setup copy offers the local library", () => {
  // Scan user-facing copy (comments stripped): a comment recalling why cloud
  // databases get corrupted is fine; instructions telling users to put
  // handoff files in Box are not.
  const wizard = flat(withoutComments(read("setup/SetupWizard.tsx")));

  it("no longer teaches handoff files or cloud sharing for projects", () => {
    expect(wizard.toLowerCase()).not.toContain("handoff");
    expect(wizard).not.toMatch(/\bBox\b|Google Drive/);
  });

  it("describes the local working folder and honest sync boundary", () => {
    expect(wizard).toContain("local working folder stays on this computer");
    expect(wizard).toContain("transcript text never does");
  });

  it("cloud advisory recommends exports/backups, not prohibition", () => {
    expect(wizard).toContain("exports/backups");
  });
});

describe("recent-row failure recovery", () => {
  const list = read("RecentProjectList.tsx");

  it("retains rows and offers all four safe paths", () => {
    expect(list).toContain("Locate folder");
    expect(list).toContain("Choose another study");
    expect(list).toContain("Remove from recent");
    expect(list).toContain("How to fix access");
    // Existence-pruning must stay dead: listRecentProjects never filters.
    const appData = readFileSync(
      resolve(REPO_ROOT, "src-tauri", "src", "app_data.rs"),
      "utf8",
    );
    expect(appData).not.toMatch(/projects\.retain\(\|p\| Path::new\(&p\.path\)\.exists\(\)\)/);
  });
});
