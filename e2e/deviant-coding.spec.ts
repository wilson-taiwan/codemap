import { test, expect } from "@playwright/test";
import {
  dismissTopDialog,
  gotoApp,
  openWorkspace,
} from "./helpers/workspace";
import { flushDiagnostics, watchPageDiagnostics } from "./helpers/diagnostics";

/**
 * Deviant coding journeys (E2E plan Task 4): interrupted and doubled actions
 * must never strand a partial coding or throw. Assertions ride the real UI
 * (passage aria-labels carry "— Not yet coded" until coded) plus the IPC ring.
 */

let consoleLines: ReturnType<typeof watchPageDiagnostics>;

test.beforeEach(async ({ page }) => {
  test.setTimeout(90_000);
  consoleLines = watchPageDiagnostics(page);
  await gotoApp(page);
  await openWorkspace(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await flushDiagnostics(page, testInfo, consoleLines);
});

function ipcCount(page: import("@playwright/test").Page, cmd: string) {
  return page.evaluate((command) => {
    const log = (
      window as unknown as {
        __FLEURON_IPC_LOG__?: { cmd: string; ok: boolean; err?: string }[];
      }
    ).__FLEURON_IPC_LOG__;
    return (log ?? []).filter((e) => e.cmd === command && e.ok).length;
  }, cmd);
}

/** "Passage 3" out of an option's full aria-label. */
function passagePrefix(name: string | null): string {
  if (!name) throw new Error("passage option lost its aria-label");
  return name.split("—")[0].trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function firstUncodedOption(page: import("@playwright/test").Page) {
  const passages = page.getByRole("listbox", { name: "Transcript passages" });
  const option = passages
    .getByRole("option", { name: /Not yet coded/ })
    .first();
  await expect(option).toBeVisible();
  const prefix = passagePrefix(await option.getAttribute("aria-label"));
  return { option, prefix };
}

async function openBubbleOn(page: import("@playwright/test").Page) {
  await page.keyboard.press("c");
  await expect(
    page.getByRole("dialog", { name: "Code this selection" }),
  ).toBeVisible();
}

async function clickCodeChip(
  page: import("@playwright/test").Page,
  code: string,
) {
  const bubble = page.getByRole("dialog", { name: "Code this selection" });
  await bubble.getByRole("textbox", { name: "Find or create a code" }).fill(code);
  await bubble
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(code)}`) })
    .first()
    .click({ force: true });
}

test("escape right after applying still lands exactly one clean coding", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const { option, prefix } = await firstUncodedOption(page);
  await option.click();
  await openBubbleOn(page);

  await clickCodeChip(page, "Waiting list");
  // Escape races the save on purpose; reconciliation must still finish.
  await dismissTopDialog(page);

  await expect
    .poll(() => ipcCount(page, "mutate_coding_edge"), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // The passage is now coded — its label no longer carries the suffix.
  const passages = page.getByRole("listbox", { name: "Transcript passages" });
  await expect(passages.getByRole("option", { name: new RegExp(`^${escapeRegExp(prefix)}\\b`) })).toBeVisible();
  await expect(
    page.getByRole("option", {
      name: new RegExp(`^${escapeRegExp(prefix)}\\b.*Not yet coded`),
    }),
  ).toHaveCount(0);

  expect(errors, JSON.stringify(errors)).toEqual([]);
});

test("rapid double-apply toggles cleanly instead of duplicating", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const { option, prefix } = await firstUncodedOption(page);
  await option.click();
  await openBubbleOn(page);

  await clickCodeChip(page, "Waiting list");
  // Second click lands while the first is still settling — the historical
  // duplicate-row trigger. A tick means membership, so two ticks cancel.
  await clickCodeChip(page, "Waiting list");
  await dismissTopDialog(page);

  await expect
    .poll(() => ipcCount(page, "mutate_coding_edge"), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);

  // Exactly net-zero: the passage ends exactly as it began, uncoded.
  await expect(
    page.getByRole("option", {
      name: new RegExp(`^${escapeRegExp(prefix)}\\b.*Not yet coded`),
    }),
  ).toBeVisible();

  expect(errors, JSON.stringify(errors)).toEqual([]);
});
