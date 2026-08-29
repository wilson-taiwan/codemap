import { test, expect } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";
import { flushDiagnostics, watchPageDiagnostics } from "./helpers/diagnostics";

/**
 * Keyboard-only pass (E2E plan Task 4): reach the transcript, move between
 * passages, and apply a code using only the keyboard. Focus must never strand
 * on <body> and no error may surface.
 */

let consoleLines: ReturnType<typeof watchPageDiagnostics>;

test.beforeEach(async ({ page }) => {
  test.setTimeout(90_000);
  consoleLines = watchPageDiagnostics(page);
  await gotoApp(page);
  await openWorkspace(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await flushDiagnostics(page, testInfo, consoleLines);
});

test("keyboard-only traversal reaches a passage and applies a code", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Walk the workspace with Tab; focus must never strand on <body>.
  for (let step = 0; step < 18; step += 1) {
    await page.keyboard.press("Tab");
    const tag = await page.evaluate(() => document.activeElement?.tagName ?? "NONE");
    expect(tag, `focus stranded at step ${step}`).not.toBe("BODY");
  }

  // Focus the transcript list and pick the first uncoded passage.
  const passages = page.getByRole("listbox", { name: "Transcript passages" });
  await passages.focus();
  const option = passages
    .getByRole("option", { name: /Not yet coded/ })
    .first();
  await option.focus();
  await expect(option).toBeFocused();

  const prefix = escapeRegExp(
    ((await option.getAttribute("aria-label")) ?? "").split("—")[0].trim(),
  );

  // Enter selects it as the coding target; "c" opens the bubble.
  await page.keyboard.press("Enter");
  await page.keyboard.press("c");
  const bubble = page.getByRole("dialog", { name: "Code this selection" });
  await expect(bubble).toBeVisible();

  await bubble
    .getByRole("textbox", { name: "Find or create a code" })
    .fill("Waiting list");
  const chip = bubble
    .getByRole("button", { name: /^Waiting list/ })
    .first();
  await chip.focus();
  await expect(chip).toBeFocused();
  await page.keyboard.press("Enter"); // Enter activates a focused button too
  await page.keyboard.press("Escape");

  // The coding landed without a single pointer event in this test.
  await expect(
    page.getByRole("option", {
      name: new RegExp(`^${prefix}\\b.*Not yet coded`),
    }),
  ).toHaveCount(0);

  expect(errors).toEqual([]);
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
