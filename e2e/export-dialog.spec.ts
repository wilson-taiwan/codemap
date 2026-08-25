import { test, expect } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";

test.describe("Export Dialog & Presets", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await gotoApp(page);
    await openWorkspace(page);
  });

  test("opens export dialog, switches presets, and reflects custom selection", async ({
    page,
  }) => {
    // Click Export... in toolbar
    const exportBtn = page.getByRole("button", { name: "Export…" });
    await expect(exportBtn).toBeVisible();
    await exportBtn.click();

    // Dialog should be open
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Export Study Data & Reports")).toBeVisible();

    // Verify Reflexive TA default preset is selected
    const reflexiveCard = dialog.getByRole("radio", {
      name: /Reflexive Thematic Analysis/i,
    });
    await expect(reflexiveCard).toBeVisible();
    await expect(dialog.getByText("report.html")).toBeVisible();
    await expect(dialog.getByText("report.pdf")).toBeVisible();
    await expect(dialog.getByText("coded-segments.csv")).toBeVisible();

    // Switch to Framework Analysis preset
    const frameworkCard = dialog.getByRole("radio", {
      name: /Framework Analysis/i,
    });
    await frameworkCard.click();

    // Should now preview framework-matrix.csv
    await expect(dialog.getByText("framework-matrix.csv")).toBeVisible();

    // Toggle a checkbox to make it Custom
    const countsCheckbox = dialog.getByRole("checkbox", {
      name: "Coding frequencies & corpus breadth",
    });
    await countsCheckbox.click(); // toggle off

    // Should display Custom Configuration badge
    await expect(dialog.getByText("Custom Configuration")).toBeVisible();

    // Click Cancel to dismiss
    const cancelBtn = dialog.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();
    await expect(dialog).not.toBeVisible();
  });
});
