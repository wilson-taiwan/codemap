import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { USER_GUIDE_SECTIONS } from "../content/user-guide";

describe("vocabulary guard", () => {
  it("enforces study key over group key in user guide", () => {
    for (const sec of USER_GUIDE_SECTIONS) {
      const allText = [
        sec.title,
        sec.whenToUse,
        ...sec.steps,
        ...(sec.expectedResults ?? []),
        ...(sec.commonMistakes ?? []),
      ].join(" ");
      expect(allText).not.toMatch(/group key/i);
    }
  });

  it("enforces participant ID over study label in user guide", () => {
    for (const sec of USER_GUIDE_SECTIONS) {
      const allText = [
        sec.title,
        sec.whenToUse,
        ...sec.steps,
        ...(sec.expectedResults ?? []),
        ...(sec.commonMistakes ?? []),
      ].join(" ");
      expect(allText).not.toMatch(/study label/i);
    }
  });

  it("enforces Join a study over Join a group in user guide", () => {
    for (const sec of USER_GUIDE_SECTIONS) {
      const allText = [
        sec.title,
        sec.whenToUse,
        ...sec.steps,
        ...(sec.expectedResults ?? []),
        ...(sec.commonMistakes ?? []),
      ].join(" ");
      expect(allText).not.toMatch(/Join a group/i);
    }
  });

  it("enforces no hardcoded 'Finder' in src/ (use fileManagerName instead)", () => {
    const srcDir = path.resolve(__dirname, "..");
    function checkDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkDir(full);
        } else if (
          /\.(tsx?|css)$/.test(entry.name) &&
          !entry.name.includes("platform.ts") &&
          !entry.name.includes("vocabulary.test.ts")
        ) {
          const content = fs.readFileSync(full, "utf-8");
          const noComments = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
          expect(noComments).not.toMatch(/\bFinder\b/);
        }
      }
    }
    checkDir(srcDir);
  }, 30_000);

  it("enforces no hardcoded 'Trash' in user-facing JSX/copy in src/components/ (use trashName() instead)", () => {
    const compDir = path.resolve(__dirname, "../components");
    function checkComponents(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkComponents(full);
        } else if (/\.tsx$/.test(entry.name)) {
          const content = fs.readFileSync(full, "utf-8");
          const noComments = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
          expect(noComments).not.toMatch(/>\s*Move to Trash\s*</i);
          expect(noComments).not.toMatch(/['"]Move to Trash['"]/i);
        }
      }
    }
    checkComponents(compDir);
  }, 30_000);
});
