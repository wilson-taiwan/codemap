import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("webview preconditions", () => {
  it("dragDropEnabled must stay false in tauri.conf.json window configuration", () => {
    const configPath = resolve(__dirname, "../../src-tauri/tauri.conf.json");
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    const mainWindow = config?.app?.windows?.[0];
    expect(
      mainWindow?.dragDropEnabled,
      "dragDropEnabled must stay false. Tauri's drag-drop handler returns true for every drag event, so wry never forwards dragover/drop to the webview and ALL HTML5 drag-and-drop in the app dies silently. See plans/archive/fleuron-v0.24-*.md task 1.",
    ).toBe(false);
  });

  it("data-tauri-drag-region exists in both WelcomeScreen.tsx and Toolbar.tsx", () => {
    const welcomePath = resolve(__dirname, "../components/WelcomeScreen.tsx");
    const welcomeContent = readFileSync(welcomePath, "utf-8");
    expect(
      welcomeContent.includes("data-tauri-drag-region"),
      "WelcomeScreen.tsx must carry data-tauri-drag-region so the window can be moved from the home screen on macOS.",
    ).toBe(true);

    const toolbarPath = resolve(__dirname, "../components/Toolbar.tsx");
    const toolbarContent = readFileSync(toolbarPath, "utf-8");
    expect(
      toolbarContent.includes("data-tauri-drag-region"),
      "Toolbar.tsx must carry data-tauri-drag-region so the window can be moved inside a study on macOS.",
    ).toBe(true);
  });
});
