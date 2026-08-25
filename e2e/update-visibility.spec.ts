import { expect, test } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";

test.describe("v0.27 update action visibility", () => {
  test("remains reachable in narrow home and workspace top chrome", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    await gotoApp(page);

    const homeAction = page.getByRole("button", { name: /Update: Check for updates/i });
    await expect(homeAction).toBeVisible();
    await expect(homeAction).toBeInViewport();

    await openWorkspace(page);
    const workspaceAction = page.getByRole("button", { name: /Update: Check for updates/i });
    await expect(workspaceAction).toBeVisible();
    await expect(workspaceAction).toBeInViewport();
  });
});
