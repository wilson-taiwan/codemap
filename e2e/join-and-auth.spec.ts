import { test, expect } from "@playwright/test";
import { flushDiagnostics, watchPageDiagnostics } from "./helpers/diagnostics";
import { gotoApp } from "./helpers/workspace";

let consoleLines: ReturnType<typeof watchPageDiagnostics>;

test.beforeEach(async ({ page }) => {
  consoleLines = watchPageDiagnostics(page);
  await gotoApp(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await flushDiagnostics(page, testInfo, consoleLines);
});

test("join wizard gates Start coding until transcripts are linked", async ({
  page,
}) => {
  await page.getByRole("button", { name: /Join a study|Join with a key|Join a group/i }).click();
  const joinDialog = page.getByRole("dialog", { name: /Join a study|Join a group/i });
  await expect(joinDialog).toBeVisible();

  const existingAccount = joinDialog.getByRole("button", {
    name: "I already have one",
  });
  if (await existingAccount.isVisible().catch(() => false)) {
    await existingAccount.click();
    await joinDialog.getByLabel("Email").fill("sam@example.com");
    await joinDialog.getByLabel("Password", { exact: true }).fill("secret12");
    await joinDialog.getByRole("button", { name: "Sign in" }).click();
  }

  await expect(joinDialog.getByLabel(/Study key|Group key/i)).toBeVisible({ timeout: 15_000 });
  await joinDialog.getByLabel(/Study key|Group key/i).fill("ABCD-1234");
  await joinDialog.getByLabel(/Your (coder )?name/i).fill("Sam");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("button", { name: "Create copy" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create copy" }).click();

  await expect(page.getByText("Link your transcripts")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Start coding" })).toBeDisabled();
});

test("forgot-password flow accepts a short code paste", async ({ page }) => {
  await page.getByRole("button", { name: /ada@example.com|Sign in/ }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  const settingsContainer = page.getByLabel("Settings", { exact: true });

  const signOut = settingsContainer.getByRole("button", { name: "Sign out of Fleuron" });
  const alreadyHaveOne = settingsContainer.getByRole("button", { name: "I already have one" });

  await expect(signOut.or(alreadyHaveOne)).toBeVisible();
  if (await signOut.isVisible()) {
    await signOut.click();
  }

  await alreadyHaveOne.click();
  await settingsContainer.getByRole("button", { name: "Forgot password?" }).click();
  await settingsContainer.getByLabel("Email").fill("ada@example.com");
  await settingsContainer.getByRole("button", { name: "Send reset email" }).click();
  await expect(settingsContainer.getByLabel("Reset code")).toBeVisible();
  await settingsContainer.getByLabel("Reset code").fill("482193");
});
