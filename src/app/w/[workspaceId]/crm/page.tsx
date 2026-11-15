import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { AutoSelect, ConfirmButton, ModalButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { EmptyState, PageHeader, Tabs } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { authorize } from "@/server/authz/authorize";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import {
  type Company,
  type Contact,
  IMPORT_LIMIT,
  listCompanies,
  listContacts,
  listDeals,
  listStages,
} from "@/server/modules/crm/service";
import { listPeople } from "@/server/modules/members/service";
import {
  createCompanyAction,
  createContactAction,
  createDealAction,
  deleteCompanyAction,
  deleteContactAction,
  importCrmAction,
  invoiceDealAction,
  moveDealAction,
  updateCompanyAction,
  updateContactAction,
} from "./actions";
import { DealFields } from "./deal-fields";

export const metadata: Metadata = { title: "Customers" };

const VIEWS = ["deals", "contacts", "companies"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABELS: Record<View, string> = { deals: "Deals", contacts: "Contacts", companies: "Companies" };

export default async function CrmPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ view?: string; q?: string }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const view: View = VIEWS.find((v) => v === query.view) ?? "deals";
  const ctx = await getWebCtx();

  const loaded = await tryLoad(async () => {
    const access = await authorize(ctx, workspaceId, "crm", "view");
    const [companies, contacts, stages, deals, people] = await Promise.all([
      listCompanies(ctx, workspaceId),
      listContacts(ctx, workspaceId, { query: view === "contacts" ? query.q : undefined }),
      listStages(ctx, workspaceId),
      view === "deals" ? listDeals(ctx, workspaceId) : [],
      listPeople(ctx, workspaceId),
    ]);
    return { access, companies, contacts, stages, deals, people };
  });
  if (loaded.denied) return <NoAccess what="Customers" />;
  const { access, companies, contacts, stages, deals, people } = loaded.data;
  const canEdit = atLeast(access.levels.crm, "edit");
  const canManage = atLeast(access.levels.crm, "manage");
  const canInvoice = atLeast(access.levels.finance, "edit");
  const base = `/w/${workspaceId}/crm`;
  const companyName = (companyId: string | null) => companies.find((c) => c.id === companyId)?.name ?? "";
  const personName = (userId: string | null) => people.find((p) => p.user_id === userId)?.display_name ?? "";

  const contactFields = (c?: Contact) => (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="sm:col-span-2">
        <span className="label">Name</span>
        <input className="input" name="name" defaultValue={c?.name} required maxLength={200} />
      </label>
      <label>
        <span className="label">Email</span>
        <input className="input" name="email" type="email" defaultValue={c?.email} placeholder="name@example.com" maxLength={320} />
      </label>
      <label>
        <span className="label">Phone</span>
        <input className="input" name="phone" type="tel" defaultValue={c?.phone} maxLength={60} />
      </label>
      <label>
        <span className="label">Job title</span>
        <input className="input" name="title" defaultValue={c?.title} maxLength={200} />
      </label>
      <label>
        <span className="label">Company</span>
        <select className="input" name="companyId" defaultValue={c?.company_id ?? ""}>
          <option value="">No company</option>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>{company.name}</option>
          ))}
        </select>
      </label>
    </div>
  );

  const companyFields = (c?: Company) => (
    <div className="space-y-4">
      <label className="block">
        <span className="label">Company name</span>
        <input className="input" name="name" defaultValue={c?.name} required maxLength={200} />
      </label>
      <label className="block">
        <span className="label">Website (optional)</span>
        <input className="input" name="website" defaultValue={c?.website} placeholder="example.com" maxLength={300} />
      </label>
    </div>
  );

  const newButton = (label?: string) =>
    view === "deals" ? (
      <ModalButton label={label ?? "New deal"} title="New deal" icon="plus">
        <ActionForm action={createDealAction.bind(null, workspaceId)}>
          <DealFields stages={stages} companies={companies} contacts={contacts} people={people} />
          <button className="btn btn-primary mt-5 w-full sm:w-auto" type="submit">Add deal</button>
        </ActionForm>
      </ModalButton>
    ) : view === "contacts" ? (
      <ModalButton label={label ?? "New contact"} title="New contact" icon="plus">
        <ActionForm action={createContactAction.bind(null, workspaceId)}>
          {contactFields()}
          <button className="btn btn-primary mt-5 w-full sm:w-auto" type="submit">Add contact</button>
        </ActionForm>
      </ModalButton>
    ) : (
      <ModalButton label={label ?? "New company"} title="New company" icon="plus">
        <ActionForm action={createCompanyAction.bind(null, workspaceId)}>
          {companyFields()}
          <button className="btn btn-primary mt-5 w-full sm:w-auto" type="submit">Add company</button>
        </ActionForm>
      </ModalButton>
    );

  return (
    <div className="max-w-6xl">
      <PageHeader title="Customers">{canEdit && newButton()}</PageHeader>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          label="Show"
          items={VIEWS.map((v) => ({ href: v === "deals" ? base : `${base}?view=${v}`, label: VIEW_LABELS[v], active: v === view }))}
        />
        <a className="btn btn-ghost btn-sm" href={`${base}/export?type=${view}`}>
          <Icon name="download" size={18} />
          Download as spreadsheet
        </a>
      </div>

      {view === "deals" &&
        (deals.length === 0 ? (
          <EmptyState
            icon="customers"
            title={canEdit ? "Add your first deal" : "No deals yet"}
            body="A deal is a sale you are working on. Follow it from first contact until it is won."
          >
            {canEdit && newButton("Add a deal")}
          </EmptyState>
        ) : (
          <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {stages.map((stage) => {
              const column = deals.filter((d) => d.stage_id === stage.id);
              const total = column.reduce((sum, d) => sum + d.amount, 0);
              return (
                <section key={stage.id} className="card p-4" aria-label={stage.name}>
                  <h2 className="h2">
                    {stage.name} <span className="font-normal text-muted">{column.length}</span>
                  </h2>
                  <p className="muted mb-3">{formatMoney(total, true)}</p>
                  <ul className="space-y-3">
                    {column.map((deal) => (
                      <li key={deal.id} className="rounded-lg border border-border p-3">
                        <Link className="font-medium hover:underline" href={`${base}/deals/${deal.id}`}>{deal.title}</Link>
                        <div className="muted">
                          {[formatMoney(deal.amount, true), companyName(deal.company_id), personName(deal.owner_id)]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                        {canEdit && (
                          <ActionForm action={moveDealAction.bind(null, workspaceId)} className="mt-2">
                            <input type="hidden" name="dealId" value={deal.id} />
                            <AutoSelect className="input min-h-9 py-1 text-[15px]" name="stageId" defaultValue={deal.stage_id} aria-label={`Move "${deal.title}" to`}>
                              {stages.map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                              ))}
                            </AutoSelect>
                          </ActionForm>
                        )}
                        {stage.kind === "won" && canInvoice && (
                          <ActionForm action={invoiceDealAction.bind(null, workspaceId)} className="mt-2">
                            <input type="hidden" name="dealId" value={deal.id} />
                            <button className="btn btn-sm w-full" type="submit">Make an invoice</button>
                          </ActionForm>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        ))}

      {view === "contacts" && (
        <>
          {(contacts.length > 0 || query.q) && (
            <form action={base} className="mb-4 flex flex-wrap gap-2" role="search">
              <input type="hidden" name="view" value="contacts" />
              <input className="input max-w-sm" type="search" name="q" defaultValue={query.q ?? ""} placeholder="Search by name or email" aria-label="Search contacts" />
              <button className="btn" type="submit">Search</button>
              {query.q && <Link className="btn btn-ghost" href={`${base}?view=contacts`}>Show everyone</Link>}
            </form>
          )}
          {contacts.length === 0 ? (
            query.q ? (
              <div className="card"><p className="muted">Nobody matches &ldquo;{query.q}&rdquo;.</p></div>
            ) : (
              <EmptyState
                icon="customers"
                title={canEdit ? "Add your first contact" : "No contacts yet"}
                body="Keep the names, emails and phone numbers of the people you do business with in one place."
              >
                {canEdit && newButton("Add a contact")}
              </EmptyState>
            )
          ) : (
            <section className="card overflow-x-auto">
              <table className="table">
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Phone</th><th>Company</th>{canEdit && <th><span className="sr-only">Actions</span></th>}</tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <span className="font-medium">{c.name}</span>
                        {c.title && <span className="muted block">{c.title}</span>}
                      </td>
                      <td>{c.email && <a className="link" href={`mailto:${c.email}`}>{c.email}</a>}</td>
                      <td>{c.phone && <a className="link whitespace-nowrap" href={`tel:${c.phone}`}>{c.phone}</a>}</td>
                      <td>{companyName(c.company_id)}</td>
                      {canEdit && (
                        <td className="text-right">
                          <ModalButton label="Edit" title={`Edit ${c.name}`} className="btn btn-sm">
                            <ActionForm action={updateContactAction.bind(null, workspaceId)}>
                              <input type="hidden" name="contactId" value={c.id} />
                              {contactFields(c)}
                              <button className="btn btn-primary mt-5" type="submit">Save changes</button>
                            </ActionForm>
                            {canManage && (
                              <ActionForm action={deleteContactAction.bind(null, workspaceId)} className="mt-4 border-t border-border pt-4">
                                <input type="hidden" name="contactId" value={c.id} />
                                <ConfirmButton
                                  title={`Delete ${c.name}?`}
                                  message="This contact will be removed for good. You can't undo this."
                                  confirmLabel="Delete contact"
                                >
                                  Delete contact
                                </ConfirmButton>
                              </ActionForm>
                            )}
                          </ModalButton>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {view === "companies" &&
        (companies.length === 0 ? (
          <EmptyState
            icon="customers"
            title={canEdit ? "Add your first company" : "No companies yet"}
            body="Add the businesses you work with, then link your contacts and deals to them."
          >
            {canEdit && newButton("Add a company")}
          </EmptyState>
        ) : (
          <section className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Company</th><th>Website</th><th>Contacts</th>{canEdit && <th><span className="sr-only">Actions</span></th>}</tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={c.id}>
                    <td className="font-medium">{c.name}</td>
                    <td>{c.website}</td>
                    <td>{contacts.filter((p) => p.company_id === c.id).length}</td>
                    {canEdit && (
                      <td className="text-right">
                        <ModalButton label="Edit" title={`Edit ${c.name}`} className="btn btn-sm">
                          <ActionForm action={updateCompanyAction.bind(null, workspaceId)}>
                            <input type="hidden" name="companyId" value={c.id} />
                            {companyFields(c)}
                            <button className="btn btn-primary mt-5" type="submit">Save changes</button>
                          </ActionForm>
                          {canManage && (
                            <ActionForm action={deleteCompanyAction.bind(null, workspaceId)} className="mt-4 border-t border-border pt-4">
                              <input type="hidden" name="companyId" value={c.id} />
                              <ConfirmButton
                                title={`Delete ${c.name}?`}
                                message="This company will be removed for good. Its contacts stay, without a company. You can't undo this."
                                confirmLabel="Delete company"
                              >
                                Delete company
                              </ConfirmButton>
                            </ActionForm>
                          )}
                        </ModalButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}

      {canEdit && view !== "deals" && (
        <details className="card mt-6">
          <summary className="cursor-pointer font-semibold">Bring in {view} from a spreadsheet</summary>
          <p className="muted mt-2">
            Save your spreadsheet as a CSV file first. The top row must hold the column names:{" "}
            {view === "contacts"
              ? "name (required), email, phone, title, company, notes. A company that isn't in Bizzy yet is added for you."
              : "name (required), website, notes."}{" "}
            Up to {IMPORT_LIMIT.toLocaleString("en-US")} rows and 2 MB.
          </p>
          <ActionForm action={importCrmAction.bind(null, workspaceId)} className="mt-4 flex flex-wrap items-center gap-3">
            <input type="hidden" name="type" value={view} />
            <input className="max-w-full text-[15px]" type="file" name="file" accept=".csv,text/csv" aria-label="CSV file" required />
            <button className="btn" type="submit">Bring in</button>
          </ActionForm>
        </details>
      )}
    </div>
  );
}
