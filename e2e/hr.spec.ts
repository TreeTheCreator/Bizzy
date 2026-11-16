import { expect, test } from "@playwright/test";
import { type Person, createRole, createWorkspace, credentials, invite, pickAndSave, signUp } from "./helpers";

// HR in a real browser: the owner adds a person and their pay; a member whose
// role includes HR but not its private details sees the person and no pay.

test.describe.configure({ mode: "serial" });

let owner: Person;
let member: Person;
let workspaceId: string;

test.afterAll(async () => {
  await owner?.page.context().close();
  await member?.page.context().close();
});

test("the owner adds a person, their pay and time off", async ({ browser }) => {
  owner = await signUp(browser, "Hana Owner");
  workspaceId = await createWorkspace(owner, "E2E Bakery HR");
  const page = owner.page;

  await page.getByRole("link", { name: "HR", exact: true }).click();
  await page.getByRole("button", { name: "Add a person" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Full name" }).fill("Ada Baker");
  await dialog.getByRole("textbox", { name: "Job (optional)" }).fill("Head baker");
  await dialog.getByRole("button", { name: "Add person" }).click();
  const row = page.getByRole("row", { name: /Ada Baker/ });
  await expect(row).toContainText("Head baker");
  await expect(row).toContainText("Not entered");

  await row.getByRole("button", { name: "Pay" }).click();
  await page.getByRole("dialog").getByRole("spinbutton", { name: "Amount" }).fill("52000");
  await page.getByRole("dialog").getByRole("button", { name: "Save pay" }).click();
  await expect(row).toContainText("$52,000.00 a year");

  await page.getByRole("link", { name: "Time off" }).click();
  await page.getByRole("button", { name: "Ask for time off" }).first().click();
  const leave = page.getByRole("dialog");
  await leave.getByRole("combobox", { name: "Who is it for?" }).selectOption({ label: "Ada Baker" });
  await leave.getByLabel("First day off").fill("2027-02-01");
  await leave.getByLabel("Last day off").fill("2027-02-05");
  await leave.getByRole("button", { name: "Send request" }).click();
  const request = page.getByRole("row", { name: /Ada Baker/ });
  await expect(request).toContainText("Waiting for an answer");
  await expect(request).toContainText("5 days");
  await request.getByRole("button", { name: "Approve time off for Ada Baker" }).click();
  await expect(request).toContainText("Approved");
});

test("a member without private details sees the person but no pay", async ({ browser }) => {
  const { email } = credentials("Cleo Clerk");
  const invitePath = await invite(owner, workspaceId, email);
  member = await signUp(browser, "Cleo Clerk", { email, next: invitePath });
  await member.page.getByRole("button", { name: "Join E2E Bakery HR" }).click();

  await createRole(owner, workspaceId, "HR clerk", { hr: "edit" });
  await owner.page.goto(`/w/${workspaceId}/settings/members`);
  await pickAndSave(owner.page, "Role for Cleo Clerk", "HR clerk");

  const page = member.page;
  await page.goto(`/w/${workspaceId}/hr`);
  await expect(page.getByRole("row", { name: /Ada Baker/ })).toContainText("Head baker");
  await expect(page.getByText("Your role does not include pay")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Pay" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pay" })).toHaveCount(0);
  await expect(page.getByText("52,000")).toHaveCount(0);
  expect(await page.content()).not.toContain("52000");

  // They can ask for time off but not decide it.
  await page.goto(`/w/${workspaceId}/hr?view=leave`);
  await expect(page.getByRole("row", { name: /Ada Baker/ })).toContainText("Approved");
  await expect(page.getByRole("button", { name: /Approve|Decline|Delete/ })).toHaveCount(0);
});
