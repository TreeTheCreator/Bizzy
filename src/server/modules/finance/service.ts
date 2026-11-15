import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { NotFound, unwrap } from "@/server/errors";
import { IMPORT_LIMIT, money } from "@/server/modules/crm/service";
import { id, isoDate, parse } from "@/server/validate";

export const INVOICE_STATUSES = ["draft", "sent", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export interface Invoice {
  id: string;
  workspace_id: string;
  number: number;
  customer_name: string;
  company_id: string | null;
  deal_id: string | null;
  status: InvoiceStatus;
  issue_date: string;
  due_date: string | null;
  total: number;
  notes: string;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface InvoiceLine {
  id: string;
  invoice_id: string;
  description: string;
  quantity: number;
  unit_price: number;
}

export interface Quote {
  id: string;
  number: number;
  customer_name: string;
  deal_id: string | null;
  title: string;
  amount: number;
  status: QuoteStatus;
  valid_until: string | null;
  created_at: string;
}

export interface Expense {
  id: string;
  spent_on: string;
  category: string;
  vendor: string;
  amount: number;
  notes: string;
  created_at: string;
}

export interface Budget {
  id: string;
  category: string;
  month: string;
  amount: number;
}

const INVOICE_COLUMNS =
  "id, workspace_id, number, customer_name, company_id, deal_id, status, issue_date, due_date, total, notes, sent_at, paid_at, created_at";
const QUOTE_COLUMNS = "id, number, customer_name, deal_id, title, amount, status, valid_until, created_at";
const EXPENSE_COLUMNS = "id, spent_on, category, vendor, amount, notes, created_at";

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (date = today()) => `${date.slice(0, 7)}-01`;
const month = z.string().regex(/^\d{4}-\d{2}$/, "must be a month (YYYY-MM)");

const lineFields = z.object({
  description: z.string().trim().min(1, "is required").max(500),
  quantity: z.coerce.number().positive("must be more than 0").max(9_999_999).multipleOf(0.01).default(1),
  unitPrice: money,
});
export type LineInput = z.input<typeof lineFields>;

const invoiceRules = z.object({
  customerName: z.string().trim().min(1, "is required").max(200),
  dueDate: isoDate.nullable(),
  notes: z.string().max(10000),
});
const invoiceFields = invoiceRules.extend({
  // With a deal, the customer name may be left out: it is taken from the deal.
  customerName: invoiceRules.shape.customerName.optional(),
  dueDate: invoiceRules.shape.dueDate.default(null),
  notes: invoiceRules.shape.notes.default(""),
  dealId: id.nullable().default(null),
  lines: z.array(lineFields).max(100).default([]),
});
export type InvoiceInput = z.input<typeof invoiceFields>;

const quoteFields = z.object({
  customerName: z.string().trim().min(1, "is required").max(200),
  title: z.string().trim().max(200).default(""),
  amount: money,
  validUntil: isoDate.nullable().default(null),
  dealId: id.nullable().default(null),
});
export type QuoteInput = z.input<typeof quoteFields>;

const expenseFields = z.object({
  spentOn: isoDate.default(today),
  category: z.string().trim().min(1, "is required").max(80).default("General"),
  vendor: z.string().trim().max(200).default(""),
  amount: money,
  notes: z.string().max(2000).default(""),
});
export type ExpenseInput = z.input<typeof expenseFields>;

function expenseRow(workspaceId: string, userId: string, data: z.infer<typeof expenseFields>) {
  return {
    workspace_id: workspaceId,
    spent_on: data.spentOn,
    category: data.category,
    vendor: data.vendor,
    amount: data.amount,
    notes: data.notes,
    created_by: userId,
  };
}

const lineRow = (workspaceId: string, invoiceId: string, line: z.infer<typeof lineFields>) => ({
  workspace_id: workspaceId,
  invoice_id: invoiceId,
  description: line.description,
  quantity: line.quantity,
  unit_price: line.unitPrice,
});

const num = <T extends object, K extends keyof T>(row: T, ...keys: K[]): T => {
  const copy = { ...row };
  for (const key of keys) copy[key] = Number(copy[key]) as T[K];
  return copy;
};

async function removeRow(ctx: Ctx, table: string, workspaceId: string, rowId: string, what: string) {
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from(table).delete().eq("workspace_id", workspaceId).eq("id", parse(id, rowId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound(what);
}

// --- Invoices ---------------------------------------------------------------

export async function listInvoices(
  ctx: Ctx,
  workspaceId: string,
  filter: { status?: InvoiceStatus } = {},
): Promise<Invoice[]> {
  await authorize(ctx, parse(id, workspaceId), "finance", "view");
  let query = ctx.db.from("invoices").select(INVOICE_COLUMNS).eq("workspace_id", workspaceId);
  if (filter.status) query = query.eq("status", parse(z.enum(INVOICE_STATUSES), filter.status));
  const rows = unwrap<Invoice[]>(await query.order("number", { ascending: false }).limit(2000));
  return rows.map((r) => num(r, "total"));
}

export async function getInvoice(
  ctx: Ctx,
  workspaceId: string,
  invoiceId: string,
): Promise<{ invoice: Invoice; lines: InvoiceLine[] }> {
  await authorize(ctx, parse(id, workspaceId), "finance", "view");
  const invoice = unwrap<Invoice | null>(
    await ctx.db
      .from("invoices")
      .select(INVOICE_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, invoiceId))
      .maybeSingle(),
  );
  if (!invoice) throw new NotFound("Invoice");
  const lines = unwrap<InvoiceLine[]>(
    await ctx.db
      .from("invoice_lines")
      .select("id, invoice_id, description, quantity, unit_price")
      .eq("workspace_id", workspaceId)
      .eq("invoice_id", invoiceId)
      .order("created_at"),
  );
  return { invoice: num(invoice, "total"), lines: lines.map((l) => num(l, "quantity", "unit_price")) };
}

/**
 * Create a draft invoice. With `dealId` (which needs CRM access too: the deal
 * is read as the caller) the customer and a first line are taken from the deal.
 */
export async function createInvoice(ctx: Ctx, workspaceId: string, input: InvoiceInput): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "finance", "edit");
  const data = parse(invoiceFields, input);
  let customerName = data.customerName;
  let companyId: string | null = null;
  const lines = [...data.lines];
  if (data.dealId) {
    const deal = unwrap<{ title: string; amount: number; company_id: string | null } | null>(
      await ctx.db
        .from("deals")
        .select("title, amount, company_id")
        .eq("workspace_id", workspaceId)
        .eq("id", data.dealId)
        .maybeSingle(),
    );
    if (!deal) throw new NotFound("Deal");
    companyId = deal.company_id;
    if (!customerName && companyId) {
      const company = unwrap<{ name: string } | null>(
        await ctx.db.from("companies").select("name").eq("workspace_id", workspaceId).eq("id", companyId).maybeSingle(),
      );
      customerName = company?.name;
    }
    customerName ||= deal.title;
    if (lines.length === 0) lines.push({ description: deal.title, quantity: 1, unitPrice: Number(deal.amount) });
  }
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("invoices")
      .insert({
        workspace_id: workspaceId,
        customer_name: parse(invoiceRules.shape.customerName, customerName ?? ""),
        company_id: companyId,
        deal_id: data.dealId,
        due_date: data.dueDate,
        notes: data.notes,
        created_by: ctx.userId,
      })
      .select("id")
      .single(),
  );
  if (lines.length > 0) {
    unwrap(await ctx.db.from("invoice_lines").insert(lines.map((line) => lineRow(workspaceId, row.id, line))));
  }
  return row.id;
}

