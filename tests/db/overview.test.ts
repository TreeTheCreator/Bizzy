import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeal, listStages } from "@/server/modules/crm/service";
import { createExpense, createInvoice, setInvoiceStatus } from "@/server/modules/finance/service";
import { getOverview } from "@/server/modules/overview/service";
import { createRole, updateRole } from "@/server/modules/roles/service";
import { setMemberRole } from "@/server/modules/members/service";
import { createTask } from "@/server/modules/tasks/service";
import { createWorkspace } from "@/server/modules/workspaces/service";
import { type Team, cleanup, createTeam, freshAmr, sqlAsClaims } from "../helpers";
import { dbTestsEnabled } from "../setup";

// Phase 3 acceptance: the dashboard shows only workspaces and pages the viewer
// may access.

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!dbTestsEnabled)("cross-workspace overview", () => {
  let team: Team;
  let other: Team;
  let ws: string;

  beforeAll(async () => {
    [team, other] = await Promise.all([createTeam("Overview"), createTeam("OverviewOther")]);
    ws = team.workspaceId;
    const { owner } = team;

    // Tasks: 3 open (1 late, 1 the owner's, 1 the sales member's) and 1 done.
    await createTask(owner, ws, { title: "late", dueDate: day(-3) });
    await createTask(owner, ws, { title: "mine", assigneeId: owner.userId, dueDate: day(5) });
    await createTask(owner, ws, { title: "theirs", assigneeId: team.sales.userId });
    await createTask(owner, ws, { title: "finished", status: "done", dueDate: day(-10) });

    // Deals: one open worth 1000, one won worth 500.50, one lost worth 9999.
    const stages = await listStages(owner, ws);
    const stage = (kind: string) => stages.find((s) => s.kind === kind)!.id;
    await createDeal(owner, ws, { title: "open", amount: 1000 });
    await createDeal(owner, ws, { title: "won", amount: 500.5, stageId: stage("won") });
    await createDeal(owner, ws, { title: "lost", amount: 9999, stageId: stage("lost") });

    // Money: a late unpaid invoice of 200, an unpaid one of 50, a paid one of 300,
    // a draft that counts for nothing, and 75.25 spent.
    const invoice = async (amount: number, status: "sent" | "paid" | null, dueDate: string | null) => {
      const id = await createInvoice(owner, ws, {
        customerName: "Customer",
        dueDate,
        lines: [{ description: "work", quantity: 1, unitPrice: amount }],
      });
      if (status) await setInvoiceStatus(owner, ws, id, { status: "sent" });
      if (status === "paid") await setInvoiceStatus(owner, ws, id, { status: "paid" });
    };
    await invoice(200, "sent", day(-2));
    await invoice(50, "sent", day(20));
    await invoice(300, "paid", null);
    await invoice(4000, null, null);
    await createExpense(owner, ws, { amount: 75.25, category: "Supplies" });
  });
  afterAll(cleanup);

  it("shows the owner every page's numbers", async () => {
    const { workspaces, totals } = await getOverview(team.owner);
    expect(workspaces.map((w) => w.id)).toEqual([ws]);
    const [w] = workspaces;
    expect(w.is_owner).toBe(true);
    expect(w.tasks).toEqual({ open: 3, overdue: 1, mine: 1 });
    expect(w.crm).toEqual({ open_deals: 1, open_value: 1000, won_this_month: 500.5 });
    expect(w.finance).toEqual({ unpaid: 250, overdue: 200, paid_this_month: 300, spent_this_month: 75.25 });
    expect(totals).toEqual({ tasks: w.tasks, crm: w.crm, finance: w.finance });
  });

  it("lists nothing for members whose role does not include the Dashboard", async () => {
    // Sales can open Tasks, the writer can manage Docs, the guest can read Docs:
    // none of those roles includes the Dashboard.
    for (const member of [team.sales, team.writer, team.guest, team.norole]) {
      expect((await getOverview(member)).workspaces).toEqual([]);
      expect((await member.db.rpc("my_overview")).data).toEqual([]);
    }
  });

  it("shows a member only the pages their role includes", async () => {
    await updateRole(team.owner, ws, team.roles.sales, {
      name: "Sales",
      kind: "custom",
      permissions: { dashboard: { level: "view" }, tasks: { level: "edit" }, docs: { level: "view" } },
    });
    const { workspaces, totals } = await getOverview(team.sales);
    expect(workspaces).toHaveLength(1);
    const [w] = workspaces;
    expect(w.is_owner).toBe(false);
    expect(w.tasks).toEqual({ open: 3, overdue: 1, mine: 1 }); // "mine" is the caller's own
    expect(w.crm).toBeNull();
    expect(w.finance).toBeNull();
    expect(totals.crm).toBeNull();
    expect(totals.finance).toBeNull();

    // Dashboard alone shows the business with no numbers at all.
    const dashOnly = await createRole(team.owner, ws, { name: "Board", kind: "custom", permissions: { dashboard: { level: "view" } } });
    await setMemberRole(team.owner, ws, { userId: team.writer.userId, roleId: dashOnly });
    const bare = (await getOverview(team.writer)).workspaces;
    expect(bare).toHaveLength(1);
    expect(bare[0]).toMatchObject({ tasks: null, crm: null, finance: null });
  });

  it("stops showing a business the moment the role is taken away", async () => {
    expect((await getOverview(team.sales)).workspaces).toHaveLength(1);
    await setMemberRole(team.owner, ws, { userId: team.sales.userId, roleId: null });
    expect((await getOverview(team.sales)).workspaces).toEqual([]);
    await setMemberRole(team.owner, ws, { userId: team.sales.userId, roleId: team.roles.sales });
  });

  it("never includes a business the caller does not belong to", async () => {
    const mine = (await getOverview(other.owner)).workspaces.map((w) => w.id);
    expect(mine).toEqual([other.workspaceId]);
    expect((await getOverview(team.owner)).workspaces.map((w) => w.id)).not.toContain(other.workspaceId);
  });

  it("adds up across the caller's businesses, in name order", async () => {
    const second = await createWorkspace(team.owner, { name: "Aardvark second business" });
    await createTask(team.owner, second, { title: "only task", assigneeId: team.owner.userId });
    await createExpense(team.owner, second, { amount: 10 });
    const { workspaces, totals } = await getOverview(team.owner);
    expect(workspaces.map((w) => w.id)).toEqual([second, ws]);
    expect(totals.tasks).toEqual({ open: 4, overdue: 1, mine: 2 });
    expect(totals.crm).toEqual({ open_deals: 1, open_value: 1000, won_this_month: 500.5 });
    expect(totals.finance).toEqual({ unpaid: 250, overdue: 200, paid_this_month: 300, spent_this_month: 85.25 });
  });

  it("gives an AI app's token nothing unless it is connected to the business", async () => {
    const claims = { sub: team.owner.userId, amr: freshAmr(), client_id: "an-unconnected-ai-app" };
    const result = await sqlAsClaims(claims, "select public.my_overview() as overview");
    expect(result.error).toBeUndefined();
    expect(result.rows[0].overview).toEqual([]);
  });

  it("gives a signed-out caller nothing", async () => {
    const result = await sqlAsClaims({ role: "authenticated" }, "select public.my_overview() as overview");
    expect(result.rows[0]?.overview ?? []).toEqual([]);
  });
});
