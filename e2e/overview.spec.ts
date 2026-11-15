import { expect, test } from "@playwright/test";
import { type Person, createRole, createWorkspace, credentials, invite, pickAndSave, signUp } from "./helpers";

// The cross-workspace overview: an owner sees every page's numbers for each of
// their businesses; a member sees a business only once their role includes the
// Dashboard, and then only the pages that role includes.

test.describe.configure({ mode: "serial" });

let owner: Person;
let member: Person;
let first: string;

test.afterAll(async () => {
  await owner?.page.context().close();
  await member?.page.context().close();
});

test("the owner sees all their businesses, with totals", async ({ browser }) => {
  owner = await signUp(browser, "Opal Owner");
  first = await createWorkspace(owner, "E2E Cafe");
  await createWorkspace(owner, "E2E Garage");

  // One task in the first business.
  await owner.page.goto(`/w/${first}/tasks`);
  await owner.page.getByRole("button", { name: "New task" }).click();
  await owner.page.getByRole("dialog").getByRole("textbox", { name: "What needs doing?" }).fill("Order beans");
  await owner.page.getByRole("dialog").getByRole("button", { name: "Add task" }).click();
  await expect(owner.page.getByRole("link", { name: "Order beans" })).toBeVisible();

  await owner.page.goto("/workspaces");
  await owner.page.getByRole("link", { name: "At a glance" }).click();
  await expect(owner.page.getByRole("heading", { name: "All your businesses" })).toBeVisible();

  const cafe = owner.page.getByRole("region", { name: "E2E Cafe" });
  const garage = owner.page.getByRole("region", { name: "E2E Garage" });
  const together = owner.page.getByRole("region", { name: "Together" });
  for (const card of [cafe, garage, together]) {
    await expect(card.getByText("Tasks to do")).toBeVisible();
    await expect(card.getByText("Deals in progress")).toBeVisible();
    await expect(card.getByText("Waiting to be paid")).toBeVisible();
  }
  const tasksToDo = (card: typeof cafe) => card.locator("div", { hasText: /^Tasks to do/ }).locator("dd");
  await expect(tasksToDo(cafe)).toHaveText("1");
  await expect(tasksToDo(garage)).toHaveText("0");
  await expect(tasksToDo(together)).toHaveText("1");
});

test("a member sees a business only when their role includes the Dashboard", async ({ browser }) => {
  const { email } = credentials("Remy Member");
  const invitePath = await invite(owner, first, email);
  member = await signUp(browser, "Remy Member", { email, next: invitePath });
  await member.page.getByRole("button", { name: "Join E2E Cafe" }).click();

  // A role with Tasks but without the Dashboard: the overview stays empty.
  const page = owner.page;
  await createRole(owner, first, "Helper", { tasks: "view" });
  await page.goto(`/w/${first}/settings/members`);
  await pickAndSave(page, "Role for Remy Member", "Helper");

  await member.page.goto("/overview");
  await expect(member.page.getByRole("heading", { name: "Nothing to show here yet" })).toBeVisible();

  // A role with the Dashboard and Tasks: the business appears, with tasks only.
  await createRole(owner, first, "Lead", { dashboard: "view", tasks: "view" });
  await page.goto(`/w/${first}/settings/members`);
  await pickAndSave(page, "Role for Remy Member", "Lead");

  await member.page.goto("/overview");
  const cafe = member.page.getByRole("region", { name: "E2E Cafe" });
  await expect(cafe.getByText("Tasks to do")).toBeVisible();
  await expect(cafe.getByText("Deals in progress")).toHaveCount(0);
  await expect(cafe.getByText("Waiting to be paid")).toHaveCount(0);
  await expect(member.page.getByRole("region", { name: "E2E Garage" })).toHaveCount(0);
});
