#!/usr/bin/env node
// RELEASE-SMOKE.md state machine.
//
// Grammar the parser relies on (keep RELEASE-SMOKE.md in this shape):
//   - [ ] <text>                                  → unchecked row
//   - [x] <text> ... (verified YYYY-MM-DD …)      → checked row, must carry a date
//   A row containing PENDING DRAFT ASSET or PENDING POST-PUBLISH UPDATER is an
//   explicitly allowed unfinished row — only in --pre-tag mode.
//
// Modes:
//   --pre-tag   Every real row is dated evidence; ONLY the two labeled
//               pending rows may remain unchecked/unlabeled.
//   --final     Zero pending markers, zero unchecked rows, zero NOT RUN,
//               and the header must state the current package version.

import { readFileSync } from "node:fs";
import process from "node:process";

const ALLOWED_PENDING = ["PENDING DRAFT ASSET", "PENDING POST-PUBLISH UPDATER"];
const EXPECTED_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function main() {
  const mode = process.argv[2];
  const fileArg = process.argv[3] ?? "RELEASE-SMOKE.md";
  if (!["--pre-tag", "--final"].includes(mode)) {
    fail("usage: verify-release-smoke.mjs (--pre-tag|--final) [RELEASE-SMOKE.md]");
  }
  const file = fileArg === "--pre-tag" || fileArg === "--final" ? "RELEASE-SMOKE.md" : fileArg;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    fail(`cannot read ${file}`);
  }

  const rows = [...text.matchAll(/^- \[( |x)\] (.*)$/gm)].map((m) => ({
    checked: m[1] === "x",
    body: m[2],
  }));
  if (rows.length < 20) {
    fail(
      "RELEASE-SMOKE.md has only " +
        rows.length +
        " rows; the current release smoke list needs its full contract",
    );
  }

  const pendingAllowedInPreTag =
    mode === "--pre-tag" ? ALLOWED_PENDING : [];
  const problems = [];

  for (const row of rows) {
    const isPendingRow = ALLOWED_PENDING.some((p) => row.body.includes(p));
    const unknownPending = !isPendingRow && /PENDING/.test(row.body);
    if (unknownPending) {
      problems.push(`row contains an unlabelled PENDING marker: ${row.body.slice(0, 90)}`);
      continue;
    }
    if (!row.checked) {
      if (mode === "--final") {
        problems.push(`unchecked row survived to final: ${row.body.slice(0, 90)}`);
      } else if (!isPendingRow) {
        problems.push(`pre-tag requires every non-pending row verified: ${row.body.slice(0, 90)}`);
      } else if (!pendingAllowedInPreTag.some((p) => row.body.includes(p))) {
        problems.push(`pending row lost its allowed label: ${row.body.slice(0, 90)}`);
      }
      continue;
    }
    // Checked rows must be dated evidence.
    if (!/\b\d{4}-\d{2}-\d{2}\b/.test(row.body)) {
      problems.push(`checked row without a verification date: ${row.body.slice(0, 90)}`);
    }
  }

  if (/NOT RUN/i.test(text)) {
    problems.push("file still contains NOT RUN");
  }

  const versionMatch = text.match(/\*\*Version:\*\*\s*(\S+)/);
  if (!versionMatch || versionMatch[1] !== EXPECTED_VERSION) {
    problems.push('header "**Version:**" must say ' + EXPECTED_VERSION);
  }

  if (problems.length > 0) {
    fail(`${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  console.log(
    mode === "--pre-tag"
      ? `✓ pre-tag smoke complete (${rows.length} rows; only labeled draft/updater pendings remain)`
      : `✓ final smoke complete (${rows.length} rows fully evidenced, no pendings)`,
  );
}

main();
