import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { ConfirmButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { EmptyState, PageHeader, Tabs } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { getWebCtx } from "@/server/db/web";
import {
  PERIODS,
  PERIOD_LABELS,
  type Period,
  REPORTS,
  type ReportKind,
  listReports,
  runReport,
} from "@/server/modules/reports/service";
import { deleteSavedReportAction, saveReportAction } from "./actions";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ kind?: string; period?: string }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const ctx = await getWebCtx();
  const base = `/w/${workspaceId}/reports`;

  const loaded = await tryLoad(async () => {
    const available = await listReports(ctx, workspaceId);
    const kind = available.kinds.find((k) => k === query.kind) ?? available.kinds[0];
    const period: Period = PERIODS.find((p) => p === query.period) ?? "this_month";
    const report = kind ? await runReport(ctx, workspaceId, { kind, period }) : null;
    return { ...available, report };
  });
  if (loaded.denied) return <NoAccess what="any reports" />;
  const { kinds, saved, canSave, report } = loaded.data;

  if (!report) {
    return (
      <div className="max-w-5xl">
        <PageHeader title="Reports" />
        <EmptyState
          icon="docs"
          title="No reports for your role"
          body="Reports are drawn from Tasks, Customers, Money and HR. Your role does not include any of those pages."
        />
      </div>
    );
  }

  const href = (kind: ReportKind, period: Period) => `${base}?kind=${kind}&period=${period}`;
  const show = (value: string | number, type: "text" | "number" | "money") =>
    type === "money" ? formatMoney(Number(value)) : String(value);
  const moneyTotals = report.columns
    .filter((c) => c.type !== "text")
    .map((c) => ({ ...c, total: report.rows.reduce((sum, row) => sum + Number(row[c.key]), 0) }));

  return (
    <div className="max-w-5xl">
      <PageHeader title="Reports" />

      <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
        <nav aria-label="Choose a report" className="space-y-6">
          <ul className="space-y-1">
            {kinds.map((kind) => (
              <li key={kind}>
                <Link
                  className={`nav-link ${kind === report.kind ? "nav-link-on" : ""}`}
                  href={href(kind, report.period)}
                  aria-current={kind === report.kind ? "page" : undefined}
                >
                  {REPORTS[kind].title}
                </Link>
              </li>
            ))}
          </ul>

          {saved.length > 0 && (
            <section aria-labelledby="saved-reports">
              <h2 id="saved-reports" className="label mb-2">Saved reports</h2>
              <ul className="space-y-2">
                {saved.map((s) => (
                  <li key={s.id} className="flex items-start justify-between gap-2">
                    <Link className="link min-w-0 break-words" href={href(s.kind, s.period)}>
                      {s.name}
                      <span className="muted block">{REPORTS[s.kind].title} · {PERIOD_LABELS[s.period]}</span>
                    </Link>
                    {(canSave.includes(s.kind) && s.created_by === ctx.userId) && (
                      <ActionForm action={deleteSavedReportAction.bind(null, workspaceId)}>
                        <input type="hidden" name="reportId" value={s.id} />
                        <ConfirmButton
                          className="btn btn-ghost btn-sm"
                          title={`Remove "${s.name}"?`}
                          message="Only the saved shortcut is removed. No data is deleted."
                          confirmLabel="Remove"
                        >
                          <Icon name="close" size={16} />
                          <span className="sr-only">Remove {s.name}</span>
                        </ConfirmButton>
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </nav>

        <section aria-labelledby="report-title" className="min-w-0">
          <h2 id="report-title" className="h2">{REPORTS[report.kind].title}</h2>
          <p className="muted mb-4">
            {REPORTS[report.kind].about} {formatDate(report.from)} to {formatDate(report.to)}.
          </p>

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Tabs
              label="Period"
              items={PERIODS.map((p) => ({ href: href(report.kind, p), label: PERIOD_LABELS[p], active: p === report.period }))}
            />
            <a className="btn btn-ghost btn-sm" href={`${base}/export?kind=${report.kind}&period=${report.period}`}>
              <Icon name="download" size={18} />
              Download as spreadsheet
            </a>
          </div>

          {report.rows.length === 0 ? (
            <div className="card muted">Nothing to report for this period.</div>
          ) : (
            <div className="card overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    {report.columns.map((c) => (
                      <th key={c.key} className={c.type === "text" ? "" : "text-right"}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row, index) => (
                    <tr key={index}>
                      {report.columns.map((c) => (
                        <td key={c.key} className={c.type === "text" ? "font-medium" : "text-right tabular-nums"}>
                          {show(row[c.key], c.type)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {report.rows.length > 1 && (
                  <tfoot>
                    <tr>
                      <th scope="row" className="text-left">Total</th>
                      {moneyTotals.map((c) => (
                        <td key={c.key} className="text-right font-semibold tabular-nums">
                          {show(Math.round(c.total * 100) / 100, c.type)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

          {canSave.includes(report.kind) && (
            <ActionForm action={saveReportAction.bind(null, workspaceId)} className="mt-6 flex flex-wrap items-end gap-2">
              <input type="hidden" name="kind" value={report.kind} />
              <input type="hidden" name="period" value={report.period} />
              <label className="block">
                <span className="label">Save this report as</span>
                <input className="input w-64" name="name" required maxLength={120} placeholder="Monthly spending" />
              </label>
              <button className="btn" type="submit">Save report</button>
            </ActionForm>
          )}
        </section>
      </div>
    </div>
  );
}
