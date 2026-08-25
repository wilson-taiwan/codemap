import test from "node:test";
import assert from "node:assert/strict";
import { findCodemapBinary, runSelftest, rootDir } from "./selftest-parent.mjs";
import { resolve } from "node:path";

test("findCodemapBinary returns null for empty directory", () => {
  const res = findCodemapBinary(resolve(rootDir, "non_existent_dir_123"));
  assert.equal(res, null);
});

test("runSelftest rejects when binary is missing", async () => {
  await assert.rejects(
    () => runSelftest({ binaryPath: "/non/existent/codemap/binary" }),
    /Could not find Codemap binary/,
  );
});

test("runSelftest handles custom executable successfully", async () => {
  const res = await runSelftest({
    binaryPath: process.execPath,
    timeoutMs: 5000,
    env: { ...process.env },
  });
  // Node with --selftest will exit non-zero since --selftest is not a node option, but should exit cleanly without crashing
  assert.equal(typeof res.code, "number");
});
