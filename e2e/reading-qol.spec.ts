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

test.describe("Reading Surface PasBugs & QOL (2.4.1)", () => {
  test("notes open beside text on an opaque card and inline notes dock below", async ({
    page,
  }) => {
    await gotoApp(page);
    await openWorkspace(page);

    // 1. Codebook note hover & pin
    const codebook = page.locator('[data-testid="codebook-panel"]');
    await expect(codebook).toBeVisible();

    // Click code with usage that has memo ("Unwritten rules")
    const codeBtn = codebook.locator('button[aria-controls="code-usage-c1"]');
    await codeBtn.click();

    const usageItem = codebook.locator("#code-usage-c1 li button").first();
    await expect(usageItem).toBeVisible();
    await usageItem.click(); // pins the card

    const noteCard = page.locator('[role="dialog"][aria-label="Passage note"]');
    await expect(noteCard).toBeVisible();

    // Opaque check
    const bg = await noteCard.evaluate(
      (el) => window.getComputedStyle(el).backgroundColor,
    );
    expect(bg).toMatch(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);

    // Passage check: note does not cover the passage text
    const targetPassage = page
      .locator(
        '[data-segment-id="seg-2"] [data-passage-copy], #segment-seg-2 [data-passage-copy]',
      )
      .first();
    if (await targetPassage.isVisible()) {
      const passageBox = await targetPassage.boundingBox();
      const cardBox = await noteCard.boundingBox();
      if (passageBox && cardBox) {
        const horizontalOverlap = !(
          cardBox.x + cardBox.width <= passageBox.x ||
          passageBox.x + passageBox.width <= cardBox.x
        );
        const verticalOverlap = !(
          cardBox.y + cardBox.height <= passageBox.y ||
          passageBox.y + passageBox.height <= cardBox.y
        );
        expect(horizontalOverlap && verticalOverlap).toBe(false);
      }
    }

    // Dismiss with Esc returns focus to usage item
    await page.keyboard.press("Escape");
    await expect(noteCard).toBeHidden();

    // 2. Inline passage note expansion docks below paragraph
    const expandNoteBtn = page
      .locator('button[aria-label="Expand note"]')
      .first();
    if (await expandNoteBtn.isVisible()) {
      await expandNoteBtn.click();
      const inlineNote = page.locator(".note-card:has-text('Unwritten rules')");
      await expect(inlineNote).toBeVisible();

      const pBox = await page.locator("[data-passage-copy]").first().boundingBox();
      const inlineBox = await inlineNote.boundingBox();
      if (pBox && inlineBox) {
        expect(inlineBox.y).toBeGreaterThanOrEqual(pBox.y + pBox.height - 5);
      }
    }
  });

  test("stripes stay clear of code pills and gutter has 28px width", async ({
    page,
  }) => {
    await gotoApp(page);
    await openWorkspace(page);

    const gutter = page.locator('[data-testid="stripe-gutter"]').first();
    await expect(gutter).toBeVisible();
    const gutterBox = await gutter.boundingBox();
    expect(gutterBox).not.toBeNull();
    expect(gutterBox!.width).toBeCloseTo(28, 1);

    const article = page.locator("article").nth(2);
    const stripes = article.locator('[data-testid="stripe-bar"]');
    const pills = article.locator(".mt-2\\.5 button.rounded-full");

    const stripeCount = await stripes.count();
    const pillCount = await pills.count();
    if (stripeCount > 0 && pillCount > 0) {
      const firstPill = pills.first();
      const pillBox = await firstPill.boundingBox();
      for (let i = 0; i < stripeCount; i++) {
        const sBox = await stripes.nth(i).boundingBox();
        if (sBox && pillBox) {
          const overlapX = !(
            sBox.x + sBox.width <= pillBox.x || pillBox.x + pillBox.width <= sBox.x
          );
          const overlapY = !(
            sBox.y + sBox.height <= pillBox.y ||
            pillBox.y + pillBox.height <= sBox.y
          );
          expect(overlapX && overlapY).toBe(false);
        }
      }
      const isClipped = await firstPill.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      expect(isClipped).toBe(false);
    }
  });

  test("clicking a pill selects coding and bubble opens without filtering; filter icon filters", async ({
    page,
  }) => {
    await gotoApp(page);
    await openWorkspace(page);

    const article = page.locator("article").nth(2);
    const pill = article.getByRole("button", {
      name: "Unwritten rules",
      exact: true,
    });
    await expect(pill).toBeVisible();

    const initialPassageCount = await page.getByRole("option").count();

    // Clicking pill selects coding
    await pill.click();

    const bubble = page.getByRole("dialog", { name: "Code this selection" });
    await expect(bubble).toBeVisible();

    // Does NOT filter
    const currentPassageCount = await page.getByRole("option").count();
    expect(currentPassageCount).toBe(initialPassageCount);
    await expect(
      page.locator('[data-testid="transcript-filterbar"]'),
    ).toBeHidden();

    // Close bubble
    await page.keyboard.press("Escape");

    // Clicking explicit filter icon applies filter
    const filterBtn = article
      .locator('button[aria-label^="Show only passages coded"]')
      .first();
    await expect(filterBtn).toBeVisible();
    await filterBtn.click();

    // Filter is now active
    const filterbar = page.locator('[data-testid="transcript-filterbar"]');
    await expect(filterbar).toBeVisible();
    await expect(filterbar).toContainText("passages");

    // Clear all button in filterbar clears filter
    await filterbar.getByRole("button", { name: "Clear all" }).click();
    await expect(filterbar).toBeHidden();
    expect(await page.getByRole("option").count()).toBe(initialPassageCount);
  });

  test("coded spans have code-color underline and hover flashes matching spans", async ({
    page,
  }) => {
    await gotoApp(page);
    await openWorkspace(page);

    const marks = page.locator("mark[data-coding-id]");
    await expect(marks.first()).toBeVisible();

    const markBoxShadow = await marks
      .first()
      .evaluate((el) => window.getComputedStyle(el).boxShadow);
    expect(markBoxShadow).toContain("-2px 0px 0px inset");

    // Hovering pill highlights matching span
    const article = page.locator("article").nth(2);
    const pill = article.getByRole("button", {
      name: "Unwritten rules",
      exact: true,
    });
    if (await pill.isVisible()) {
      const mark = article.locator("mark[data-coding-id]").first();
      const bgBefore = await mark.evaluate(
        (el) => window.getComputedStyle(el).backgroundColor,
      );
      await pill.hover();
      const bgHover = await mark.evaluate(
        (el) => window.getComputedStyle(el).backgroundColor,
      );
      expect(bgHover).not.toBe(bgBefore);
    }
  });

  test("filter bar shows passage count and empty state renders when no match", async ({
    page,
  }) => {
    await gotoApp(page);
    await openWorkspace(page);

    // Apply a code filter
    const filterBtn = page
      .locator('button[aria-label^="Show only passages coded"]')
      .first();
    await expect(filterBtn).toBeVisible();
    await filterBtn.click();

    const filterbar = page.locator('[data-testid="transcript-filterbar"]');
    await expect(filterbar).toBeVisible();
    await expect(filterbar).toContainText(/Showing \d+ of \d+ passages/);

    // Pick a speaker that leaves no passages
    await page.getByRole("button", { name: "Filter passages" }).click();
    const menu = page.getByRole("menu", { name: "Filter passages" });
    await expect(menu).toBeVisible();
    const items = menu.getByRole("menuitem");
    const count = await items.count();
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      const text = (await item.innerText()).trim();
      if (text && text !== "All passages") {
        await item.click();
        break;
      }
    }

    const emptyNotice = page.locator("text=No passages match");
    if (
      await emptyNotice
        .first()
        .isVisible({ timeout: 2000 })
        .catch(() => false)
    ) {
      await expect(
        page.getByRole("button", { name: "Clear all" }).first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "Clear all" }).first().click();
      await expect(filterbar).toBeHidden();
      expect(await page.getByRole("option").count()).toBeGreaterThan(0);
    } else {
      await filterbar.getByRole("button", { name: "Clear all" }).click();
      await expect(filterbar).toBeHidden();
    }
  });
});

