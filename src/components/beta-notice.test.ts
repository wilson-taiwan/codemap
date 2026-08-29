import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("beta disclosure", () => {
  const ROOT = path.resolve(import.meta.dirname, "../..");

  it("renders the notice on both account creation and Study & sync surfaces", () => {
    for (const file of ["src/components/AccountForm.tsx", "src/components/SyncSheet.tsx"]) {
      const content = fs.readFileSync(path.resolve(ROOT, file), "utf8");
      expect(
        content,
        `${file} must render the shared BetaNotice (single source of truth)`,
      ).toMatch(/\bBetaNotice\b/);
    }
  });

  it("carries the agreed single source of truth copy", () => {
    const notice = fs.readFileSync(
      path.resolve(ROOT, "src/components/BetaNotice.tsx"),
      "utf8",
    ).replace(/\s+/g, " ").replace(/--/g, "\u2014");
    expect(notice).toContain("Free beta.");
    expect(notice).toContain("hosted sync will require a subscription");
    expect(notice).toContain("Your transcripts stay on your computer");
    expect(notice).toContain("local/offline coding tools remain free");
    expect(notice).toContain("founder pricing");
  });

  it("the inaccurate always-stays sentence cannot return to the app", () => {
    const srcDir = path.resolve(ROOT, "src");
    // Built from parts so the guard does not match its own literals.
    const stalePhrase = ["transcripts and cod", "ing always stay"].join("");
    function checkDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkDir(full);
        } else if (/\.(tsx?|md)$/.test(entry.name)) {
          const content = fs.readFileSync(full, "utf-8");
          expect(content).not.toContain(stalePhrase);
        }
      }
    }
    checkDir(srcDir);
  }, 30_000);

  // The private-planning-leak check that used to live here read only
  // BetaNotice.tsx. It is superseded by src/lib/repo-privacy-guard.test.ts,
  // which runs the same class of check over every tracked file — including the
  // Rust and SQL where the 2026-08-29 audit actually found leaks.
});
