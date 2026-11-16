import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { Invalid, NotFound, unwrap } from "@/server/errors";
import { id, isoDate, parse } from "@/server/validate";

export interface Company {
  id: string;
  name: string;
  website: string;
  notes: string;
  created_at: string;
}

export interface Contact {
  id: string;
  company_id: string | null;
  name: string;
  email: string;
  phone: string;
  title: string;
  notes: string;
  created_at: string;
}

export interface DealStage {
  id: string;
  name: string;
  position: number;
  kind: "open" | "won" | "lost";
}

export interface Deal {
  id: string;
  workspace_id: string;
  title: string;
  amount: number;
  stage_id: string;
  company_id: string | null;
  contact_id: string | null;
  owner_id: string | null;
  expected_close: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

const COMPANY_COLUMNS = "id, name, website, notes, created_at";
const CONTACT_COLUMNS = "id, company_id, name, email, phone, title, notes, created_at";
const DEAL_COLUMNS =
  "id, workspace_id, title, amount, stage_id, company_id, contact_id, owner_id, expected_close, notes, created_at, updated_at, closed_at";

/** Most rows one import may add. */
export const IMPORT_LIMIT = 2000;

export const money = z.coerce.number().min(0, "can't be negative").max(999_999_999_999).multipleOf(0.01, "at most 2 decimal places");

// Rules WITHOUT defaults (see tasks/service.ts): partial updates leave unsent fields alone.
const companyRules = z.object({
  name: z.string().trim().min(1, "is required").max(200),
  website: z.string().trim().max(300),
  notes: z.string().max(10000),
});
const companyFields = companyRules.extend({
  website: companyRules.shape.website.default(""),
  notes: companyRules.shape.notes.default(""),
});
export type CompanyInput = z.input<typeof companyFields>;

const contactRules = z.object({
  name: z.string().trim().min(1, "is required").max(200),
  email: z.union([z.literal(""), z.email("must be an email address").max(320)]),
  phone: z.string().trim().max(60),
  title: z.string().trim().max(200),
  notes: z.string().max(10000),
  companyId: id.nullable(),
});
const contactFields = contactRules.extend({
  email: contactRules.shape.email.default(""),
  phone: contactRules.shape.phone.default(""),
  title: contactRules.shape.title.default(""),
  notes: contactRules.shape.notes.default(""),
  companyId: contactRules.shape.companyId.default(null),
});
export type ContactInput = z.input<typeof contactFields>;

const dealRules = z.object({
  title: z.string().trim().min(1, "is required").max(200),
  amount: money,
  stageId: id,
  companyId: id.nullable(),
  contactId: id.nullable(),
  ownerId: id.nullable(),
  expectedClose: isoDate.nullable(),
  notes: z.string().max(10000),
});
const dealUpdate = dealRules.partial();
const dealFields = dealRules.extend({
  amount: dealRules.shape.amount.default(0),
  // Left out = the first stage of the board.
  stageId: dealRules.shape.stageId.optional(),
  companyId: dealRules.shape.companyId.default(null),
  contactId: dealRules.shape.contactId.default(null),
  ownerId: dealRules.shape.ownerId.default(null),
  expectedClose: dealRules.shape.expectedClose.default(null),
  notes: dealRules.shape.notes.default(""),
});
export type DealInput = z.input<typeof dealFields>;

function dealRow(data: z.infer<typeof dealUpdate>) {
  const row: Record<string, unknown> = {};
  if (data.title !== undefined) row.title = data.title;
  if (data.amount !== undefined) row.amount = data.amount;
  if (data.stageId !== undefined) row.stage_id = data.stageId;
  if (data.companyId !== undefined) row.company_id = data.companyId;
  if (data.contactId !== undefined) row.contact_id = data.contactId;
  if (data.ownerId !== undefined) row.owner_id = data.ownerId;
  if (data.expectedClose !== undefined) row.expected_close = data.expectedClose;
  if (data.notes !== undefined) row.notes = data.notes;
  return row;
}

function contactRow(data: Partial<z.infer<typeof contactRules>>) {
  const { companyId, ...rest } = data;
  return { ...rest, ...(companyId !== undefined && { company_id: companyId }) };
}

/** PostgREST returns numeric columns as numbers or strings depending on size. */
const withAmount = <T extends { amount: unknown }>(row: T) => ({ ...row, amount: Number(row.amount) });

async function removeRow(ctx: Ctx, table: string, workspaceId: string, rowId: string, what: string) {
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from(table).delete().eq("workspace_id", workspaceId).eq("id", parse(id, rowId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound(what);
}

async function updateRow(
  ctx: Ctx,
  table: string,
  workspaceId: string,
  rowId: string,
  row: Record<string, unknown>,
  what: string,
) {
  if (Object.keys(row).length === 0) return;
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from(table).update(row).eq("workspace_id", workspaceId).eq("id", parse(id, rowId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound(what);
}

// --- Companies --------------------------------------------------------------

export async function listCompanies(ctx: Ctx, workspaceId: string): Promise<Company[]> {
  await authorize(ctx, parse(id, workspaceId), "crm", "view");
  return unwrap<Company[]>(
    await ctx.db.from("companies").select(COMPANY_COLUMNS).eq("workspace_id", workspaceId).order("name").limit(5000),
  );
}

export async function createCompany(ctx: Ctx, workspaceId: string, input: CompanyInput): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "crm", "edit");
  const data = parse(companyFields, input);
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("companies")
      .insert({ workspace_id: workspaceId, ...data, created_by: ctx.userId })
      .select("id")
      .single(),
  );
  return row.id;
}

export async function updateCompany(
  ctx: Ctx,
  workspaceId: string,
  companyId: string,
  input: Partial<CompanyInput>,
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "crm", "edit");
  await updateRow(ctx, "companies", workspaceId, companyId, parse(companyRules.partial(), input), "Company");
}

/** Delete a company. Its contacts and deals are kept and lose the link. */
export async function deleteCompany(ctx: Ctx, workspaceId: string, companyId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "crm", "manage");
  await removeRow(ctx, "companies", workspaceId, companyId, "Company");
}

