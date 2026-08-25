import { test, expect, type Locator, type Page } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";

async function stableScrollTop(
  page: Page,
  transcriptScroller: Locator,
  threshold: number,
): Promise<number> {
  await expect
    .poll(
      async () => {
        await transcriptScroller.hover();
        await page.mouse.wheel(0, 600);
        return transcriptScroller.evaluate((el) => el.scrollTop);
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(threshold);
  let previous = -1;
  await expect
    .poll(
      async () => {
        const value = await transcriptScroller.evaluate((el) => el.scrollTop);
        const stable = value === previous;
        previous = value;
        return stable;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return transcriptScroller.evaluate((el) => el.scrollTop);
}

test.describe("Transcript scroll and live-sync selection", () => {
  test("Sync now does not resurrect a cleared selection after a deep scroll", async ({
    page,
  }) => {
    await gotoApp(page, "/?fixture=stress");
    await openWorkspace(page);

    const transcriptScroller = page.locator('[data-testid="transcript-scroller"]');
    const passages = page.getByRole("listbox", { name: "Transcript passages" });
    await expect(passages).toBeVisible();

    const baseline = await stableScrollTop(page, transcriptScroller, 10_000);
    const box = await transcriptScroller.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.mouse.click(box.x + 12, box.y + box.height / 2);
    expect(await passages.getAttribute("aria-activedescendant")).toBeNull();
    const afterClear = await transcriptScroller.evaluate((el) => el.scrollTop);
    expect(Math.abs(afterClear - baseline)).toBeLessThanOrEqual(1);

    const syncChip = page.getByRole("button", { name: /to send|Synced/ });
    await syncChip.click();
    await page.getByRole("button", { name: "Sync now" }).click();
    await page.waitForTimeout(1_200);

    expect(await passages.getAttribute("aria-activedescendant")).toBeNull();
    const afterSync = await transcriptScroller.evaluate((el) => el.scrollTop);
    expect(Math.abs(afterSync - baseline)).toBeLessThanOrEqual(1);
  });
});
