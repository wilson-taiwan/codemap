#!/usr/bin/env node
import { runSelftest } from "./selftest-parent.mjs";

runSelftest({ args: process.argv.slice(2) })
  .then((result) => {
    console.log(`[selftest] Finished with exit code ${result.code}`);
    process.exit(result.passed ? 0 : result.code || 1);
  })
  .catch((err) => {
    console.error(`[selftest] Execution error:`, err);
    process.exit(1);
  });
