import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repo-wide guard against publishing the maintainer's own identity, or the
 * identity of the study this tool was originally written for.
 *
 * This exists because the previous guard lived in `beta-notice.test.ts` and
 * read exactly one file (`BetaNotice.tsx`). Every real leak found in the
 * 2026-08-29 audit was somewhere that guard could not see: adversarial
 * fixtures in `src-tauri/src/diagnostics.rs`, a fixture directory name in
 * `src-tauri/src/commands.rs`, and a comment in a Supabase migration. A
 * check scoped to one file is a check that agrees with you.
 *
 * Two deliberate design notes:
 *
 * 1. **The needles are assembled at runtime from fragments.** If this file
 *    spelled them out, the guard would itself become the leak it prevents —
 *    the repository is public, and `git grep` does not care that a hit is
 *    inside a test. Please keep any token you add split.
 *
 * 2. **Personal names are not enumerated here.** There is no way to list a
 *    collaborator's surname in a public file without disclosing it, split or
 *    not. The categorical terms below cover the realistic leak path (fixtures,
 *    comments, and sample data that drift toward the real study); a human name
 *    landing in the tree is a review problem, not a grep problem.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const SELF = "src/lib/repo-privacy-guard.test.ts";

/** Generated files whose random base64 would trip substring matching. */
const SKIP_FILES = new Set(["package-lock.json", "src-tauri/Cargo.lock"]);

const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".pdf", ".woff", ".woff2", ".ttf",
]);

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  {
    pattern: new RegExp(["wilson", "yeh"].join(""), "i"),
    why: "the maintainer's local account name — leaks a real home directory",
  },
  {
    pattern: new RegExp(["wilson", "hyeh@gmail"].join(""), "i"),
    why: "the maintainer's personal email address",
  },
  {
    pattern: new RegExp(["camo", "uflaging"].join(""), "i"),
    why: "names the study this tool was built for",
  },
  {
    pattern: new RegExp(["auti", "stic"].join(""), "i"),
    why: "names the population that study recruits",
  },
  {
    pattern: new RegExp(["\\b", "UC", "LA", "\\b"].join(""), "i"),
    why: "names the institution the study runs under",
  },
  {
    pattern: new RegExp(["disc", "overy year"].join(""), "i"),
    why: "names the research program the study sits in",
  },
  {
    pattern: new RegExp(["Documents/", "HQ"].join(""), ""),
    why: "a private planning workspace path",
  },
  {
    pattern: new RegExp(["\\b", "AGENTS", "\\.md\\b"].join(""), ""),
    why: "a private agent-tooling file that does not belong in a public tree",
  },
];

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((f) => f !== SELF)
    .filter((f) => !SKIP_FILES.has(f))
    .filter((f) => !SKIP_EXTENSIONS.has(path.extname(f).toLowerCase()));
}

describe("repo-wide privacy guard", () => {
  it("finds files to scan at all", () => {
    // A guard that silently scanned nothing would pass forever.
    expect(trackedFiles().length).toBeGreaterThan(100);
  });

  it("no tracked file names the maintainer or the originating study", () => {
    const hits: string[] = [];
    for (const file of trackedFiles()) {
      const full = path.join(ROOT, file);
      let content: string;
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue; // deleted between listing and read; nothing to assert about
      }
      for (const { pattern, why } of FORBIDDEN) {
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            hits.push(`${file}:${i + 1} — ${why}`);
          }
        }
      }
    }
    expect(hits, `forbidden identifiers in tracked files:\n${hits.join("\n")}`).toEqual([]);
  });

  it("would actually catch a leak (negative control)", () => {
    // Proves the patterns match the thing they claim to match, so a green run
    // above means "clean", not "the regexes were wrong".
    const planted = [
      `/Users/${["wilson", "yeh"].join("")}/Fleuron/x`,
      `a study of ${["auti", "stic"].join("")} adults`,
      `${["camo", "uflaging"].join("")} study team`,
      `at ${["UC", "LA"].join("")} health`,
      `~/${["Documents/", "HQ"].join("")}/plan.md`,
    ];
    for (const line of planted) {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(line)), line).toBe(true);
    }
  });
});
