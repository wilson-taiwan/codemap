import { test, expect } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";

test.describe("Silent Protocol 2 activation and sanitized sync status", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await gotoApp(page);
    await openWorkspace(page);
  });

  test("default mock auto-activates and the sheet shows only friendly status", async ({
    page,
  }) => {
    const syncChip = page.getByRole("button", { name: /Sync/i }).first();
    await syncChip.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByText(/Study & sync|Sync Health & Diagnostics/i),
    ).toBeVisible();

    // Protocol 2 state is silent and active.
    await expect(
      drawer.getByText("Real-time collaboration active"),
    ).toBeVisible({ timeout: 20_000 });

    // No activation UI, no protocol headings, no old-version copy.
    await expect(drawer.getByText(/Sync Protocol 2/i)).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: /Activate/i })).toHaveCount(0);
    await expect(drawer.getByText(/0\.27/i)).toHaveCount(0);
    await expect(drawer.getByText(/irreversible/i)).toHaveCount(0);
    await expect(drawer.getByText(/Active · generation/i)).toHaveCount(0);
  });

  test("expanded Technical details expose raw protocol state for support", async ({
    page,
  }) => {
    const syncChip = page.getByRole("button", { name: /Sync/i }).first();
    await syncChip.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    await drawer.getByText("Technical details").click();
    await expect(drawer.getByText(/Sync protocol: 2/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(drawer.getByText(/Generation: 00000002/)).toBeVisible();
    await expect(drawer.getByText(/Server head: 0/)).toBeVisible();
  });
});

test.describe("Not-ready study stays passive on Protocol 1", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await gotoApp(page, "/?fixture=sync-not-ready");
    await openWorkspace(page);
  });

  test("shows the passive 'turns on automatically' status with no action", async ({
    page,
  }) => {
    const syncChip = page.getByRole("button", { name: /Sync/i }).first();
    await syncChip.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    await expect(
      drawer.getByText(/Real-time collaboration turns on automatically/i),
    ).toBeVisible({ timeout: 20_000 });

    await expect(drawer.getByRole("button", { name: /Activate/i })).toHaveCount(0);
    await expect(drawer.getByText(/Sync Protocol 2/i)).toHaveCount(0);
    await expect(drawer.getByText("Real-time collaboration active")).toHaveCount(0);

    // Diagnostics still show the raw legacy state for support.
    await drawer.getByText("Technical details").click();
    await expect(drawer.getByText(/Sync protocol: Legacy \(1\)/)).toBeVisible();
    await expect(drawer.getByText(/Generation:/)).toHaveCount(0);
    await expect(drawer.getByText(/Server head:/)).toHaveCount(0);
  });
});
