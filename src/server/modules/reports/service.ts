import { z } from "zod";
import { authorize, authorizeAnyAccess } from "@/server/authz/authorize";
import { type Page, atLeast } from "@/server/authz/pages";
import type { Ctx } from "@/server/context";
import { NotFound, unwrap } from "@/server/errors";
import { id, parse } from "@/server/validate";

/**
 * Reports: fixed questions about one page's data. Running a report needs view
 * on that page, and every query runs as the caller under row-level security.
 * The page per kind must match public.report_page() in the database.
 */
export const REPORTS = {
  cash_flow: { page: "finance", title: "Money in and out", about: "What was paid to you and what you spent, month by month." },
  spending_by_category: { page: "finance", title: "Spending by category", about: "Where the money went." },
  deals_by_stage: { page: "crm", title: "Deals by stage", about: "Deals in progress now, and what was won or lost in the period." },
  tasks_by_person: { page: "tasks", title: "Tasks by person", about: "Who has what to do, what is late, and what got finished." },
  time_off_by_person: { page: "hr", title: "Time off by person", about: "Approved days off in the period, and requests still waiting." },
} as const satisfies Record<string, { page: Page; title: string; about: string }>;
export type ReportKind = keyof typeof REPORTS;
export const REPORT_KINDS = Object.keys(REPORTS) as ReportKind[];

export const PERIODS = ["this_month", "last_month", "this_year", "last_12_months"] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_LABELS: Record<Period, string> = {
  this_month: "This month",
  last_month: "Last month",
  this_year: "This year",
  last_12_months: "Last 12 months",
};

export interface Column {
  key: string;
  label: string;
  type: "text" | "number" | "money";
}

export interface Report {
  kind: ReportKind;
  period: Period;
  /** Inclusive, YYYY-MM-DD. */
  from: string;
  to: string;
  columns: Column[];
  rows: Record<string, string | number>[];
}

export interface SavedReport {
  id: string;
  name: string;
  kind: ReportKind;
  period: Period;
  created_by: string | null;
}

const iso = (date: Date) => date.toISOString().slice(0, 10);
const round = (n: number) => Math.round(n * 100) / 100;

/** The first and last day (UTC) of a period, as of `today`. */
export function periodRange(period: Period, today = new Date()): { from: string; to: string } {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const day = (year: number, month: number, date: number) => iso(new Date(Date.UTC(year, month, date)));
  switch (period) {
    case "this_month":
      return { from: day(y, m, 1), to: day(y, m + 1, 0) };
    case "last_month":
      return { from: day(y, m - 1, 1), to: day(y, m, 0) };
    case "this_year":
      return { from: day(y, 0, 1), to: day(y, 11, 31) };
    case "last_12_months":
      return { from: day(y, m - 11, 1), to: day(y, m + 1, 0) };
  }
}

/** Days two inclusive date ranges share. */
function overlapDays(aFrom: string, aTo: string, bFrom: string, bTo: string): number {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  if (to < from) return 0;
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}

type Range = { from: string; to: string };
/** The instant just after the last day of the range, for timestamp columns. */
const endOf = (range: Range) => iso(new Date(Date.parse(range.to) + 86_400_000));

async function cashFlow(ctx: Ctx, ws: string, range: Range): Promise<Pick<Report, "columns" | "rows">> {
  const [paid, spent] = await Promise.all([
    ctx.db.from("invoices").select("total, paid_at").eq("workspace_id", ws).eq("status", "paid").gte("paid_at", range.from).lt("paid_at", endOf(range)).limit(10000),
    ctx.db.from("expenses").select("amount, spent_on").eq("workspace_id", ws).gte("spent_on", range.from).lte("spent_on", range.to).limit(10000),
  ]);
  const months = new Map<string, { in: number; out: number }>();
  for (let d = new Date(`${range.from}T00:00:00Z`); iso(d) <= range.to; d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.set(iso(d).slice(0, 7), { in: 0, out: 0 });
  }
  for (const row of unwrap<{ total: number; paid_at: string }[]>(paid)) {
    const month = months.get(row.paid_at.slice(0, 7));
    if (month) month.in += Number(row.total);
  }
  for (const row of unwrap<{ amount: number; spent_on: string }[]>(spent)) {
    const month = months.get(row.spent_on.slice(0, 7));
    if (month) month.out += Number(row.amount);
  }
  return {
    columns: [
      { key: "month", label: "Month", type: "text" },
      { key: "money_in", label: "Money in", type: "money" },
      { key: "money_out", label: "Money out", type: "money" },
      { key: "net", label: "Left over", type: "money" },
    ],
    rows: [...months].map(([month, v]) => ({ month, money_in: round(v.in), money_out: round(v.out), net: round(v.in - v.out) })),
  };
}

