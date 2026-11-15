import type { Ctx } from "@/server/context";
import { unwrap } from "@/server/errors";

/** Headline numbers for one workspace. A section is null when the caller cannot view that page. */
export interface WorkspaceOverview {
  id: string;
  name: string;
  is_owner: boolean;
  tasks: { open: number; overdue: number; mine: number } | null;
  crm: { open_deals: number; open_value: number; won_this_month: number } | null;
  finance: { unpaid: number; overdue: number; paid_this_month: number; spent_this_month: number } | null;
}

export interface Overview {
  workspaces: WorkspaceOverview[];
  /** Sums over the sections the caller can see; null when no workspace shows that page. */
  totals: {
    tasks: WorkspaceOverview["tasks"];
    crm: WorkspaceOverview["crm"];
    finance: WorkspaceOverview["finance"];
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Postgres sends large numeric sums as strings; make every value a number. */
function numbers<T extends Record<string, number>>(section: T | null): T | null {
  if (!section) return null;
  return Object.fromEntries(Object.entries(section).map(([key, value]) => [key, Number(value)])) as T;
}

/** Add up one section across workspaces, skipping the ones where it is hidden. */
function sum<T extends Record<string, number>>(sections: (T | null)[]): T | null {
  const visible = sections.filter((section): section is T => section !== null);
  if (visible.length === 0) return null;
  const total: Record<string, number> = {};
  for (const section of visible) {
    for (const [key, value] of Object.entries(section)) total[key] = round((total[key] ?? 0) + value);
  }
  return total as T;
}

/**
 * Every workspace the caller may see a dashboard for, with the numbers of the
 * pages they may view there, and totals across them.
 */
// authz: user-scoped (my_overview() checks dashboard access per workspace and view access per page, under RLS)
export async function getOverview(ctx: Ctx): Promise<Overview> {
  const raw = unwrap<WorkspaceOverview[]>(await ctx.db.rpc("my_overview"));
  const workspaces = raw.map((w) => ({
    ...w,
    tasks: numbers(w.tasks),
    crm: numbers(w.crm),
    finance: numbers(w.finance),
  }));
  return {
    workspaces,
    totals: {
      tasks: sum(workspaces.map((w) => w.tasks)),
      crm: sum(workspaces.map((w) => w.crm)),
      finance: sum(workspaces.map((w) => w.finance)),
    },
  };
}
