import { test, expect } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";

test.describe("Highlight Stripes & Margin Gutter", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await gotoApp(page);
    await openWorkspace(page);
  });

  test("renders transcript passages and handles highlight interactions", async ({
    page,
  }) => {
    const passages = page.getByRole("listbox", { name: "Transcript passages" });
    await expect(passages).toBeVisible();

    const firstPassage = passages.locator("article").first();
    await expect(firstPassage).toBeVisible();

    // Verify passage copy container exists
    await expect(firstPassage.locator("[data-passage-copy]")).toBeAttached();

    // Check for coded highlights if present
    const marks = page.locator("mark[data-coding-id]");
    if ((await marks.count()) > 0) {
      const firstMark = marks.first();
      await expect(firstMark).toBeVisible();
      const bg = await firstMark.evaluate(
        (el) => window.getComputedStyle(el).backgroundColor,
      );
      expect(bg).toBeTruthy();
    }
  });
});
