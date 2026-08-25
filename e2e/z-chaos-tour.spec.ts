import { test, expect } from "@playwright/test";
import { flushDiagnostics, watchPageDiagnostics } from "./helpers/diagnostics";
import { dismissTopDialog, gotoApp, openWorkspace } from "./helpers/workspace";

const SAFE_CONTROLS = [
  "More actions",
  "Settings…",
  "Dark",
  "Light",
  "System",
  "Search transcript",
  "Active interview",
];

let consoleLines: ReturnType<typeof watchPageDiagnostics>;

test.beforeEach(async ({ page }) => {
  consoleLines = watchPageDiagnostics(page);
  await gotoApp(page);
  await openWorkspace(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await flushDiagnostics(page, testInfo, consoleLines);
});

test("click every reachable control without console errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      msg.type() === "error" ||
      text.includes("[dev-mock] unhandled command")
    ) {
      errors.push(text);
    }
  });

  for (const label of SAFE_CONTROLS) {
    const el = page.getByRole("button", { name: label }).or(
      page.getByRole("radio", { name: label }),
    ).or(page.getByRole("combobox", { name: label })).or(
      page.getByRole("searchbox", { name: label }),
    );
    if (!(await el.first().isVisible().catch(() => false))) continue;
    if (label === "More actions") {
      await el.first().click();
      continue;
    }
    if (label === "Settings…") {
      await page.getByRole("menuitem", { name: "Settings…" }).click();
      await page.getByRole("radio", { name: "Dark" }).click();
      await dismissTopDialog(page);
      continue;
    }
    await el.first().click({ timeout: 2000 }).catch(() => {});
    await dismissTopDialog(page);
    await page.keyboard.press("Escape").catch(() => {});
  }

  const ipcUnhandled = await page.evaluate(() => {
    const log = (window as unknown as { __CODEMAP_IPC_LOG__?: { ok: boolean; cmd: string }[] })
      .__CODEMAP_IPC_LOG__;
    return (log ?? []).filter((e) => !e.ok).map((e) => e.cmd);
  });

  expect(
    errors,
    `page errors during chaos tour: ${errors.join("; ")}`,
  ).toEqual([]);
  expect(ipcUnhandled, "unhandled dev-mock commands").toEqual([]);
});
