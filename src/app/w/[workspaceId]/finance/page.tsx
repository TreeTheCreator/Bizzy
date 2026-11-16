import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { AutoSelect, ConfirmButton, ModalButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { EmptyState, PageHeader, Tabs } from "@/components/ui";
import { type Tone, dueLabel, formatDate, formatMoney, humanize, pillClass, todayIso } from "@/lib/format";
import { authorize } from "@/server/authz/authorize";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import {
  type Invoice,
  QUOTE_STATUSES,
  getCashFlow,
  listBudgets,
  listExpenses,
  listInvoices,
  listQuotes,
} from "@/server/modules/finance/service";
import {
  createExpenseAction,
  createInvoiceAction,
  createQuoteAction,
  deleteBudgetAction,
  deleteExpenseAction,
  deleteQuoteAction,
  importExpensesAction,
  setBudgetAction,
  setInvoiceStatusAction,
  setQuoteStatusAction,
} from "./actions";
import { INVOICE_STATUS_LABELS } from "./labels";

export const metadata: Metadata = { title: "Money" };

const VIEWS = ["invoices", "quotes", "expenses", "budgets"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABELS: Record<View, string> = { invoices: "Invoices", quotes: "Quotes", expenses: "Expenses", budgets: "Budgets" };

/** The status shown for an invoice: a sent invoice past its due date reads as late. */
function invoiceBadge(invoice: Invoice, today: string): { label: string; tone: Tone } {
  if (invoice.status === "sent") {
    const due = dueLabel(invoice.due_date, today);
    if (due?.tone === "danger") return due;
    return { label: "Waiting to be paid", tone: "info" };
  }
  if (invoice.status === "paid") return { label: "Paid", tone: "ok" };
  return { label: INVOICE_STATUS_LABELS[invoice.status], tone: "neutral" };
}

/** "2026-11" → "November 2026". */
function monthName(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return month;
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

export default async function FinancePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ view?: string; month?: string }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const view: View = VIEWS.find((v) => v === query.view) ?? "invoices";
  const month = /^\d{4}-\d{2}$/.test(query.month ?? "") ? query.month : undefined;
  const ctx = await getWebCtx();

  const loaded = await tryLoad(async () => {
    const access = await authorize(ctx, workspaceId, "finance", "view");
    const [cashFlow, invoices, quotes, expenses, budgets] = await Promise.all([
      getCashFlow(ctx, workspaceId),
      view === "invoices" ? listInvoices(ctx, workspaceId) : [],
      view === "quotes" ? listQuotes(ctx, workspaceId) : [],
      view === "expenses" ? listExpenses(ctx, workspaceId) : [],
      view === "budgets" ? listBudgets(ctx, workspaceId, { month }) : null,
    ]);
    return { access, cashFlow, invoices, quotes, expenses, budgets };
  });
  if (loaded.denied) return <NoAccess what="Money" />;
  const { access, cashFlow, invoices, quotes, expenses, budgets } = loaded.data;
  const canEdit = atLeast(access.levels.finance, "edit");
  const canManage = atLeast(access.levels.finance, "manage");
  const base = `/w/${workspaceId}/finance`;
  const today = todayIso();
  const { summary } = cashFlow;
  const tiles = [
    { label: "Waiting to be paid", value: summary.unpaid, danger: false },
    { label: "Late", value: summary.overdue, danger: summary.overdue > 0 },
    { label: "Paid this month", value: summary.paidThisMonth, danger: false },
    { label: "Spent this month", value: summary.spentThisMonth, danger: false },
  ];

  const newButton = (label?: string) => {
    if (view === "invoices") {
      return (
        <ModalButton label={label ?? "New invoice"} title="New invoice" icon="plus">
          <ActionForm action={createInvoiceAction.bind(null, workspaceId)} className="space-y-4">
            <label className="block">
              <span className="label">Who is it for?</span>
              <input className="input" name="customerName" placeholder="Customer name" required maxLength={200} />
            </label>
            <label className="block">
              <span className="label">Pay by (optional)</span>
              <input className="input" name="dueDate" type="date" />
            </label>
            <p className="muted">Next, you add what you are charging for.</p>
            <button className="btn btn-primary w-full sm:w-auto" type="submit">Create invoice</button>
          </ActionForm>
        </ModalButton>
      );
    }
    if (view === "quotes") {
      return (
        <ModalButton label={label ?? "New quote"} title="New quote" icon="plus">
          <ActionForm action={createQuoteAction.bind(null, workspaceId)} className="space-y-4">
            <label className="block">
              <span className="label">Who is it for?</span>
              <input className="input" name="customerName" placeholder="Customer name" required maxLength={200} />
            </label>
            <label className="block">
              <span className="label">What is it for?</span>
              <input className="input" name="title" maxLength={200} placeholder="Website redesign" />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                <span className="label">Price</span>
                <input className="input" name="amount" type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" required />
              </label>
              <label>
                <span className="label">Good until (optional)</span>
                <input className="input" name="validUntil" type="date" />
              </label>
            </div>
            <button className="btn btn-primary w-full sm:w-auto" type="submit">Add quote</button>
          </ActionForm>
        </ModalButton>
      );
    }
    if (view === "expenses") {
      return (
        <ModalButton label={label ?? "Add expense"} title="Add an expense" icon="plus">
          <ActionForm action={createExpenseAction.bind(null, workspaceId)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                <span className="label">Amount</span>
                <input className="input" name="amount" type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" required />
              </label>
              <label>
                <span className="label">Date</span>
                <input className="input" name="spentOn" type="date" defaultValue={today} />
              </label>
            </div>
            <label className="block">
              <span className="label">Who did you pay?</span>
              <input className="input" name="vendor" placeholder="City Power Co." maxLength={200} />
            </label>
            <label className="block">
              <span className="label">Category</span>
              <input className="input" name="category" placeholder="Rent, Supplies, Software…" maxLength={80} />
            </label>
            <button className="btn btn-primary w-full sm:w-auto" type="submit">Add expense</button>
          </ActionForm>
        </ModalButton>
      );
    }
    if (!budgets) return null;
    return (
      <ModalButton label={label ?? "Set a budget"} title={`Budget for ${monthName(budgets.month)}`} icon="plus">
        <ActionForm action={setBudgetAction.bind(null, workspaceId)} className="space-y-4">
          <input type="hidden" name="month" value={budgets.month} />
          <label className="block">
            <span className="label">Category</span>
            <input className="input" name="category" required maxLength={80} placeholder="Supplies" />
            <span className="muted mt-1 block">Use the same category name you use on your expenses.</span>
          </label>
          <label className="block">
            <span className="label">Most you want to spend</span>
            <input className="input" name="amount" type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" required />
          </label>
          <button className="btn btn-primary w-full sm:w-auto" type="submit">Save budget</button>
        </ActionForm>
      </ModalButton>
    );
  };

  return (
    <div className="max-w-5xl">
      <PageHeader title="Money">{canEdit && newButton()}</PageHeader>

      <dl className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className={`rounded-xl border p-4 ${tile.danger ? "border-transparent bg-danger-bg text-danger" : "border-border bg-surface"}`}>
            <dt className={tile.danger ? "text-[15px]" : "muted"}>{tile.label}</dt>
            <dd className="text-2xl font-semibold">{formatMoney(tile.value, true)}</dd>
          </div>
        ))}
      </dl>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          label="Show"
          items={VIEWS.map((v) => ({ href: v === "invoices" ? base : `${base}?view=${v}`, label: VIEW_LABELS[v], active: v === view }))}
        />
        {(view === "invoices" || view === "expenses") && (
          <a className="btn btn-ghost btn-sm" href={`${base}/export?type=${view}`}>
            <Icon name="download" size={18} />
            Download as spreadsheet
          </a>
        )}
      </div>

      {view === "invoices" &&
        (invoices.length === 0 ? (
          <EmptyState
            icon="money"
            title={canEdit ? "Create your first invoice" : "No invoices yet"}
            body="An invoice is a bill you send to a customer. Bizzy keeps track of which ones are paid and which are late."
          >
            {canEdit && newButton("Create an invoice")}
          </EmptyState>
        ) : (
          <>
            <section className="card">
              <ul>
                {invoices.map((invoice) => {
                  const badge = invoiceBadge(invoice, today);
                  const next = invoice.status === "draft" ? "sent" : invoice.status === "sent" ? "paid" : null;
                  return (
                    <li key={invoice.id} className="row">
                      <div className="min-w-0 flex-1">
                        <Link className="font-medium hover:underline" href={`${base}/invoices/${invoice.id}`}>
                          {invoice.customer_name}
                        </Link>
                        <div className="muted">
                          Invoice {invoice.number}
                          {invoice.paid_at
                            ? ` · paid ${formatDate(invoice.paid_at)}`
                            : invoice.due_date
                              ? ` · pay by ${formatDate(invoice.due_date)}`
                              : ""}
                        </div>
                      </div>
                      <span className="font-medium">{formatMoney(invoice.total)}</span>
                      <span className={pillClass(badge.tone)}>{badge.label}</span>
                      {canEdit && next && (
                        <ActionForm action={setInvoiceStatusAction.bind(null, workspaceId)}>
                          <input type="hidden" name="invoiceId" value={invoice.id} />
                          <input type="hidden" name="status" value={next} />
                          <button className="btn btn-sm" type="submit">Mark as {next}</button>
                        </ActionForm>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
            <p className="muted mt-3">
              Bizzy does not email invoices for you. Send the invoice yourself, then press &ldquo;Mark as sent&rdquo;.
            </p>
          </>
        ))}

      {view === "quotes" &&
        (quotes.length === 0 ? (
          <EmptyState
            icon="money"
            title={canEdit ? "Add your first quote" : "No quotes yet"}
            body="A quote is a price you offer a customer before the work starts. Track which ones were accepted."
          >
            {canEdit && newButton("Add a quote")}
          </EmptyState>
        ) : (
          <section className="card">
            <ul>
              {quotes.map((quote) => (
                <li key={quote.id} className="row">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{quote.customer_name}</span>
                    <div className="muted">
                      {[`Quote ${quote.number}`, quote.title, quote.valid_until && `good until ${formatDate(quote.valid_until)}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <span className="font-medium">{formatMoney(quote.amount)}</span>
                  {canEdit ? (
                    <ActionForm action={setQuoteStatusAction.bind(null, workspaceId)}>
                      <input type="hidden" name="quoteId" value={quote.id} />
                      <AutoSelect className="input min-h-9 w-36 py-1 text-[15px]" name="status" defaultValue={quote.status} aria-label={`Status of quote ${quote.number}`}>
                        {QUOTE_STATUSES.map((s) => (
                          <option key={s} value={s}>{humanize(s)}</option>
                        ))}
                      </AutoSelect>
                    </ActionForm>
                  ) : (
                    <span className={pillClass(quote.status === "accepted" ? "ok" : "neutral")}>{humanize(quote.status)}</span>
                  )}
                  {canManage && (
                    <ActionForm action={deleteQuoteAction.bind(null, workspaceId)}>
                      <input type="hidden" name="quoteId" value={quote.id} />
                      <ConfirmButton
                        className="btn btn-sm btn-danger"
                        title={`Delete quote ${quote.number}?`}
                        message={`The quote for ${quote.customer_name} will be removed for good. You can't undo this.`}
                        confirmLabel="Delete quote"
                      >
                        Delete
                      </ConfirmButton>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}

      {view === "expenses" && (
        <>
          {expenses.length === 0 ? (
            <EmptyState
              icon="money"
              title={canEdit ? "Add your first expense" : "No expenses yet"}
              body="Write down what the business spends, so you can see where the money goes each month."
            >
              {canEdit && newButton("Add an expense")}
            </EmptyState>
          ) : (
            <section className="card overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th><th>Paid to</th><th>Category</th><th className="text-right">Amount</th>
                    {canManage && <th><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap">{formatDate(e.spent_on)}</td>
                      <td>{e.vendor}</td>
                      <td>{e.category}</td>
                      <td className="text-right font-medium">{formatMoney(e.amount)}</td>
                      {canManage && (
                        <td className="text-right">
                          <ActionForm action={deleteExpenseAction.bind(null, workspaceId)}>
                            <input type="hidden" name="expenseId" value={e.id} />
                            <ConfirmButton
                              className="btn btn-sm btn-danger"
                              title="Delete this expense?"
                              message={`${formatMoney(e.amount)}${e.vendor ? ` paid to ${e.vendor}` : ""} will be removed for good. You can't undo this.`}
                              confirmLabel="Delete expense"
                            >
                              Delete
                            </ConfirmButton>
                          </ActionForm>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {canEdit && (
            <details className="card mt-6">
              <summary className="cursor-pointer font-semibold">Bring in expenses from a spreadsheet</summary>
              <p className="muted mt-2">
                Save your spreadsheet as a CSV file first. The top row must hold the column names: amount
                (required), date (written like 2026-11-20), category, vendor, notes. Up to 2,000 rows and 2 MB.
              </p>
              <ActionForm action={importExpensesAction.bind(null, workspaceId)} className="mt-4 flex flex-wrap items-center gap-3">
                <input className="max-w-full text-[15px]" type="file" name="file" accept=".csv,text/csv" aria-label="CSV file" required />
                <button className="btn" type="submit">Bring in</button>
              </ActionForm>
            </details>
          )}
        </>
      )}

      {view === "budgets" && budgets && (
        <>
          <form action={base} className="mb-4 flex flex-wrap items-end gap-2">
            <input type="hidden" name="view" value="budgets" />
            <label>
              <span className="label">Month</span>
              <input className="input" type="month" name="month" defaultValue={budgets.month} />
            </label>
            <button className="btn" type="submit">Show month</button>
          </form>
          {budgets.budgets.length === 0 ? (
            <EmptyState
              icon="money"
              title={`No budgets for ${monthName(budgets.month)}`}
              body="A budget is the most you want to spend on something in a month. Bizzy compares it with your expenses."
            >
              {canEdit && newButton("Set a budget")}
            </EmptyState>
          ) : (
            <section className="card">
              <ul>
                {budgets.budgets.map((b) => {
                  const over = b.spent > b.amount;
                  const share = b.amount > 0 ? Math.min(100, Math.round((b.spent / b.amount) * 100)) : 100;
                  return (
                    <li key={b.id} className="row">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="font-medium">{b.category}</span>
                          <span className={over ? "font-medium text-danger" : "muted"}>
                            {formatMoney(b.spent)} of {formatMoney(b.amount)}{over && " · over budget"}
                          </span>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg" aria-hidden="true">
                          <div className={`h-full rounded-full ${over ? "bg-danger" : "bg-accent"}`} style={{ width: `${share}%` }} />
                        </div>
                      </div>
                      {canManage && (
                        <ActionForm action={deleteBudgetAction.bind(null, workspaceId)}>
                          <input type="hidden" name="budgetId" value={b.id} />
                          <ConfirmButton
                            className="btn btn-sm btn-danger"
                            title={`Delete the ${b.category} budget?`}
                            message="Only the budget is removed. Your expenses stay."
                            confirmLabel="Delete budget"
                          >
                            Delete
                          </ConfirmButton>
                        </ActionForm>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {budgets.unbudgeted > 0 && (
            <p className="muted mt-3">{formatMoney(budgets.unbudgeted)} was spent on things that have no budget.</p>
          )}
        </>
      )}
    </div>
  );
}
