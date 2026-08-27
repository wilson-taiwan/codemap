import { test, expect } from "@playwright/test";
import {
  dismissTopDialog,
  gotoApp,
  openWorkspace,
} from "./helpers/workspace";
import { flushDiagnostics, watchPageDiagnostics } from "./helpers/diagnostics";

/**
 * Fault-injection journeys (E2E plan Task 4): the app must render a sane,
 * friendly state when the backend misbehaves — never a raw error, never a
 * silent success, and never an unhandled exception.
 */

let consoleLines: ReturnType<typeof watchPageDiagnostics>;

test.afterEach(async ({ page }, testInfo) => {
  await flushDiagnostics(page, testInfo, consoleLines);
});

function collectErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

async function openSyncSheet(page: import("@playwright/test").Page) {
  const sync = page
    .getByRole("button", {
      name: /to send|Synced|Syncing|Sync failed|Attention|Offline|Never synced|Sign in to sync|Not in a group/i,
    })
    .first();
  await expect(sync).toBeVisible({ timeout: 15_000 });
  await sync.click();
}

test("fixture=sync-error renders the failure as a friendly status", async ({
  page,
}) => {
  test.setTimeout(120_000);
  consoleLines = watchPageDiagnostics(page);
  const errors = collectErrors(page);

  await gotoApp(page, "/?fixture=sync-error");
  await openWorkspace(page);
  await openSyncSheet(page);

  const syncBtn = page.getByRole("button", { name: /Sync now/i });
  if (await syncBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await syncBtn.click();
  }

  // A polite failure appears — and it is not a raw network dump.
  const alert = page.getByRole("alert").first();
  await expect(alert).toBeVisible({ timeout: 20_000 });
  const text = ((await alert.textContent()) ?? "").trim();
  expect(text.length).toBeGreaterThan(0);
  expect(text.toLowerCase()).not.toContain("connection refused");

  // The sheet stays interactive and closable; the app did not wedge.
  await dismissTopDialog(page);
  expect(errors.filter((e) => !e.includes("[CI]"))).toEqual([]);
});

test("fixture=server-conflict surfaces the conflict and stays usable", async ({
  page,
}) => {
  test.setTimeout(120_000);
  consoleLines = watchPageDiagnostics(page);
  const errors = collectErrors(page);

  await gotoApp(page, "/?fixture=server-conflict");
  await openWorkspace(page);
  await openSyncSheet(page);

  // The chip-labelled conflicts surface inside the sheet, naming the entity.
  const conflictRegion = page
    .getByText(/unresolved conflict/i)
    .first();
  await expect(conflictRegion).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("Anticipatory rehearsal").first(),
  ).toBeVisible();

  // Resolution controls exist; the sheet remains responsive afterwards.
  await dismissTopDialog(page);
  expect(errors).toEqual([]);
});

test("fixture=auth-error shows actionable copy and never advances", async ({
  page,
}) => {
  test.setTimeout(120_000);
  consoleLines = watchPageDiagnostics(page);
  const errors = collectErrors(page);

  await gotoApp(page, "/?fixture=auth-error");

  // Open settings and sign out first if already signed in
  const settingsBtn = page
    .getByRole("button", { name: /Settings|ada@example\.com/i })
    .first();
  await settingsBtn.click();
  const settingsContainer = page.getByRole("dialog").last();
  await expect(settingsContainer).toBeVisible();

  const signOut = settingsContainer.getByRole("button", {
    name: "Sign out of Codemap",
  });
  if (await signOut.isVisible({ timeout: 2000 }).catch(() => false)) {
    await signOut.click();
  }

  await settingsContainer.getByRole("button", {
    name: "I already have one",
  }).click();
  await expect(
    settingsContainer.getByRole("button", { name: "Sign in" }),
  ).toBeVisible();

  await settingsContainer.getByLabel(/Email/i).fill("ada@example.com");
  await settingsContainer.getByLabel(/^Password/i).fill("wrong-password-1");
  await settingsContainer.getByRole("button", { name: "Sign in" }).click();

  // Supabase's invalid-credentials branch becomes plain guidance.
  await expect(settingsContainer.getByRole("alert")).toContainText(
    /Invalid login credentials|check your email or password/i,
    { timeout: 20_000 },
  );

  // The form stays on sign-in and does not advance.
  await expect(settingsContainer.getByLabel(/Email/i)).toBeVisible();

  expect(errors).toEqual([]);
});

test("fixture=slow reconciles when the dialog is dismissed mid-save", async ({
  page,
}) => {
  test.setTimeout(120_000);
  consoleLines = watchPageDiagnostics(page);
  const errors = collectErrors(page);

  await gotoApp(page, "/?fixture=slow");
  await openWorkspace(page);

  const passages = page.getByRole("listbox", { name: "Transcript passages" });
  const option = passages
    .getByRole("option", { name: /Not yet coded/ })
    .first();
  await expect(option).toBeVisible();
  const prefix = ((await option.getAttribute("aria-label")) ?? "")
    .split("—")[0]
    .trim();

  await option.click();
  await page.keyboard.press("c");
  const bubble = page.getByRole("dialog", { name: "Code this selection" });
  await expect(bubble).toBeVisible();

  await bubble.getByRole("textbox", { name: "Find or create a code" }).fill("Late diagnosis");
  await bubble.getByRole("button", { name: /^Late diagnosis/ }).first().click({
    force: true,
  });
  // Dismiss while the slowed save is still in flight.
  await page.keyboard.press("Escape");

  // The in-flight save still lands once it resolves.
  await expect(
    page.getByRole("option", {
      name: new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
    }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("option", {
      name: new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b.*Not yet coded`),
    }),
  ).toHaveCount(0);

  expect(errors).toEqual([]);
});
