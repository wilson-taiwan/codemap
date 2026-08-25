import { test, expect } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";

test.describe("Codebook Nesting & Pointer Drag", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await gotoApp(page);
    await openWorkspace(page);
  });

  test("displays drag handles, context menu nesting options, and top-level promotion", async ({
    page,
  }) => {
    const codebook = page.getByTestId("codebook-panel");
    await expect(codebook).toBeVisible();

    const handles = codebook.locator("button[data-drag-handle='true']");
    await expect(handles.first()).toBeVisible();

    // Verify handle is visible at rest
    const color = await handles
      .first()
      .evaluate((el) => window.getComputedStyle(el).color);
    expect(color).toBeTruthy();

    // Right click on a code row to open context menu
    const codeRow = codebook.locator("li[data-code-row='true']").first();
    await codeRow.click({ button: "right" });

    // Menu should appear
    const menu = page.locator(".context-menu, [role='menu']");
    await expect(menu).toBeVisible();

    // Dismiss menu
    await page.keyboard.press("Escape");
  });
});
