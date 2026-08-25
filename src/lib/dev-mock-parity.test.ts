import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const LIB_RS = resolve(ROOT, "../src-tauri/src/lib.rs");
const DEV_MOCK = resolve(import.meta.dirname, "dev-mock.ts");

function extractTauriCommands(): string[] {
  const lib = readFileSync(LIB_RS, "utf8");
  const block = lib.match(/generate_handler!\[([\s\S]*?)\]\)/);
  if (!block) throw new Error("generate_handler! block not found in lib.rs");
  const names = [...block[1].matchAll(/commands::(\w+)/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

function extractMockCommands(): Set<string> {
  const mock = readFileSync(DEV_MOCK, "utf8");
  const cmds = new Set<string>();
  for (const m of mock.matchAll(/case "([^"]+)":/g)) {
    if (!m[1].startsWith("plugin:")) cmds.add(m[1]);
  }
  return cmds;
}

describe("dev-mock parity with Tauri commands", () => {
  it("implements every invoke_handler command", () => {
    const registered = extractTauriCommands();
    const mocked = extractMockCommands();
    const missing = registered.filter((cmd) => !mocked.has(cmd));
    expect(
      missing,
      `dev-mock.ts is missing handlers for: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("registers the expected command count", () => {
    expect(extractTauriCommands().length).toBeGreaterThanOrEqual(60);
  });
});
