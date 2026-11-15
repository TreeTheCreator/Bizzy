import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { getWebCtx } from "@/server/db/web";
import { type Overview, getOverview } from "@/server/modules/overview/service";

export const metadata: Metadata = { title: "Overview" };

function Figure({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div>
      <dt className="muted">{label}</dt>
      <dd className={`text-xl font-semibold ${tone === "danger" ? "text-danger" : ""}`}>{value}</dd>
    </div>
  );
}

function Tasks({ tasks }: { tasks: NonNullable<Overview["totals"]["tasks"]> }) {
  return (
    <>
      <Figure label="Tasks to do" value={String(tasks.open)} />
      <Figure label="Tasks late" value={String(tasks.overdue)} tone={tasks.overdue > 0 ? "danger" : undefined} />
      <Figure label="Yours to do" value={String(tasks.mine)} />
    </>
  );
}

function Customers({ crm }: { crm: NonNullable<Overview["totals"]["crm"]> }) {
  return (
    <>
      <Figure label="Deals in progress" value={String(crm.open_deals)} />
      <Figure label="Worth" value={formatMoney(crm.open_value, true)} />
      <Figure label="Won this month" value={formatMoney(crm.won_this_month, true)} />
    </>
  );
}

function Money({ finance }: { finance: NonNullable<Overview["totals"]["finance"]> }) {
  return (
    <>
      <Figure label="Waiting to be paid" value={formatMoney(finance.unpaid, true)} />
      <Figure label="Late" value={formatMoney(finance.overdue, true)} tone={finance.overdue > 0 ? "danger" : undefined} />
      <Figure label="Paid this month" value={formatMoney(finance.paid_this_month, true)} />
      <Figure label="Spent this month" value={formatMoney(finance.spent_this_month, true)} />
    </>
  );
}

const GRID = "grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 md:grid-cols-4";

export default async function OverviewPage() {
  const ctx = await getWebCtx("/overview");
  const { workspaces, totals } = await getOverview(ctx);
  const several = workspaces.length > 1;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">All your businesses</h1>
        <Link className="btn btn-sm" href="/workspaces">Back to your businesses</Link>
      </div>

      {workspaces.length === 0 ? (
        <EmptyState
          icon="home"
          title="Nothing to show here yet"
          body="This page adds up the businesses where your role includes the Dashboard. Ask the owner of a business if you need it."
        />
      ) : (
        <>
          <p className="muted mb-6">
            You only see numbers from the pages your role includes in each business. Money is rounded to whole amounts.
          </p>

          {several && (totals.tasks || totals.crm || totals.finance) && (
            <section className="card mb-8" aria-labelledby="together">
              <h2 id="together" className="h2 mb-3">Together</h2>
              <dl className={GRID}>
                {totals.tasks && <Tasks tasks={totals.tasks} />}
                {totals.crm && <Customers crm={totals.crm} />}
                {totals.finance && <Money finance={totals.finance} />}
              </dl>
            </section>
          )}

          <ul className="space-y-4">
            {workspaces.map((w) => (
              <li key={w.id}>
                <section className="card" aria-labelledby={`w-${w.id}`}>
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    <h2 id={`w-${w.id}`} className="h2 min-w-0 flex-1 truncate">
                      <Link className="link" href={`/w/${w.id}`}>{w.name}</Link>
                    </h2>
                    {w.is_owner && <span className="pill pill-info">Owner</span>}
                  </div>
                  {w.tasks || w.crm || w.finance ? (
                    <dl className={GRID}>
                      {w.tasks && <Tasks tasks={w.tasks} />}
                      {w.crm && <Customers crm={w.crm} />}
                      {w.finance && <Money finance={w.finance} />}
                    </dl>
                  ) : (
                    <p className="muted">Your role here does not include Tasks, Customers or Money.</p>
                  )}
                </section>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
