import { test, expect } from "@playwright/test";
import { gotoApp, openWorkspace, dismissTopDialog } from "./helpers/workspace";
import { flushDiagnostics, watchPageDiagnostics } from "./helpers/diagnostics";

/**
 * Seeded "monkey" pass (E2E plan Task 4): a deterministic bounded random walk
 * over visible role-based controls. Zero pageerror and zero
 * "[dev-mock] unhandled command" across the whole run — with a fixed seed so a
 * failure reproduces exactly.
 */

const MONKEY_SEED = 20260826;
const MONKEY_STEPS = 40;

/** Deterministic PRNG (mulberry32) — same seed, same click sequence. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let consoleLines: ReturnType<typeof watchPageDiagnostics>;

test.beforeEach(async ({ page }) => {
  test.setTimeout(180_000);
  consoleLines = watchPageDiagnostics(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await flushDiagnostics(page, testInfo, consoleLines);
});

test("seeded random clicking never throws and never hits an unhandled command", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      msg.type() === "error" ||
      text.includes("[dev-mock] unhandled command")
    ) {
      problems.push(`console: ${text}`);
    }
  });

  const rng = makeRng(MONKEY_SEED);

  await gotoApp(page);
  await openWorkspace(page);

  for (let step = 0; step < MONKEY_STEPS; step += 1) {
    // Requery every step: prior clicks can detach or hide elements.
    const candidates = await page.evaluate(() => {
      const selectors = [
        "button",
        "[role='checkbox']",
        "[role='tab']",
        "[role='menuitem']",
      ];
      const found: { tag: string; label: string }[] = [];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (!(el instanceof HTMLElement)) continue;
          const style = window.getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            el.disabled ||
            el.getAttribute("aria-disabled") === "true"
          ) {
            continue;
          }
          const label =
            el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
          // Never let the monkey do something destructive.
          if (/delete|remove|reset|sign out|leave|discard|trash/i.test(label)) {
            continue;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          found.push({ tag: el.tagName.toLowerCase(), label });
        }
      }
      return found.slice(0, 60);
    });

    if (candidates.length === 0) break;

    const pick = candidates[Math.floor(rng() * candidates.length)];

    try {
      const target =
        pick.label.length > 0
          ? page
              .getByRole("button", { name: pick.label })
              .or(page.locator(`${pick.tag}:has-text("${pick.label}")`).first())
          : page.locator(pick.tag).first();
      await target.first().click({ timeout: 2000, force: true });

      // A dialog opened as a side effect? Leave it politely.
      const dialogVisible = await page
        .getByRole("dialog")
        .first()
        .isVisible()
        .catch(() => false);
      if (dialogVisible && rng() < 0.5) {
        await dismissTopDialog(page);
      }
    } catch {
      // A lost race against a detaching element is fine; the app surviving it
      // is the assertion. Individual click failures are not.
    }

    await page.waitForTimeout(120);
  }

  expect(problems, JSON.stringify(problems, null, 2)).toEqual([]);
});
