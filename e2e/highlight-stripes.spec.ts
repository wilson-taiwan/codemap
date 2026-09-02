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

    // Check for coded highlights unconditionally
    const marks = page.locator("mark[data-coding-id]");
    await expect(marks.first()).toBeVisible();
    const markCount = await marks.count();
    expect(markCount).toBeGreaterThan(0);

    const firstMark = marks.first();
    const bg = await firstMark.evaluate(
      (el) => window.getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBeTruthy();
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");

    // Check for gutter stripes unconditionally
    const gutter = page.locator('[data-testid="stripe-gutter"]');
    await expect(gutter.first()).toBeVisible();

    const stripes = page.locator('[data-testid="stripe-bar"]');
    await expect(stripes.first()).toBeVisible();
    const stripeCount = await stripes.count();
    expect(stripeCount).toBeGreaterThan(0);

    // Record stripe geometry baseline
    const firstStripe = stripes.first();
    const box = await firstStripe.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(0);
    expect(box!.width).toBeGreaterThan(0);
  });

  test("search highlights in place without hiding passages or altering stripe geometry", async ({
    page,
  }) => {
    const passages = page.getByRole("listbox", { name: "Transcript passages" });
    const initialPassageCount = await passages.getByRole("option").count();
    expect(initialPassageCount).toBe(12);

    // Baseline stripe height and top before search
    const stripes = page.locator('[data-testid="stripe-bar"]');
    const firstStripe = stripes.first();
    const boxBefore = await firstStripe.boundingBox();
    expect(boxBefore).not.toBeNull();

    // Type search query
    const searchBox = page.getByRole("searchbox", { name: "Search transcript" });
    await searchBox.fill("written");

    // All passages remain visible (search does not filter away passages)
    await expect(passages.getByRole("option")).toHaveCount(initialPassageCount);

    // Matches are highlighted in place
    const matchMarks = page.locator('[data-is-match="true"]');
    await expect(matchMarks.first()).toBeVisible();
    const matchCount = await matchMarks.count();
    expect(matchCount).toBeGreaterThan(0);

    // Active match exists
    const currentMatch = page.locator('[data-current-match="true"]');
    await expect(currentMatch.first()).toBeVisible();

    // Gutter stripe geometry remains identical with search active
    const boxAfter = await firstStripe.boundingBox();
    expect(boxAfter).not.toBeNull();
    expect(boxAfter!.top).toBe(boxBefore!.top);
    expect(boxAfter!.height).toBe(boxBefore!.height);

    // Press Enter to advance to next match
    await searchBox.press("Enter");
    await expect(currentMatch.first()).toBeVisible();

    // Focus via keyboard shortcut (Cmd+F / Ctrl+F)
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+f" : "Control+f");
    await expect(searchBox).toBeFocused();
  });
});

