#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(__dirname, "..");

export function findCodemapBinary(customRoot = rootDir) {
  const isMac = platform() === "darwin";
  const isWin = platform() === "win32";

  if (isMac) {
    const candidates = [
      resolve(
        customRoot,
        "src-tauri/target/release/bundle/macos/Codemap.app/Contents/MacOS/Codemap",
      ),
      resolve(customRoot, "src-tauri/target/release/Codemap"),
      resolve(
        customRoot,
        "src-tauri/target/debug/bundle/macos/Codemap.app/Contents/MacOS/Codemap",
      ),
      resolve(customRoot, "src-tauri/target/debug/Codemap"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } else if (isWin) {
    const candidates = [
      resolve(customRoot, "src-tauri/target/release/Codemap.exe"),
      resolve(customRoot, "src-tauri/target/debug/Codemap.exe"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } else {
    const candidates = [
      resolve(customRoot, "src-tauri/target/release/Codemap"),
      resolve(customRoot, "src-tauri/target/debug/Codemap"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }
  return null;
}

export function runSelftest({
  binaryPath = findCodemapBinary(),
  timeoutMs = 90000,
  env = process.env,
  args = [],
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!binaryPath || !existsSync(binaryPath)) {
      rejectPromise(
        new Error(`[selftest] ❌ Could not find Codemap binary to test in target directory.`),
      );
      return;
    }

    const spawnArgs = ["--selftest", ...args.filter((a) => a !== "--selftest")];
    console.log(
      `[selftest] Launching binary: ${binaryPath} with ${spawnArgs.join(" ")} (timeout: ${timeoutMs}ms)`,
    );

    const proc = spawn(binaryPath, spawnArgs, {
      env: { ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[selftest] ❌ Timeout after ${timeoutMs}ms. Terminating process...`);
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });

    proc.on("exit", (code, signal) => {
      clearTimeout(timer);
      const passed = code === 0 && !timedOut;
      resolvePromise({
        code: code ?? (timedOut ? -1 : 1),
        signal,
        stdout,
        stderr,
        passed,
        timedOut,
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runSelftest({ args: process.argv.slice(2) })
    .then((result) => {
      console.log(`[selftest] Completed with exit code ${result.code}`);
      process.exit(result.passed ? 0 : result.code || 1);
    })
    .catch((err) => {
      console.error(`[selftest] Failed to execute selftest:`, err);
      process.exit(1);
    });
}
