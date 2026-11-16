import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeal, listStages } from "@/server/modules/crm/service";
import { createExpense, createInvoice, setInvoiceStatus } from "@/server/modules/finance/service";
import { createEmployee, decideLeave, requestLeave } from "@/server/modules/hr/service";
import { setMemberRole } from "@/server/modules/members/service";
import {
  REPORT_KINDS,
  deleteSavedReport,
  listReports,
  periodRange,
  runReport,
  saveReport,
} from "@/server/modules/reports/service";
import { createRole } from "@/server/modules/roles/service";
import { createTask, updateTask } from "@/server/modules/tasks/service";
import { type Team, cleanup, createTeam, expectCode, expectDenied } from "../helpers";
import { dbTestsEnabled } from "../setup";

// Phase 3: reports. A report needs view on the page it draws on; saving one
// needs edit. In this team team.sales has Tasks edit and Docs view only.

const today = () => new Date().toISOString().slice(0, 10);

describe("report periods", () => {
  it("cover whole months and years, in UTC", () => {
    const on = new Date("2026-03-15T12:00:00Z");
    expect(periodRange("this_month", on)).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(periodRange("last_month", on)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodRange("this_year", on)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(periodRange("last_12_months", on)).toEqual({ from: "2025-04-01", to: "2026-03-31" });
    expect(periodRange("last_month", new Date("2026-01-31T23:00:00Z"))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
});

describe.skipIf(!dbTestsEnabled)("reports", () => {
  let team: Team;
  let other: Team;
  let ws: string;

  beforeAll(async () => {
    [team, other] = await Promise.all([createTeam("Reports"), createTeam("ReportsOther")]);
    ws = team.workspaceId;
    const { owner } = team;

    await createExpense(owner, ws, { amount: 100, category: "Supplies" });
    await createExpense(owner, ws, { amount: 50.5, category: "supplies" });
    await createExpense(owner, ws, { amount: 20, category: "Rent" });
    await createExpense(owner, ws, { amount: 999, category: "Old", spentOn: "2020-01-15" });
    const invoice = await createInvoice(owner, ws, { customerName: "C", lines: [{ description: "work", quantity: 2, unitPrice: 150 }] });
    await setInvoiceStatus(owner, ws, invoice, { status: "sent" });
    await setInvoiceStatus(owner, ws, invoice, { status: "paid" });

    const stages = await listStages(owner, ws);
    await createDeal(owner, ws, { title: "open", amount: 1000 });
    await createDeal(owner, ws, { title: "won", amount: 400, stageId: stages.find((s) => s.kind === "won")!.id });

    await createTask(owner, ws, { title: "late", assigneeId: team.sales.userId, dueDate: "2020-01-01" });
    await createTask(owner, ws, { title: "open", assigneeId: team.sales.userId });
    const done = await createTask(owner, ws, { title: "done", assigneeId: team.sales.userId });
    await updateTask(owner, ws, done, { status: "done" });
    await createTask(owner, ws, { title: "nobody's" });

    const ada = await createEmployee(owner, ws, { fullName: "Ada Baker" });
    await createEmployee(owner, ws, { fullName: "Ben Counter" });
    const range = periodRange("this_month");
    // Three approved days inside this month, and one request still waiting.
    const start = `${range.from.slice(0, 8)}10`;
    const leave = await requestLeave(owner, ws, { employeeId: ada, kind: "holiday", startDate: start, endDate: `${range.from.slice(0, 8)}12` });
    await decideLeave(owner, ws, leave, { status: "approved" });
    await requestLeave(owner, ws, { employeeId: ada, kind: "sick", startDate: start, endDate: start });
  });
  afterAll(cleanup);

  it("the owner can run every report, with the right numbers", async () => {
    expect((await listReports(team.owner, ws)).kinds).toEqual(REPORT_KINDS);

    const spending = await runReport(team.owner, ws, { kind: "spending_by_category", period: "this_month" });
    expect(spending.rows).toEqual([
      { category: "Supplies", amount: 150.5, count: 2 },
      { category: "Rent", amount: 20, count: 1 },
    ]);

    const cash = await runReport(team.owner, ws, { kind: "cash_flow", period: "this_month" });
    expect(cash.rows).toEqual([{ month: today().slice(0, 7), money_in: 300, money_out: 170.5, net: 129.5 }]);
    expect((await runReport(team.owner, ws, { kind: "cash_flow", period: "last_12_months" })).rows).toHaveLength(12);

    const deals = await runReport(team.owner, ws, { kind: "deals_by_stage" });
    expect(deals.period).toBe("this_month");
    expect(deals.rows.find((r) => r.stage === "Lead")).toEqual({ stage: "Lead", deals: 1, value: 1000 });
    expect(deals.rows.find((r) => r.stage === "Won")).toEqual({ stage: "Won", deals: 1, value: 400 });
    expect(deals.rows.find((r) => r.stage === "Lost")).toEqual({ stage: "Lost", deals: 0, value: 0 });

    const tasks = await runReport(team.owner, ws, { kind: "tasks_by_person" });
    expect(tasks.rows).toEqual([
      { person: "Nobody yet", open: 1, late: 0, finished: 0 },
      { person: "sales", open: 2, late: 1, finished: 1 },
    ]);

    const leave = await runReport(team.owner, ws, { kind: "time_off_by_person" });
    expect(leave.rows).toEqual([
      { person: "Ada Baker", holiday: 3, sick: 0, other: 0, waiting: 1 },
      { person: "Ben Counter", holiday: 0, sick: 0, other: 0, waiting: 0 },
    ]);
  });

  it("a member can run only the reports of pages their role includes", async () => {
    expect((await listReports(team.sales, ws)).kinds).toEqual(["tasks_by_person"]);
    await runReport(team.sales, ws, { kind: "tasks_by_person" });
    for (const kind of ["cash_flow", "spending_by_category", "deals_by_stage", "time_off_by_person"]) {
      await expectDenied(runReport(team.sales, ws, { kind }));
    }
    // Docs is not a page reports draw on.
    expect((await listReports(team.writer, ws)).kinds).toEqual([]);
    await expectDenied(listReports(team.norole, ws));
    await expectDenied(runReport(other.owner, ws, { kind: "tasks_by_person" }));
    await expectCode(runReport(team.owner, ws, { kind: "everything" }), "invalid");
    await expectCode(runReport(team.owner, ws, { kind: "cash_flow", period: "forever" }), "invalid");
  });

  it("saving needs edit on the report's page; seeing a saved report needs view", async () => {
    const money = await saveReport(team.owner, ws, { name: "Monthly spending", kind: "spending_by_category", period: "this_month" });
    const tasks = await saveReport(team.sales, ws, { name: "My team", kind: "tasks_by_person", period: "this_year" });
    await expectCode(saveReport(team.sales, ws, { name: "My team", kind: "tasks_by_person", period: "this_year" }), "invalid");
    await expectDenied(saveReport(team.sales, ws, { name: "Sneaky", kind: "cash_flow", period: "this_month" }));

    // A role that can only look cannot save.
    const lookOnly = await createRole(team.owner, ws, { name: "Looker", kind: "custom", permissions: { tasks: { level: "view" } } });
    await setMemberRole(team.owner, ws, { userId: team.guest.userId, roleId: lookOnly });
    await expectDenied(saveReport(team.guest, ws, { name: "Nope", kind: "tasks_by_person", period: "this_month" }));
    const raw = await team.guest.db.from("saved_reports").insert({ workspace_id: ws, name: "Raw", kind: "tasks_by_person", period: "this_month", created_by: team.guest.userId });
    expect(raw.error).not.toBeNull();

    // Sales sees the Tasks report but not the Money one, even by asking the database directly.
    expect((await listReports(team.sales, ws)).saved.map((s) => s.name)).toEqual(["My team"]);
    expect((await team.sales.db.from("saved_reports").select("name").eq("workspace_id", ws)).data).toEqual([{ name: "My team" }]);
    expect((await listReports(team.owner, ws)).saved.map((s) => s.name)).toEqual(["Monthly spending", "My team"]);
    expect((await listReports(team.guest, ws)).saved.map((s) => s.name)).toEqual(["My team"]);

    // Removing: the person who saved it, or manage on its page. Never someone else with edit.
    await expectCode(deleteSavedReport(team.sales, ws, money), "not_found");
    await expectCode(deleteSavedReport(team.guest, ws, tasks), "not_found");
    await deleteSavedReport(team.sales, ws, tasks);
    await deleteSavedReport(team.owner, ws, money);
    expect((await listReports(team.owner, ws)).saved).toEqual([]);
  });

  it("refuses a saved report of a kind that does not exist", async () => {
    const raw = await team.owner.db.from("saved_reports").insert({ workspace_id: ws, name: "Bad", kind: "salaries", period: "this_month", created_by: team.owner.userId });
    expect(raw.error).not.toBeNull();
  });
});
