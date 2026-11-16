"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionState, run, str, strOrNull } from "@/app/_lib/action";
import { readCsvRecords } from "@/server/csv";
import { getWebCtx } from "@/server/db/web";
import { Invalid } from "@/server/errors";
import {
  type DealInput,
  createCompany,
  createContact,
  createDeal,
  deleteCompany,
  deleteContact,
  deleteDeal,
  importCompanies,
  importContacts,
  updateCompany,
  updateContact,
  updateDeal,
} from "@/server/modules/crm/service";
import { createInvoice } from "@/server/modules/finance/service";

// Permission checks live in the service functions; these only translate forms.

function refresh(workspaceId: string) {
  revalidatePath(`/w/${workspaceId}`, "layout");
}

function readDeal(formData: FormData): DealInput {
  return {
    title: str(formData, "title"),
    amount: str(formData, "amount") || 0,
    stageId: str(formData, "stageId") || undefined,
    companyId: strOrNull(formData, "companyId"),
    contactId: strOrNull(formData, "contactId"),
    ownerId: strOrNull(formData, "ownerId"),
    expectedClose: strOrNull(formData, "expectedClose"),
    notes: str(formData, "notes"),
  };
}

const readContact = (formData: FormData) => ({
  name: str(formData, "name"),
  email: str(formData, "email"),
  phone: str(formData, "phone"),
  title: str(formData, "title"),
  companyId: strOrNull(formData, "companyId"),
});

const readCompany = (formData: FormData) => ({ name: str(formData, "name"), website: str(formData, "website") });

export async function createDealAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await createDeal(await getWebCtx(), workspaceId, readDeal(formData));
    refresh(workspaceId);
  });
}

export async function updateDealAction(workspaceId: string, dealId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await updateDeal(await getWebCtx(), workspaceId, dealId, readDeal(formData));
    refresh(workspaceId);
  });
}

export async function moveDealAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await updateDeal(await getWebCtx(), workspaceId, str(formData, "dealId"), { stageId: str(formData, "stageId") });
    refresh(workspaceId);
  });
}

export async function deleteDealAction(workspaceId: string, dealId: string, _prev: ActionState, _formData: FormData) {
  return run(async () => {
    await deleteDeal(await getWebCtx(), workspaceId, dealId);
    refresh(workspaceId);
    redirect(`/w/${workspaceId}/crm`);
  });
}

/** Start a draft invoice from a deal (needs Finance edit as well as CRM view). */
export async function invoiceDealAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const invoiceId = await createInvoice(await getWebCtx(), workspaceId, { dealId: str(formData, "dealId") });
    refresh(workspaceId);
    redirect(`/w/${workspaceId}/finance/invoices/${invoiceId}`);
  });
}

export async function createContactAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await createContact(await getWebCtx(), workspaceId, readContact(formData));
    refresh(workspaceId);
  });
}

export async function updateContactAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await updateContact(await getWebCtx(), workspaceId, str(formData, "contactId"), readContact(formData));
    refresh(workspaceId);
  });
}

export async function deleteContactAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteContact(await getWebCtx(), workspaceId, str(formData, "contactId"));
    refresh(workspaceId);
  });
}

export async function createCompanyAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await createCompany(await getWebCtx(), workspaceId, readCompany(formData));
    refresh(workspaceId);
  });
}

export async function updateCompanyAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await updateCompany(await getWebCtx(), workspaceId, str(formData, "companyId"), readCompany(formData));
    refresh(workspaceId);
  });
}

export async function deleteCompanyAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteCompany(await getWebCtx(), workspaceId, str(formData, "companyId"));
    refresh(workspaceId);
  });
}

/** Read the uploaded CSV file of an import form as text. */
async function csvText(formData: FormData): Promise<string> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) throw new Invalid("Choose a CSV file first.");
  if (file.size > 2_000_000) throw new Invalid("The file is too large (2 MB at most).");
  return file.text();
}

export async function importCrmAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const ctx = await getWebCtx();
    const text = await csvText(formData);
    let count: number;
    if (str(formData, "type") === "companies") {
      const rows = readCsvRecords(text, ["name", "website", "notes"], ["name"]);
      count = await importCompanies(ctx, workspaceId, rows);
    } else {
      const rows = readCsvRecords(text, ["name", "email", "phone", "title", "company", "notes"], ["name"]);
      count = await importContacts(ctx, workspaceId, rows);
    }
    refresh(workspaceId);
    return { ok: true, data: { message: `Imported ${count} row${count === 1 ? "" : "s"}.` } };
  });
}
