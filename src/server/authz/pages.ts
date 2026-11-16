/**
 * Pages (modules), access levels and owner-only actions.
 *
 * The page list must match public.app_pages() in the database. Access levels
 * are resolved in SQL (public.access_level); this file only names and compares them.
 */

export const PAGES = [
  "dashboard",
  "tasks",
  "docs",
  "crm",
  "finance",
  "hr",
  "ops",
  "marketing",
  "support",
  "settings",
] as const;
export type Page = (typeof PAGES)[number];

export const PAGE_LABELS: Record<Page, string> = {
  dashboard: "Dashboard",
  tasks: "Tasks",
  docs: "Docs",
  crm: "Customers",
  finance: "Money",
  hr: "HR",
  ops: "Operations",
  marketing: "Marketing",
  support: "Support",
  settings: "Settings",
};

/** Pages that have a working UI in the current phase. */
export const LIVE_PAGES: readonly Page[] = ["dashboard", "tasks", "docs", "crm", "finance", "hr", "settings"];

/** Live pages that are not a page inside a workspace: the dashboard is the cross-workspace overview at /overview. */
export const PAGES_OUTSIDE_WORKSPACE: readonly Page[] = ["dashboard"];

export const LEVELS = ["none", "view", "edit", "manage"] as const;
export type Level = (typeof LEVELS)[number];
/** The levels an action can require ("none" is not a requirement). */
export type PageAction = Exclude<Level, "none">;

const RANK: Record<Level, number> = { none: 0, view: 1, edit: 2, manage: 3 };

export function atLeast(have: Level | undefined, need: PageAction): boolean {
  return RANK[have ?? "none"] >= RANK[need];
}

/**
 * Actions no role level can ever reach. Only the workspace owner may perform
 * them, only from the web app, and (except reading the audit log) only right
 * after re-entering their password.
 */
export const OWNER_ACTIONS = [
  "roles.manage",
  "membership.set_role",
  "membership.remove",
  "ownership.transfer",
  "workspace.delete",
  "mcp.set_policy",
  "mcp.revoke_any",
  "audit.read",
  "billing.manage",
] as const;
export type OwnerAction = (typeof OWNER_ACTIONS)[number];

export type Action = PageAction | OwnerAction;

export function isOwnerAction(action: Action): action is OwnerAction {
  return (OWNER_ACTIONS as readonly string[]).includes(action);
}

/** Owner actions that do not need a fresh password confirmation. */
export const NO_REAUTH: ReadonlySet<OwnerAction> = new Set(["audit.read"]);
