import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

// Business templates in a real browser: choosing a kind of business when
// creating it fills the new workspace with a starter kit.

test("a new cafe starts with tasks, ready-made lists and guide docs", async ({ browser }) => {
  const owner = await signUp(browser, "Tom Owner");
  const page = owner.page;

  await page.goto("/workspaces");
  await page.getByPlaceholder("Business name").fill("E2E Corner Cafe");
  await page.getByRole("combobox", { name: /What kind of business/ }).selectOption({ label: "Cafe or restaurant" });
  await page.getByRole("button", { name: "Get started" }).click();
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/);
  const base = new URL(page.url()).pathname;

  await page.goto(`${base}/tasks`);
  await expect(page.getByRole("link", { name: "Add your team under Settings, People" })).toBeVisible();
  await expect(page.getByText("Projects (1)")).toBeVisible();
  await expect(page.getByText("Ready-made task lists (3)")).toBeVisible();

  await page.goto(`${base}/docs`);
  await expect(page.getByRole("link", { name: "Suppliers" })).toBeVisible();
  await expect(page.getByRole("link", { name: "How we open and close" })).toBeVisible();
  await page.context().close();
});
