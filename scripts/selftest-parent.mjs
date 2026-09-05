#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(__dirname, "..");

export function findFleuronBinary(customRoot = rootDir) {
  const isMac = platform() === "darwin";
  const isWin = platform() === "win32";

  if (isMac) {
    const candidates = [
      resolve(
        customRoot,
        "src-tauri/target/release/bundle/macos/Fleuron.app/Contents/MacOS/Fleuron",
      ),
      resolve(customRoot, "src-tauri/target/release/Fleuron"),
      resolve(
        customRoot,
        "src-tauri/target/debug/bundle/macos/Fleuron.app/Contents/MacOS/Fleuron",
      ),
      resolve(customRoot, "src-tauri/target/debug/Fleuron"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } else if (isWin) {
    const candidates = [
      resolve(customRoot, "src-tauri/target/release/Fleuron.exe"),
      resolve(customRoot, "src-tauri/target/debug/Fleuron.exe"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } else {
    const candidates = [
      resolve(customRoot, "src-tauri/target/release/Fleuron"),
      resolve(customRoot, "src-tauri/target/debug/Fleuron"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }
  return null;
}

async function ensureDevServer(binaryPath) {
  if (!binaryPath.includes("debug")) return null;
  try {
    const res = await fetch("http://localhost:1420");
    if (res.ok || res.status === 200) return null;
  } catch {
    // dev server not running, start it
  }
  const viteProc = spawn("npx", ["vite", "--port", "1420"], {
    cwd: rootDir,
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch("http://localhost:1420");
      if (res.ok || res.status === 200) break;
    } catch {}
  }
  return viteProc;
}

export function runSelftest({
  binaryPath = findFleuronBinary(),
  timeoutMs = 90000,
  env = process.env,
  args = [],
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!binaryPath || !existsSync(binaryPath)) {
      rejectPromise(
        new Error(`[selftest] ❌ Could not find Fleuron binary to test in target directory.`),
      );
      return;
    }

    ensureDevServer(binaryPath).then((devServer) => {
      const cleanup = () => {
        if (devServer) {
          try {
            devServer.kill();
          } catch {}
        }
      };

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
        cleanup();
      }, timeoutMs);

      proc.on("error", (err) => {
        clearTimeout(timer);
        cleanup();
        rejectPromise(err);
      });

      proc.on("exit", (code, signal) => {
        clearTimeout(timer);
        cleanup();
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
    }).catch(rejectPromise);
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