async function spendingByCategory(ctx: Ctx, ws: string, range: Range): Promise<Pick<Report, "columns" | "rows">> {
  const expenses = unwrap<{ category: string; amount: number }[]>(
    await ctx.db.from("expenses").select("category, amount").eq("workspace_id", ws).gte("spent_on", range.from).lte("spent_on", range.to).limit(10000),
  );
  const byCategory = new Map<string, { category: string; amount: number; count: number }>();
  for (const e of expenses) {
    const key = e.category.toLowerCase();
    const entry = byCategory.get(key) ?? { category: e.category, amount: 0, count: 0 };
    entry.amount += Number(e.amount);
    entry.count += 1;
    byCategory.set(key, entry);
  }
  return {
    columns: [
      { key: "category", label: "Category", type: "text" },
      { key: "count", label: "Expenses", type: "number" },
      { key: "amount", label: "Spent", type: "money" },
    ],
    rows: [...byCategory.values()]
      .map((c) => ({ ...c, amount: round(c.amount) }))
      .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)),
  };
}

async function dealsByStage(ctx: Ctx, ws: string, range: Range): Promise<Pick<Report, "columns" | "rows">> {
  const [stages, deals] = await Promise.all([
    ctx.db.from("deal_stages").select("id, name, kind, position").eq("workspace_id", ws).order("position"),
    ctx.db.from("deals").select("stage_id, amount, closed_at").eq("workspace_id", ws).limit(10000),
  ]);
  const all = unwrap<{ stage_id: string; amount: number; closed_at: string | null }[]>(deals);
  const end = endOf(range);
  return {
    columns: [
      { key: "stage", label: "Stage", type: "text" },
      { key: "deals", label: "Deals", type: "number" },
      { key: "value", label: "Worth", type: "money" },
    ],
    rows: unwrap<{ id: string; name: string; kind: "open" | "won" | "lost" }[]>(stages).map((stage) => {
      // Open stages show where things stand now; won and lost count what closed in the period.
      const inStage = all.filter(
        (d) => d.stage_id === stage.id && (stage.kind === "open" || (d.closed_at !== null && d.closed_at >= range.from && d.closed_at < end)),
      );
      return { stage: stage.name, deals: inStage.length, value: round(inStage.reduce((sum, d) => sum + Number(d.amount), 0)) };
    }),
  };
}

async function tasksByPerson(ctx: Ctx, ws: string, range: Range): Promise<Pick<Report, "columns" | "rows">> {
  const [tasks, people] = await Promise.all([
    ctx.db.from("tasks").select("assignee_id, status, due_date, completed_at").eq("workspace_id", ws).limit(10000),
    ctx.db.rpc("workspace_people", { p_workspace: ws }),
  ]);
  const names = new Map(unwrap<{ user_id: string; display_name: string }[]>(people).map((p) => [p.user_id, p.display_name]));
  const today = iso(new Date());
  const end = endOf(range);
  const byPerson = new Map<string, { person: string; open: number; late: number; finished: number }>();
  for (const t of unwrap<{ assignee_id: string | null; status: string; due_date: string | null; completed_at: string | null }[]>(tasks)) {
    const key = t.assignee_id ?? "";
    const entry = byPerson.get(key) ?? { person: t.assignee_id ? (names.get(t.assignee_id) ?? "Someone who left") : "Nobody yet", open: 0, late: 0, finished: 0 };
    if (t.status !== "done") {
      entry.open += 1;
      if (t.due_date && t.due_date < today) entry.late += 1;
    } else if (t.completed_at && t.completed_at >= range.from && t.completed_at < end) {
      entry.finished += 1;
    }
    byPerson.set(key, entry);
  }
  return {
    columns: [
      { key: "person", label: "Person", type: "text" },
      { key: "open", label: "To do now", type: "number" },
      { key: "late", label: "Late now", type: "number" },
      { key: "finished", label: "Finished in the period", type: "number" },
    ],
    rows: [...byPerson.values()].filter((p) => p.open + p.finished > 0).sort((a, b) => a.person.localeCompare(b.person)),
  };
}

