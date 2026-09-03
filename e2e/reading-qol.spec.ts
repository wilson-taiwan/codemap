import { test, expect } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";

test.describe("Reading QOL (2.4.0)", () => {
  test("shift-click extends the drag selection inside one passage", async ({
    page,
  }) => {
    await gotoApp(page);
    await openWorkspace(page);

    const passages = page.getByRole("listbox", { name: "Transcript passages" });
    await expect(passages).toBeVisible();
    const first = passages.getByRole("option").first();
    const para = first.locator("p");
    const box = await para.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    const y = box.y + 10;

    // Drag a partial phrase near the start of the passage. The stripe
    // gutter overlays the first ~20px, and the text starts after pl-6, so
    // begin well inside the words.
    await page.mouse.move(box.x + 60, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, y, { steps: 8 });
    await page.mouse.up();

    const bubble = page.getByRole("dialog", { name: "Code this selection" });
    await expect(bubble).toBeVisible({ timeout: 5_000 });
    const before = await bubble.locator("span").nth(1).innerText();

    // Shift+click near the end of the same passage extends, anchor fixed.
    // Aimed at the last line: the bubble sits by the selection on the first
    // line and would swallow a click it covers (overlay, not passage).
    await page.keyboard.down("Shift");
    await page.mouse.click(box.x + box.width - 60, box.y + box.height - 8);
    await page.keyboard.up("Shift");

    await expect(bubble).toBeVisible();
    const after = await bubble.locator("span").nth(1).innerText();
    expect(after.length).toBeGreaterThan(before.length);
    // Same opening words: the anchor edge did not move.
    expect(after.slice(0, 12)).toBe(before.slice(0, 12));
  });

  test("filtering keeps your place in the transcript", async ({ page }) => {
    await gotoApp(page, "/?fixture=stress");
    await openWorkspace(page);

    const passages = page.getByRole("listbox", { name: "Transcript passages" });
    await expect(passages).toBeVisible();
    const scroller = page.locator('[data-testid="transcript-scroller"]');

    const target = passages.getByRole("option").nth(160);
    await target.scrollIntoViewIfNeeded();
    await target.click();
    const selected = await passages.getAttribute("aria-activedescendant");
    expect(selected).not.toBeNull();
    const label =
      (await page.locator(`#${selected}`).getAttribute("aria-label")) ?? "";
    const speaker = label.split(": ").slice(1).join(": ");

    const scrolled = await scroller.evaluate((el) => el.scrollTop);
    expect(scrolled).toBeGreaterThan(500);

    // Pick a speaker that is NOT this passage's, so the filter hides it.
    await page.getByRole("button", { name: "Filter passages" }).click();
    const menu = page.getByRole("menu", { name: "Filter passages" });
    await expect(menu).toBeVisible();
    const speakerButtons = menu.getByRole("menuitem");
    const names = await speakerButtons.allInnerTexts();
    let other: string | null = null;
    for (const name of names) {
      const trimmed = name.trim();
      if (
        trimmed &&
        trimmed !== "All passages" &&
        trimmed !== speaker.trim()
      ) {
        other = trimmed;
        break;
      }
    }
    expect(other).not.toBeNull();
    await menu.getByRole("menuitem", { name: other! }).click();

    // Clearing the filter returns to the same passage and place. The chip
    // carries its clear affordance as a title, not its accessible name.
    const chip = page.locator('button[title="Clear speaker filter"]');
    await expect(chip).toBeVisible();
    await chip.click();

    await expect
      .poll(async () => passages.getAttribute("aria-activedescendant"), {
        timeout: 5_000,
      })
      .toBe(selected);
    const restored = await scroller.evaluate((el) => el.scrollTop);
    expect(Math.abs(restored - scrolled)).toBeLessThan(200);
  });

  test("zoom scales passage text only and resets", async ({ page }) => {
    await gotoApp(page);
    await openWorkspace(page);

    const passages = page.getByRole("listbox", { name: "Transcript passages" });
    await expect(passages).toBeVisible();

    const sizeOfFirstPassage = () =>
      page
        .locator("[data-passage-copy]")
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

    await expect(page.getByRole("button", { name: /Reset passage text size/ })).toHaveText("100%");
    expect(await sizeOfFirstPassage()).toBeCloseTo(15.5, 1);

    await page.getByRole("button", { name: "Increase passage text size" }).click();
    await expect(page.getByRole("button", { name: /Reset passage text size/ })).toHaveText("113%");
    expect(await sizeOfFirstPassage()).toBeCloseTo(15.5 * 1.125, 1);

    await page.getByRole("button", { name: /Reset passage text size/ }).click();
    await expect(page.getByRole("button", { name: /Reset passage text size/ })).toHaveText("100%");
    expect(await sizeOfFirstPassage()).toBeCloseTo(15.5, 1);
  });

  test("codebook collapses and restores its width", async ({ page }) => {
    await gotoApp(page);
    await openWorkspace(page);

    const grid = page.locator('[data-testid="workspace-grid"]');
    await expect(grid).toBeVisible();
    const expanded = await grid.evaluate((el) =>
      getComputedStyle(el).gridTemplateColumns,
    );

    await page.getByRole("button", { name: "Hide codebook" }).click();
    await expect(page.locator('[data-testid="codebook-panel"]')).toBeHidden();
    const collapsed = await grid.evaluate((el) =>
      getComputedStyle(el).gridTemplateColumns,
    );
    expect(collapsed).not.toBe(expanded);

    await page.getByRole("button", { name: "Show codebook" }).click();
    await expect(page.locator('[data-testid="codebook-panel"]')).toBeVisible();
    const restored = await grid.evaluate((el) =>
      getComputedStyle(el).gridTemplateColumns,
    );
    expect(restored).toBe(expanded);
  });
});
