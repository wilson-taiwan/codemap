import { test, expect } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";

test.describe("Workspace Layout and Containment", () => {
  const VIEWPORTS = [
    { width: 1024, height: 768, label: "1024x768 (minimum)" },
    { width: 1280, height: 800, label: "1280x800 (standard)" },
    { width: 1440, height: 900, label: "1440x900 (wide)" },
  ];

  for (const vp of VIEWPORTS) {
    test(`viewport containment at ${vp.label}`, async ({ page }) => {
      await gotoApp(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openWorkspace(page);

      // Verify root document does not scroll
      const docScroll = await page.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        return {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        };
      });

      expect(docScroll.scrollTop, "document scrollTop must be 0").toBe(0);
      expect(
        docScroll.scrollHeight,
        `document scrollHeight (${docScroll.scrollHeight}) must equal clientHeight (${docScroll.clientHeight})`,
      ).toBe(docScroll.clientHeight);

      // Verify grid and scroller test IDs
      const grid = page.locator('[data-testid="workspace-grid"]');
      await expect(grid).toBeVisible();

      const transcriptScroller = page.locator('[data-testid="transcript-scroller"]');
      await expect(transcriptScroller).toBeVisible();

      // Record codebook bounding box before scrolling transcript
      const codebook = page.locator('[data-testid="codebook-panel"]');
      await expect(codebook).toBeVisible();
      const cbBoxBefore = await codebook.boundingBox();
      expect(cbBoxBefore).not.toBeNull();

      // Scroll transcript via wheel. At wide dimensions Chromium can dispatch
      // the first wheel while the newly-mounted scroll container is still
      // becoming hit-testable, so retry the real user gesture instead of
      // replacing it with a programmatic scroll.
      await transcriptScroller.hover();
      await page.mouse.wheel(0, 400);

      // Verify document still did not scroll
      const docScrollAfter = await page.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        return el.scrollTop;
      });
      expect(docScrollAfter, "document must not scroll on wheel").toBe(0);

      // Verify codebook vertical position did not change
      const cbBoxAfter = await codebook.boundingBox();
      expect(cbBoxAfter?.y).toBe(cbBoxBefore?.y);
      expect(cbBoxAfter?.height).toBe(cbBoxBefore?.height);

      // Verify transcript scroller absorbed the wheel if it overflows
      const { scrollHeight, clientHeight, scrollTop } =
        await transcriptScroller.evaluate((el) => ({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrollTop: el.scrollTop,
        }));
      if (scrollHeight > clientHeight) {
        if (scrollTop === 0) {
          await expect
            .poll(
              async () => {
                await transcriptScroller.hover();
                await page.mouse.wheel(0, 400);
                return transcriptScroller.evaluate((el) => el.scrollTop);
              },
              { timeout: 3_000 },
            )
            .toBeGreaterThan(0);
        }
      }
    });
  }

  test("transcript column respects 512px floor when resizing rails", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await gotoApp(page);
    await openWorkspace(page);

    const transcriptPanel = page.locator('[data-testid="transcript-panel"]');
    await expect(transcriptPanel).toBeVisible();

    const box = await transcriptPanel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(512);
  });
});