export async function updateInvoice(
  ctx: Ctx,
  workspaceId: string,
  invoiceId: string,
  input: { customerName?: string; dueDate?: string | null; notes?: string },
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "finance", "edit");
  const data = parse(invoiceRules.partial(), input);
  const row: Record<string, unknown> = {};
  if (data.customerName !== undefined) row.customer_name = data.customerName;
  if (data.dueDate !== undefined) row.due_date = data.dueDate;
  if (data.notes !== undefined) row.notes = data.notes;
  if (Object.keys(row).length === 0) return;
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("invoices").update(row).eq("workspace_id", workspaceId).eq("id", parse(id, invoiceId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Invoice");
}

/**
 * Move an invoice between draft, sent, paid and void. "Sent" records that you
 * sent it; Bizzy does not email the customer.
 */
export async function setInvoiceStatus(
  ctx: Ctx,
  workspaceId: string,
  invoiceId: string,
  input: { status: InvoiceStatus },
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "finance", "edit");
  const { status } = parse(z.object({ status: z.enum(INVOICE_STATUSES) }), input);
  const rows = unwrap<{ id: string }[]>(
    await ctx.db
      .from("invoices")
      .update({ status })
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, invoiceId))
      .select("id"),
  );
  if (rows.length === 0) throw new NotFound("Invoice");
}

/** Add a line to a draft invoice. */
export async function addInvoiceLine(
  ctx: Ctx,
  workspaceId: string,
  invoiceId: string,
  input: LineInput,
): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "finance", "edit");
  const line = parse(lineFields, input);
  const row = unwrap<{ id: string }>(
    await ctx.db.from("invoice_lines").insert(lineRow(workspaceId, parse(id, invoiceId), line)).select("id").single(),
  );
  return row.id;
}

