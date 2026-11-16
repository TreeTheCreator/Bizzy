import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { AutoSelect, ConfirmButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { BackLink } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { authorize } from "@/server/authz/authorize";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { INVOICE_STATUSES, getInvoice } from "@/server/modules/finance/service";
import {
  addLineAction,
  deleteInvoiceAction,
  deleteLineAction,
  setInvoiceStatusAction,
  updateInvoiceAction,
} from "../../actions";
import { INVOICE_STATUS_LABELS } from "../../labels";

export const metadata: Metadata = { title: "Invoice" };

export default async function InvoicePage({ params }: { params: Promise<{ workspaceId: string; invoiceId: string }> }) {
  const { workspaceId, invoiceId } = await params;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const access = await authorize(ctx, workspaceId, "finance", "view");
    return { access, ...(await getInvoice(ctx, workspaceId, invoiceId)) };
  });
  if (loaded.denied) return <NoAccess what="Money" />;
  const { access, invoice, lines } = loaded.data;
  const canEdit = atLeast(access.levels.finance, "edit");
  const draft = invoice.status === "draft";
  const pillTone = invoice.status === "paid" ? "pill pill-ok" : invoice.status === "sent" ? "pill pill-info" : "pill";

  return (
    <div className="max-w-3xl">
      <BackLink href={`/w/${workspaceId}/finance`}>Back to invoices</BackLink>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1 flex flex-wrap items-center gap-3">
          Invoice {invoice.number}
          {!canEdit && <span className={`${pillTone} font-normal`}>{INVOICE_STATUS_LABELS[invoice.status]}</span>}
        </h1>
        {canEdit && (
          <ActionForm action={setInvoiceStatusAction.bind(null, workspaceId)} className="flex items-center gap-2">
            <input type="hidden" name="invoiceId" value={invoice.id} />
            <label className="muted" htmlFor="invoice-status">Status</label>
            <AutoSelect className="input w-56" id="invoice-status" name="status" defaultValue={invoice.status}>
              {INVOICE_STATUSES.map((s) => (
                <option key={s} value={s}>{INVOICE_STATUS_LABELS[s]}</option>
              ))}
            </AutoSelect>
          </ActionForm>
        )}
      </div>

      <section className="card mb-6">
        {canEdit ? (
          <ActionForm action={updateInvoiceAction.bind(null, workspaceId, invoiceId)} className="grid gap-4 sm:grid-cols-2" successMessage="Saved.">
            <label><span className="label">Who is it for?</span><input className="input" name="customerName" defaultValue={invoice.customer_name} required maxLength={200} /></label>
            <label><span className="label">Pay by</span><input className="input" name="dueDate" type="date" defaultValue={invoice.due_date ?? ""} /></label>
            <label className="sm:col-span-2"><span className="label">Notes (optional)</span><textarea className="input min-h-20" name="notes" defaultValue={invoice.notes} maxLength={10000} /></label>
            <div><button className="btn btn-primary" type="submit">Save changes</button></div>
          </ActionForm>
        ) : (
          <p>
            {invoice.customer_name} · {invoice.due_date ? `pay by ${formatDate(invoice.due_date)}` : "no pay-by date"}
            {invoice.notes && <span className="mt-2 block whitespace-pre-wrap">{invoice.notes}</span>}
          </p>
        )}
        <p className="muted mt-4">
          Created {formatDate(invoice.issue_date)}
          {invoice.sent_at && ` · sent ${formatDate(invoice.sent_at)}`}
          {invoice.paid_at && ` · paid ${formatDate(invoice.paid_at)}`}
        </p>
      </section>

      <section className="card mb-6">
        <h2 className="h2 mb-3">What you are charging for</h2>
        {lines.length === 0 ? (
          <p className="muted">Nothing added yet.{canEdit && draft && " Add the first item below."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th><th className="text-right">How many</th><th className="text-right">Price each</th><th className="text-right">Amount</th>
                  {canEdit && draft && <th><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.description}</td>
                    <td className="text-right">{line.quantity}</td>
                    <td className="text-right">{formatMoney(line.unit_price)}</td>
                    <td className="text-right font-medium">{formatMoney(Math.round(line.quantity * line.unit_price * 100) / 100)}</td>
                    {canEdit && draft && (
                      <td className="text-right">
                        <ActionForm action={deleteLineAction.bind(null, workspaceId)}>
                          <input type="hidden" name="lineId" value={line.id} />
                          <button className="btn btn-sm btn-ghost" type="submit">Remove</button>
                        </ActionForm>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 flex items-baseline justify-end gap-3 border-t border-border pt-4">
          <span className="muted">Total</span>
          <span className="text-2xl font-semibold">{formatMoney(invoice.total)}</span>
        </p>
        {canEdit && draft && (
          <ActionForm action={addLineAction.bind(null, workspaceId, invoiceId)} className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
            <label className="min-w-48 flex-1"><span className="label">Item</span><input className="input" name="description" placeholder="Birthday cake" required maxLength={500} /></label>
            <label><span className="label">How many</span><input className="input w-24" name="quantity" type="number" inputMode="decimal" min="0.01" step="0.01" defaultValue="1" /></label>
            <label><span className="label">Price each</span><input className="input w-32" name="unitPrice" type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" required /></label>
            <button className="btn" type="submit">Add item</button>
          </ActionForm>
        )}
        {canEdit && !draft && (
          <p className="muted mt-3">To change the items, set the status back to &ldquo;Draft&rdquo; first.</p>
        )}
      </section>

      {atLeast(access.levels.finance, "manage") && (
        <ActionForm action={deleteInvoiceAction.bind(null, workspaceId, invoiceId)}>
          <ConfirmButton
            title="Delete this invoice?"
            message={`Invoice ${invoice.number} for ${invoice.customer_name} will be removed for good. You can't undo this.`}
            confirmLabel="Delete invoice"
          >
            Delete invoice
          </ConfirmButton>
        </ActionForm>
      )}
    </div>
  );
}
