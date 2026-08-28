#!/usr/bin/env node
// Thin CLI wrapper around scripts/selftest-parent.mjs.
//
// Optional overrides:
//   --binary <path>            Run a specific built binary instead of the
//                              auto-resolved one (used by CI to point at the
//                              universal macOS bundle / installed Windows exe).
//   FLEURON_SELFTEST_BINARY    Same effect as an environment variable.
//   any further args           Forwarded to the app's `--selftest` runner.
import { runSelftest } from "./selftest-parent.mjs";
import { findFleuronBinary } from "./selftest-parent.mjs";

const argv = process.argv.slice(2);
const args = [...argv];
let customBinary;

const flagIndex = args.indexOf("--binary");
if (flagIndex !== -1) {
  customBinary = args[flagIndex + 1];
  if (!customBinary) {
    console.error("[run-selftest] --binary requires a path argument");
    process.exit(2);
  }
  args.splice(flagIndex, 2);
}

runSelftest({
  binaryPath:
    customBinary ??
    process.env.FLEURON_SELFTEST_BINARY ??
    findFleuronBinary(),
  args,
}).then(
  (result) => {
    if (!result.passed) {
      console.error(`[run-selftest] ❌ Selftest failed (exit ${result.code})`);
      process.exit(result.code || 1);
    }
    console.log("[run-selftest] ✅ Selftest passed");
  },
  (err) => {
    console.error(`[run-selftest] ❌ ${err?.message ?? err}`);
    process.exit(1);
  },
);