/** Remove a line from a draft invoice. */
export async function deleteInvoiceLine(ctx: Ctx, workspaceId: string, lineId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "finance", "edit");
  await removeRow(ctx, "invoice_lines", workspaceId, lineId, "Line");
}

export async function deleteInvoice(ctx: Ctx, workspaceId: string, invoiceId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "finance", "manage");
  await removeRow(ctx, "invoices", workspaceId, invoiceId, "Invoice");
}

// --- Quotes -----------------------------------------------------------------

export async function listQuotes(ctx: Ctx, workspaceId: string): Promise<Quote[]> {
  await authorize(ctx, parse(id, workspaceId), "finance", "view");
  const rows = unwrap<Quote[]>(
    await ctx.db
      .from("quotes")
      .select(QUOTE_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("number", { ascending: false })
      .limit(2000),
  );
  return rows.map((r) => num(r, "amount"));
}

export async function createQuote(ctx: Ctx, workspaceId: string, input: QuoteInput): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "finance", "edit");
  const data = parse(quoteFields, input);
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("quotes")
      .insert({
        workspace_id: workspaceId,
        customer_name: data.customerName,
        title: data.title,
        amount: data.amount,
        valid_until: data.validUntil,
        deal_id: data.dealId,
        created_by: ctx.userId,
      })
      .select("id")
      .single(),
  );
  return row.id;
}

export async function setQuoteStatus(
  ctx: Ctx,
  workspaceId: string,
  quoteId: string,
  input: { status: QuoteStatus },
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "finance", "edit");
  const { status } = parse(z.object({ status: z.enum(QUOTE_STATUSES) }), input);
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("quotes").update({ status }).eq("workspace_id", workspaceId).eq("id", parse(id, quoteId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Quote");
}

export async function deleteQuote(ctx: Ctx, workspaceId: string, quoteId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "finance", "manage");
  await removeRow(ctx, "quotes", workspaceId, quoteId, "Quote");
}

// --- Expenses ---------------------------------------------------------------

export async function listExpenses(
  ctx: Ctx,
  workspaceId: string,
  filter: { from?: string; to?: string } = {},
): Promise<Expense[]> {
  await authorize(ctx, parse(id, workspaceId), "finance", "view");
  let query = ctx.db.from("expenses").select(EXPENSE_COLUMNS).eq("workspace_id", workspaceId);
  if (filter.from) query = query.gte("spent_on", parse(isoDate, filter.from));
  if (filter.to) query = query.lte("spent_on", parse(isoDate, filter.to));
  const rows = unwrap<Expense[]>(
    await query.order("spent_on", { ascending: false }).order("created_at", { ascending: false }).limit(5000),
  );
  return rows.map((r) => num(r, "amount"));
}

export async function createExpense(ctx: Ctx, workspaceId: string, input: ExpenseInput): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "finance", "edit");
  const data = parse(expenseFields, input);
  const row = unwrap<{ id: string }>(
    await ctx.db.from("expenses").insert(expenseRow(workspaceId, ctx.userId, data)).select("id").single(),
  );
  return row.id;
}

export async function deleteExpense(ctx: Ctx, workspaceId: string, expenseId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "finance", "manage");
  await removeRow(ctx, "expenses", workspaceId, expenseId, "Expense");
}

/** Add many expenses at once (CSV import). Returns how many were added. */
export async function importExpenses(ctx: Ctx, workspaceId: string, input: ExpenseInput[]): Promise<number> {
  await authorize(ctx, parse(id, workspaceId), "finance", "edit");
  const rows = parse(z.array(expenseFields).min(1, "the file has no rows").max(IMPORT_LIMIT), input);
  unwrap(await ctx.db.from("expenses").insert(rows.map((r) => expenseRow(workspaceId, ctx.userId, r))));
  return rows.length;
}

// --- Budgets ----------------------------------------------------------------