async function timeOffByPerson(ctx: Ctx, ws: string, range: Range): Promise<Pick<Report, "columns" | "rows">> {
  const [people, leave] = await Promise.all([
    ctx.db.from("employees").select("id, full_name").eq("workspace_id", ws).order("full_name").limit(5000),
    ctx.db.from("leave_requests").select("employee_id, kind, start_date, end_date, status").eq("workspace_id", ws).lte("start_date", range.to).gte("end_date", range.from).limit(10000),
  ]);
  const requests = unwrap<{ employee_id: string; kind: string; start_date: string; end_date: string; status: string }[]>(leave);
  return {
    columns: [
      { key: "person", label: "Person", type: "text" },
      { key: "holiday", label: "Holiday days", type: "number" },
      { key: "sick", label: "Sick days", type: "number" },
      { key: "other", label: "Other days", type: "number" },
      { key: "waiting", label: "Requests waiting", type: "number" },
    ],
    rows: unwrap<{ id: string; full_name: string }[]>(people).map((p) => {
      const mine = requests.filter((r) => r.employee_id === p.id);
      const daysOf = (kind: string) =>
        mine.filter((r) => r.status === "approved" && r.kind === kind).reduce((sum, r) => sum + overlapDays(r.start_date, r.end_date, range.from, range.to), 0);
      return {
        person: p.full_name,
        holiday: daysOf("holiday"),
        sick: daysOf("sick"),
        other: daysOf("other"),
        waiting: mine.filter((r) => r.status === "pending").length,
      };
    }),
  };
}

const RUNNERS: Record<ReportKind, (ctx: Ctx, ws: string, range: Range) => Promise<Pick<Report, "columns" | "rows">>> = {
  cash_flow: cashFlow,
  spending_by_category: spendingByCategory,
  deals_by_stage: dealsByStage,
  tasks_by_person: tasksByPerson,
  time_off_by_person: timeOffByPerson,
};

const kindSchema = z.enum(REPORT_KINDS as [ReportKind, ...ReportKind[]]);
const periodSchema = z.enum(PERIODS);

/** The reports the caller may run here, and the saved ones they may see. */
export async function listReports(
  ctx: Ctx,
  workspaceId: string,
): Promise<{ kinds: ReportKind[]; saved: SavedReport[]; canSave: ReportKind[] }> {
  const access = await authorizeAnyAccess(ctx, parse(id, workspaceId));
  const saved = unwrap<SavedReport[]>(
    await ctx.db.from("saved_reports").select("id, name, kind, period, created_by").eq("workspace_id", workspaceId).order("name"),
  );
  return {
    kinds: REPORT_KINDS.filter((kind) => atLeast(access.levels[REPORTS[kind].page], "view")),
    canSave: REPORT_KINDS.filter((kind) => atLeast(access.levels[REPORTS[kind].page], "edit")),
    saved,
  };
}

/** Run one report. Needs view on the page the report draws on. */
export async function runReport(
  ctx: Ctx,
  workspaceId: string,
  input: { kind: string; period?: string },
): Promise<Report> {
  await authorizeAnyAccess(ctx, parse(id, workspaceId));
  const kind = parse(kindSchema, input.kind);
  const period = parse(periodSchema.default("this_month"), input.period);
  await authorize(ctx, workspaceId, REPORTS[kind].page, "view");
  const range = periodRange(period);
  return { kind, period, ...range, ...(await RUNNERS[kind](ctx, workspaceId, range)) };
}

/** Keep a report under a name. Needs edit on the page it draws on. Stores no numbers. */
export async function saveReport(
  ctx: Ctx,
  workspaceId: string,
  input: { name: string; kind: string; period: string },
): Promise<string> {
  await authorizeAnyAccess(ctx, parse(id, workspaceId));
  const data = parse(z.object({ name: z.string().trim().min(1, "is required").max(120), kind: kindSchema, period: periodSchema }), input);
  await authorize(ctx, workspaceId, REPORTS[data.kind].page, "edit");
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("saved_reports")
      .insert({ workspace_id: workspaceId, ...data, created_by: ctx.userId })
      .select("id")
      .single(),
  );
  return row.id;
}

/** Remove a saved report: whoever saved it, or anyone with manage on its page. */
export async function deleteSavedReport(ctx: Ctx, workspaceId: string, reportId: string): Promise<void> {
  await authorizeAnyAccess(ctx, parse(id, workspaceId));
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("saved_reports").delete().eq("workspace_id", workspaceId).eq("id", parse(id, reportId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Report");
}