/** Add many companies at once (CSV import). Returns how many were added. */
export async function importCompanies(ctx: Ctx, workspaceId: string, input: CompanyInput[]): Promise<number> {
  await authorize(ctx, parse(id, workspaceId), "crm", "edit");
  const rows = parse(z.array(companyFields).min(1, "the file has no rows").max(IMPORT_LIMIT), input);
  unwrap(
    await ctx.db.from("companies").insert(rows.map((r) => ({ workspace_id: workspaceId, ...r, created_by: ctx.userId }))),
  );
  return rows.length;
}

// --- Contacts ---------------------------------------------------------------

export async function listContacts(
  ctx: Ctx,
  workspaceId: string,
  filter: { query?: string; companyId?: string | null } = {},
): Promise<Contact[]> {
  await authorize(ctx, parse(id, workspaceId), "crm", "view");
  let query = ctx.db.from("contacts").select(CONTACT_COLUMNS).eq("workspace_id", workspaceId);
  if (filter.companyId) query = query.eq("company_id", parse(id, filter.companyId));
  // Strip characters that have a meaning in a PostgREST filter or a LIKE pattern.
  const phrase = (filter.query ?? "").replace(/[%_\\,()"*]/g, " ").trim().slice(0, 100);
  if (phrase) query = query.or(`name.ilike.%${phrase}%,email.ilike.%${phrase}%`);
  return unwrap<Contact[]>(await query.order("name").limit(5000));
}

export async function createContact(ctx: Ctx, workspaceId: string, input: ContactInput): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "crm", "edit");
  const data = parse(contactFields, input);
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("contacts")
      .insert({ workspace_id: workspaceId, ...contactRow(data), created_by: ctx.userId })
      .select("id")
      .single(),
  );
  return row.id;
}

export async function updateContact(
  ctx: Ctx,
  workspaceId: string,
  contactId: string,
  input: Partial<ContactInput>,
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "crm", "edit");
  const data = parse(contactRules.partial(), input);
  await updateRow(ctx, "contacts", workspaceId, contactId, contactRow(data), "Contact");
}

export async function deleteContact(ctx: Ctx, workspaceId: string, contactId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "crm", "manage");
  await removeRow(ctx, "contacts", workspaceId, contactId, "Contact");
}

/**
 * Add many contacts at once (CSV import). A row may name its company; the name
 * is matched to an existing company or a new one is created.
 */
