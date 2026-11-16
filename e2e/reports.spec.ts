import { expect, test } from "@playwright/test";
import { createWorkspace, signUp } from "./helpers";

// Reports in a real browser: the owner opens a report, changes the period,
// saves it under a name and finds it again.

test("the owner runs, saves and removes a report", async ({ browser }) => {
  const owner = await signUp(browser, "Rita Owner");
  const workspaceId = await createWorkspace(owner, "E2E Reports");
  const page = owner.page;

  // Something to report on: one expense.
  await page.goto(`/w/${workspaceId}/finance?view=expenses`);
  await page.getByRole("button", { name: "Add an expense" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("0.00").fill("42.50");
  await dialog.getByPlaceholder("Rent, Supplies, Software…").fill("Supplies");
  await dialog.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByRole("cell", { name: "$42.50" })).toBeVisible();

  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Money in and out" })).toBeVisible();
  for (const name of ["Spending by category", "Deals by stage", "Tasks by person", "Time off by person"]) {
    await expect(page.getByRole("link", { name })).toBeVisible();
  }

  await page.getByRole("link", { name: "Spending by category" }).click();
  await expect(page.getByRole("heading", { name: "Spending by category" })).toBeVisible();
  const row = page.getByRole("row", { name: /Supplies/ });
  await expect(row).toContainText("$42.50");

  await page.getByRole("link", { name: "This year" }).click();
  await expect(page).toHaveURL(/period=this_year/);
  await expect(row).toContainText("$42.50");

  await page.getByRole("textbox", { name: "Save this report as" }).fill("Yearly spending");
  await page.getByRole("button", { name: "Save report" }).click();
  const saved = page.getByRole("link", { name: /Yearly spending/ });
  await expect(saved).toBeVisible();
  await expect(saved).toHaveAttribute("href", /kind=spending_by_category&period=this_year/);

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download as spreadsheet" }).click();
  expect((await download).suggestedFilename()).toMatch(/^spending_by_category-\d{4}-01-01-to-\d{4}-12-31\.csv$/);

  await page.getByRole("button", { name: "Remove Yearly spending" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(saved).toHaveCount(0);
  await page.context().close();
});