/** Budgets for one month (default: this month), with what was spent in each category. */
export async function listBudgets(
  ctx: Ctx,
  workspaceId: string,
  input: { month?: string } = {},
): Promise<{ month: string; budgets: (Budget & { spent: number })[]; unbudgeted: number }> {
  await authorize(ctx, parse(id, workspaceId), "finance", "view");
  const ym = input.month ? parse(month, input.month) : today().slice(0, 7);
  const first = `${ym}-01`;
  const next = new Date(`${first}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const [budgets, expenses] = await Promise.all([
    ctx.db.from("budgets").select("id, category, month, amount").eq("workspace_id", workspaceId).eq("month", first).order("category"),
    ctx.db
      .from("expenses")
      .select("category, amount")
      .eq("workspace_id", workspaceId)
      .gte("spent_on", first)
      .lt("spent_on", next.toISOString().slice(0, 10))
      .limit(5000),
  ]);
  const spent = new Map<string, number>();
  for (const e of unwrap<{ category: string; amount: number }[]>(expenses)) {
    const key = e.category.toLowerCase();
    spent.set(key, (spent.get(key) ?? 0) + Number(e.amount));
  }
  const rows = unwrap<Budget[]>(budgets).map((b) => {
    const key = b.category.toLowerCase();
    const row = { ...num(b, "amount"), spent: Math.round((spent.get(key) ?? 0) * 100) / 100 };
    spent.delete(key);
    return row;
  });
  const unbudgeted = Math.round([...spent.values()].reduce((a, b) => a + b, 0) * 100) / 100;
  return { month: ym, budgets: rows, unbudgeted };
}

/** Set (or replace) the budget for a category in a month. */
export async function setBudget(
  ctx: Ctx,
  workspaceId: string,
  input: { category: string; month?: string; amount: number | string },
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "finance", "edit");
  const data = parse(
    z.object({ category: z.string().trim().min(1, "is required").max(80), month: month.optional(), amount: money }),
    input,
  );
  unwrap(
    await ctx.db.from("budgets").upsert(
      {
        workspace_id: workspaceId,
        category: data.category,
        month: `${data.month ?? today().slice(0, 7)}-01`,
        amount: data.amount,
        created_by: ctx.userId,
      },
      { onConflict: "workspace_id,category,month" },
    ),
  );
}

export async function deleteBudget(ctx: Ctx, workspaceId: string, budgetId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "finance", "manage");
  await removeRow(ctx, "budgets", workspaceId, budgetId, "Budget");
}

// --- Summaries --------------------------------------------------------------

export interface FinanceSummary {
  unpaid: number;
  overdue: number;
  paidThisMonth: number;
  spentThisMonth: number;
}

export interface CashFlowMonth {
  month: string;
  money_in: number;
  money_out: number;
  net: number;
}

/**
 * Money in (invoices, by the day they were paid) and out (expenses) per month
 * for the last `months` months, plus the headline numbers for today.
 */
export async function getCashFlow(
  ctx: Ctx,
  workspaceId: string,
  input: { months?: number } = {},
): Promise<{ summary: FinanceSummary; months: CashFlowMonth[] }> {
  await authorize(ctx, parse(id, workspaceId), "finance", "view");
  const count = parse(z.number().int().min(1).max(24).default(6), input.months);
  const start = new Date(`${monthStart()}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - (count - 1));
  const from = start.toISOString().slice(0, 10);
  const [open, paid, expenses] = await Promise.all([
    ctx.db.from("invoices").select("total, due_date").eq("workspace_id", workspaceId).eq("status", "sent").limit(5000),
    ctx.db.from("invoices").select("total, paid_at").eq("workspace_id", workspaceId).eq("status", "paid").gte("paid_at", from).limit(5000),
    ctx.db.from("expenses").select("amount, spent_on").eq("workspace_id", workspaceId).gte("spent_on", from).limit(5000),
  ]);
  const months = new Map<string, CashFlowMonth>();
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() + i);
    const key = d.toISOString().slice(0, 7);
    months.set(key, { month: key, money_in: 0, money_out: 0, net: 0 });
  }
  for (const row of unwrap<{ total: number; paid_at: string }[]>(paid)) {
    const m = months.get(row.paid_at.slice(0, 7));
    if (m) m.money_in += Number(row.total);
  }
  for (const row of unwrap<{ amount: number; spent_on: string }[]>(expenses)) {
    const m = months.get(row.spent_on.slice(0, 7));
    if (m) m.money_out += Number(row.amount);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const list = [...months.values()].map((m) => ({
    month: m.month,
    money_in: round(m.money_in),
    money_out: round(m.money_out),
    net: round(m.money_in - m.money_out),
  }));
  const openRows = unwrap<{ total: number; due_date: string | null }[]>(open);
  const now = today();
  const current = list.at(-1)!;
  return {
    summary: {
      unpaid: round(openRows.reduce((sum, r) => sum + Number(r.total), 0)),
      overdue: round(openRows.filter((r) => r.due_date && r.due_date < now).reduce((sum, r) => sum + Number(r.total), 0)),
      paidThisMonth: current.money_in,
      spentThisMonth: current.money_out,
    },
    months: list,
  };
}
