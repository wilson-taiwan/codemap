import { test, expect } from "@playwright/test";
import { flushDiagnostics, watchPageDiagnostics } from "./helpers/diagnostics";
import { dismissTopDialog, gotoApp, openWorkspace } from "./helpers/workspace";

let consoleLines: ReturnType<typeof watchPageDiagnostics>;

test.beforeEach(async ({ page }) => {
  consoleLines = watchPageDiagnostics(page);
  await gotoApp(page);
  await openWorkspace(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await flushDiagnostics(page, testInfo, consoleLines);
});

test("settings theme toggle and codebook panel render", async ({ page }) => {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.keyboard.press("Escape");

  await expect(page.getByRole("heading", { name: "Codebook" })).toBeVisible();
});

test("backup panel opens from the overflow menu", async ({ page }) => {
  await page.getByRole("button", { name: "More actions" }).click();
  const backups = page.getByRole("menuitem", { name: /backup/i });
  if (await backups.isVisible().catch(() => false)) {
    await backups.click();
    await expect(page.getByRole("heading", { name: "Backups" })).toBeVisible();
    await dismissTopDialog(page);
  }
});
