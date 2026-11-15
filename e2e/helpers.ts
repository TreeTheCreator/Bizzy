import { randomBytes } from "node:crypto";
import { type Browser, type Page, expect } from "@playwright/test";

/** A person with their own browser session. */
export interface Person {
  name: string;
  email: string;
  page: Page;
}

/** A throwaway address and password for one test person. */
export function credentials(name: string): { email: string; password: string } {
  const slug = name.toLowerCase().replace(/\W+/g, "-");
  return {
    email: `${slug}-${randomBytes(4).toString("hex")}@e2e.bizzy.local`,
    password: `e2e-${randomBytes(9).toString("hex")}`,
  };
}

/** Create an account in a fresh browser session. `next` is where sign-up should land. */
export async function signUp(browser: Browser, name: string, options: { email?: string; next?: string } = {}): Promise<Person> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const generated = credentials(name);
  const email = options.email ?? generated.email;
  await page.goto(options.next ? `/sign-up?next=${encodeURIComponent(options.next)}` : "/sign-up");
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(generated.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/sign-up/);
  return { name, email, page };
}

/** Create a workspace and return its id. */
export async function createWorkspace(person: Person, name: string): Promise<string> {
  await person.page.goto("/workspaces");
  await person.page.getByPlaceholder("Business name").fill(name);
  await person.page.getByRole("button", { name: "Get started" }).click();
  await person.page.waitForURL(/\/w\/[0-9a-f-]{36}$/);
  return new URL(person.page.url()).pathname.split("/")[2];
}

/** The owner makes an invite link for an email address. Returns its path. */
export async function invite(owner: Person, workspaceId: string, email: string): Promise<string> {
  await owner.page.goto(`/w/${workspaceId}/settings/members`);
  await owner.page.getByRole("textbox", { name: "Email to invite" }).fill(email);
  await owner.page.getByRole("button", { name: "Get invite link" }).click();
  const link = owner.page.locator('input[readonly][value*="/invite/"]');
  await expect(link).toBeVisible();
  return new URL(await link.inputValue()).pathname;
}

/** Names of the links in the sidebar. */
export async function sidebarLinks(page: Page): Promise<string[]> {
  const names = await page.locator("aside a, nav a").allInnerTexts();
  return names.map((n) => n.split("\n")[0].trim());
}

/** The option a drop-down currently shows. */
export function chosen(page: Page, label: string) {
  return page.getByRole("combobox", { name: label }).locator("option:checked");
}

/**
 * Pick an option in a drop-down that saves by itself, and wait until the save
 * has finished and the page has settled. Checking any earlier would only see
 * the person's own click, not what the page shows afterwards.
 */
export async function pickAndSave(page: Page, label: string, option: string): Promise<void> {
  const saved = page.waitForResponse((response) => response.request().method() === "POST");
  await page.getByRole("combobox", { name: label }).selectOption({ label: option });
  await (await saved).finished();
  await page.waitForLoadState("networkidle");
}
