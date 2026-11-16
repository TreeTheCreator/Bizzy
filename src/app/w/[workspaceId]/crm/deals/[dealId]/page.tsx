import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { BackLink } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { authorize } from "@/server/authz/authorize";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { getDeal, listCompanies, listContacts, listStages } from "@/server/modules/crm/service";
import { listPeople } from "@/server/modules/members/service";
import { deleteDealAction, invoiceDealAction, updateDealAction } from "../../actions";
import { DealFields } from "../../deal-fields";

export const metadata: Metadata = { title: "Deal" };

export default async function DealPage({ params }: { params: Promise<{ workspaceId: string; dealId: string }> }) {
  const { workspaceId, dealId } = await params;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const access = await authorize(ctx, workspaceId, "crm", "view");
    const [deal, stages, companies, contacts, people] = await Promise.all([
      getDeal(ctx, workspaceId, dealId),
      listStages(ctx, workspaceId),
      listCompanies(ctx, workspaceId),
      listContacts(ctx, workspaceId),
      listPeople(ctx, workspaceId),
    ]);
    return { access, deal, stages, companies, contacts, people };
  });
  if (loaded.denied) return <NoAccess what="Customers" />;
  const { access, deal, stages, companies, contacts, people } = loaded.data;
  const canEdit = atLeast(access.levels.crm, "edit");
  const stage = stages.find((s) => s.id === deal.stage_id);

  return (
    <div className="max-w-3xl">
      <BackLink href={`/w/${workspaceId}/crm`}>Back to deals</BackLink>

      {canEdit ? (
        <section className="card mb-6">
          <h1 className="h1 mb-4">Deal</h1>
          <ActionForm action={updateDealAction.bind(null, workspaceId, dealId)} successMessage="Saved.">
            <DealFields deal={deal} stages={stages} companies={companies} contacts={contacts} people={people} />
            <button className="btn btn-primary mt-5" type="submit">Save changes</button>
          </ActionForm>
        </section>
      ) : (
        <section className="card mb-6">
          <h1 className="h1 mb-2">{deal.title}</h1>
          <p className="muted mb-3">
            {[formatMoney(deal.amount), stage?.name, companies.find((c) => c.id === deal.company_id)?.name, deal.expected_close && `answer expected ${formatDate(deal.expected_close)}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="whitespace-pre-wrap">{deal.notes || "No notes."}</p>
        </section>
      )}

      <div className="flex flex-wrap items-start justify-between gap-2">
        {atLeast(access.levels.finance, "edit") && (
          <ActionForm action={invoiceDealAction.bind(null, workspaceId)}>
            <input type="hidden" name="dealId" value={deal.id} />
            <button className="btn" type="submit">Make an invoice from this deal</button>
          </ActionForm>
        )}
        {atLeast(access.levels.crm, "manage") && (
          <ActionForm action={deleteDealAction.bind(null, workspaceId, dealId)}>
            <ConfirmButton
              title="Delete this deal?"
              message={`"${deal.title}" will be removed for good. You can't undo this.`}
              confirmLabel="Delete deal"
            >
              Delete deal
            </ConfirmButton>
          </ActionForm>
        )}
      </div>
    </div>
  );
}
