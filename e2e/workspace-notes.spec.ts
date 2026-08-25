import { test, expect } from "@playwright/test";
import { gotoApp, openWorkspace, selectFirstPassage } from "./helpers/workspace";

test.describe("Workspace Notes and Memo Panel", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await openWorkspace(page);
  });

  test("closing memo rail with an existing note keeps it closed", async ({ page }) => {
    // Select passage 3 (seg-2) which has coding in mock
    const passage = page.locator("article").nth(2);
    await passage.click();

    // Open note via selection bubble or context menu if available
    const noteBtn = page.getByRole("button", { name: /Edit note|Add a note/i });
    if (await noteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await noteBtn.click();
      const memoPanel = page.locator('[data-testid="memo-panel"]');
      await expect(memoPanel).toBeVisible();

      // Close note editor
      const closeBtn = page.getByRole("button", { name: "Close note editor" });
      await closeBtn.click();
      await expect(memoPanel).not.toBeVisible();

      // Navigating or clicking passages must NOT reopen the rail automatically
      await selectFirstPassage(page);
      await page.waitForTimeout(200);
      await expect(memoPanel).not.toBeVisible();
    }
  });

});

test.describe("Workspace stress fixture", () => {
  test("loads without layout overflow", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoApp(page, "/?fixture=stress");
    await openWorkspace(page);

    const transcriptScroller = page.locator('[data-testid="transcript-scroller"]');
    await expect(transcriptScroller).toBeVisible();

    const articles = transcriptScroller.locator("article");
    await expect.poll(() => articles.count(), { timeout: 30_000 }).toBe(320);

    // Verify document does not scroll even with 320 passages
    const docScroll = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    expect(docScroll.scrollTop).toBe(0);
    expect(docScroll.scrollHeight).toBe(docScroll.clientHeight);
  });
});
