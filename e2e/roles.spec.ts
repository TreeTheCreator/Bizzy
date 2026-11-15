import { expect, test } from "@playwright/test";
import { type Person, chosen, createWorkspace, credentials, invite, pickAndSave, sidebarLinks, signUp } from "./helpers";

// The core promise of Bizzy, clicked through in a real browser: an invite
// carries no access, only the owner grants a role, and a member sees exactly
// the pages that role includes.

test.describe.configure({ mode: "serial" });

const ROLE_PICKER = "Role for Mel Member";
const NO_ROLE = "No role (sees nothing)";

let owner: Person;
let member: Person;
let workspaceId: string;

test.afterAll(async () => {
  await owner?.page.context().close();
  await member?.page.context().close();
});

test("the owner signs up and creates a workspace", async ({ browser }) => {
  owner = await signUp(browser, "Olive Owner");
  workspaceId = await createWorkspace(owner, "E2E Bakery");
  await expect(owner.page.getByRole("heading", { name: "E2E Bakery" })).toBeVisible();
  const links = await sidebarLinks(owner.page);
  for (const name of ["Tasks", "Docs", "Customers", "Money", "Settings"]) expect(links).toContain(name);
});

test("an invited person joins and sees nothing", async ({ browser }) => {
  const { email } = credentials("Mel Member");
  const invitePath = await invite(owner, workspaceId, email);

  // Sign up with exactly the invited address, landing back on the invite.
  member = await signUp(browser, "Mel Member", { email, next: invitePath });
  await member.page.getByRole("button", { name: "Join E2E Bakery" }).click();
  await expect(member.page.getByRole("heading", { name: "You're in, but can't see anything yet" })).toBeVisible();

  // Typing an address by hand shows nothing either.
  await member.page.goto(`/w/${workspaceId}/tasks`);
  await expect(member.page.getByText("can't see anything yet")).toBeVisible();
});

test("the owner creates a role and assigns it; the choice stays shown", async () => {
  const page = owner.page;
  await page.goto(`/w/${workspaceId}/settings/roles`);
  await page.getByPlaceholder("Shop assistant").fill("Sales");
  await page.locator('select[name="level_tasks"]').selectOption("edit");
  await page.locator('select[name="level_crm"]').selectOption("edit");
  await page.getByRole("button", { name: "Create role" }).click();
  await expect(page.getByText("Sales").first()).toBeVisible();

  await page.goto(`/w/${workspaceId}/settings/members`);
  await expect(chosen(page, ROLE_PICKER)).toHaveText(NO_ROLE);
  await pickAndSave(page, ROLE_PICKER, "Sales");
  // Regression: the drop-down used to snap back to the old value after saving.
  await expect(chosen(page, ROLE_PICKER)).toHaveText("Sales");
  await page.reload();
  await expect(chosen(page, ROLE_PICKER)).toHaveText("Sales");
});

test("the member sees only the pages in their role", async () => {
  const page = member.page;
  await page.goto(`/w/${workspaceId}`);
  const links = await sidebarLinks(page);
  expect(links).toContain("Tasks");
  expect(links).toContain("Customers");
  for (const hidden of ["Docs", "Money", "Settings"]) expect(links).not.toContain(hidden);

  for (const path of ["finance", "docs", "settings", "settings/members"]) {
    await page.goto(`/w/${workspaceId}/${path}`);
    await expect(page.getByRole("heading", { name: "You can't open this page" })).toBeVisible();
  }

  // What the role allows really works.
  await page.goto(`/w/${workspaceId}/tasks`);
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "What needs doing?" }).fill("Call the flour supplier");
  await page.getByRole("dialog").getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("link", { name: "Call the flour supplier" })).toBeVisible();
});

test("taking the role away hides everything again, straight away", async () => {
  await owner.page.goto(`/w/${workspaceId}/settings/members`);
  await pickAndSave(owner.page, ROLE_PICKER, NO_ROLE);
  await expect(chosen(owner.page, ROLE_PICKER)).toHaveText(NO_ROLE);

  await member.page.goto(`/w/${workspaceId}/tasks`);
  await expect(member.page.getByText("can't see anything yet")).toBeVisible();
});
