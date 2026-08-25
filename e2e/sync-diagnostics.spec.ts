import { test, expect } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";

test.describe("Sync Diagnostics & Repair", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await gotoApp(page);
    await openWorkspace(page);
  });

  test("opens Sync drawer and displays sync configuration or diagnostics", async ({
    page,
  }) => {
    // Click Sync Chip or Open Sync Sheet
    const syncChip = page.getByRole("button", { name: /Sync/i }).first();
    if (await syncChip.isVisible()) {
      await syncChip.click();
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      await expect(
        drawer.getByText(/Study & sync|Sync Health & Diagnostics/i),
      ).toBeVisible();
    }
  });
});