export async function importContacts(
  ctx: Ctx,
  workspaceId: string,
  input: (Omit<ContactInput, "companyId"> & { company?: string })[],
): Promise<number> {
  await authorize(ctx, parse(id, workspaceId), "crm", "edit");
  const rows = parse(
    z
      .array(contactFields.omit({ companyId: true }).extend({ company: z.string().trim().max(200).default("") }))
      .min(1, "the file has no rows")
      .max(IMPORT_LIMIT),
    input,
  );
  const existing = unwrap<{ id: string; name: string }[]>(
    await ctx.db.from("companies").select("id, name").eq("workspace_id", workspaceId).limit(5000),
  );
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
  // One new company per distinct name, ignoring case ("Bolt" and "bolt" are the same company).
  const missing = [
    ...new Map(
      rows
        .map((r) => r.company)
        .filter((name) => name && !byName.has(name.toLowerCase()))
        .map((name) => [name.toLowerCase(), name] as const)
        .reverse(),
    ).values(),
  ];
  if (missing.length > 0) {
    const created = unwrap<{ id: string; name: string }[]>(
      await ctx.db
        .from("companies")
        .insert(missing.map((name) => ({ workspace_id: workspaceId, name, created_by: ctx.userId })))
        .select("id, name"),
    );
    for (const c of created) byName.set(c.name.toLowerCase(), c.id);
  }
  unwrap(
    await ctx.db.from("contacts").insert(
      rows.map(({ company, ...r }) => ({
        workspace_id: workspaceId,
        ...r,
        company_id: byName.get(company.toLowerCase()) ?? null,
        created_by: ctx.userId,
      })),
    ),
  );
  return rows.length;
}

// --- Deals ------------------------------------------------------------------

export async function listStages(ctx: Ctx, workspaceId: string): Promise<DealStage[]> {
  await authorize(ctx, parse(id, workspaceId), "crm", "view");
  return unwrap<DealStage[]>(
    await ctx.db.from("deal_stages").select("id, name, position, kind").eq("workspace_id", workspaceId).order("position"),
  );
}

export async function listDeals(
  ctx: Ctx,
  workspaceId: string,
  filter: { stageId?: string | null; openOnly?: boolean } = {},
): Promise<Deal[]> {
  await authorize(ctx, parse(id, workspaceId), "crm", "view");
  let query = ctx.db.from("deals").select(DEAL_COLUMNS).eq("workspace_id", workspaceId);
  if (filter.stageId) query = query.eq("stage_id", parse(id, filter.stageId));
  if (filter.openOnly) query = query.is("closed_at", null);
  const rows = unwrap<Deal[]>(await query.order("created_at", { ascending: false }).limit(2000));
  return rows.map(withAmount);
}

export async function getDeal(ctx: Ctx, workspaceId: string, dealId: string): Promise<Deal> {
  await authorize(ctx, parse(id, workspaceId), "crm", "view");
  const deal = unwrap<Deal | null>(
    await ctx.db.from("deals").select(DEAL_COLUMNS).eq("workspace_id", workspaceId).eq("id", parse(id, dealId)).maybeSingle(),
  );
  if (!deal) throw new NotFound("Deal");
  return withAmount(deal);
}

export async function createDeal(ctx: Ctx, workspaceId: string, input: DealInput): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "crm", "edit");
  const data = parse(dealFields, input);
  if (!data.stageId) {
    const first = unwrap<{ id: string }[]>(
      await ctx.db.from("deal_stages").select("id").eq("workspace_id", workspaceId).order("position").limit(1),
    );
    if (first.length === 0) throw new Invalid("This workspace has no deal stages.");
    data.stageId = first[0].id;
  }
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("deals")
      .insert({ workspace_id: workspaceId, ...dealRow(data), created_by: ctx.userId })
      .select("id")
      .single(),
  );
  return row.id;
}

/** Change a deal. Moving it to a won or lost stage closes it; moving it back reopens it. */
export async function updateDeal(
  ctx: Ctx,
  workspaceId: string,
  dealId: string,
  input: Partial<DealInput>,
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "crm", "edit");
  await updateRow(ctx, "deals", workspaceId, dealId, dealRow(parse(dealUpdate, input)), "Deal");
}

export async function deleteDeal(ctx: Ctx, workspaceId: string, dealId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "crm", "manage");
  await removeRow(ctx, "deals", workspaceId, dealId, "Deal");
}
