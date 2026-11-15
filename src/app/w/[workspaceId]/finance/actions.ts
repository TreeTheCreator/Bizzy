"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionState, run, str, strOrNull } from "@/app/_lib/action";
import { readCsvRecords } from "@/server/csv";
import { getWebCtx } from "@/server/db/web";
import { Invalid } from "@/server/errors";
import {
  type InvoiceStatus,
  type QuoteStatus,
  addInvoiceLine,
  createExpense,
  createInvoice,
  createQuote,
  deleteBudget,
  deleteExpense,
  deleteInvoice,
  deleteInvoiceLine,
  deleteQuote,
  importExpenses,
  setBudget,
  setInvoiceStatus,
  setQuoteStatus,
  updateInvoice,
} from "@/server/modules/finance/service";

// Permission checks live in the service functions; these only translate forms.

function refresh(workspaceId: string) {
  revalidatePath(`/w/${workspaceId}`, "layout");
}

export async function createInvoiceAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const invoiceId = await createInvoice(await getWebCtx(), workspaceId, {
      customerName: str(formData, "customerName"),
      dueDate: strOrNull(formData, "dueDate"),
    });
    refresh(workspaceId);
    redirect(`/w/${workspaceId}/finance/invoices/${invoiceId}`);
  });
}

export async function updateInvoiceAction(workspaceId: string, invoiceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await updateInvoice(await getWebCtx(), workspaceId, invoiceId, {
      customerName: str(formData, "customerName"),
      dueDate: strOrNull(formData, "dueDate"),
      notes: str(formData, "notes"),
    });
    refresh(workspaceId);
  });
}

export async function setInvoiceStatusAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await setInvoiceStatus(await getWebCtx(), workspaceId, str(formData, "invoiceId"), {
      status: str(formData, "status") as InvoiceStatus,
    });
    refresh(workspaceId);
  });
}

export async function addLineAction(workspaceId: string, invoiceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await addInvoiceLine(await getWebCtx(), workspaceId, invoiceId, {
      description: str(formData, "description"),
      quantity: str(formData, "quantity") || 1,
      unitPrice: str(formData, "unitPrice") || 0,
    });
    refresh(workspaceId);
  });
}

export async function deleteLineAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteInvoiceLine(await getWebCtx(), workspaceId, str(formData, "lineId"));
    refresh(workspaceId);
  });
}

export async function deleteInvoiceAction(workspaceId: string, invoiceId: string, _prev: ActionState, _formData: FormData) {
  return run(async () => {
    await deleteInvoice(await getWebCtx(), workspaceId, invoiceId);
    refresh(workspaceId);
    redirect(`/w/${workspaceId}/finance`);
  });
}

export async function createQuoteAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await createQuote(await getWebCtx(), workspaceId, {
      customerName: str(formData, "customerName"),
      title: str(formData, "title"),
      amount: str(formData, "amount") || 0,
      validUntil: strOrNull(formData, "validUntil"),
    });
    refresh(workspaceId);
  });
}

export async function setQuoteStatusAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await setQuoteStatus(await getWebCtx(), workspaceId, str(formData, "quoteId"), {
      status: str(formData, "status") as QuoteStatus,
    });
    refresh(workspaceId);
  });
}

export async function deleteQuoteAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteQuote(await getWebCtx(), workspaceId, str(formData, "quoteId"));
    refresh(workspaceId);
  });
}

export async function createExpenseAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await createExpense(await getWebCtx(), workspaceId, {
      spentOn: str(formData, "spentOn") || undefined,
      category: str(formData, "category") || undefined,
      vendor: str(formData, "vendor"),
      amount: str(formData, "amount"),
      notes: str(formData, "notes"),
    });
    refresh(workspaceId);
  });
}

export async function deleteExpenseAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteExpense(await getWebCtx(), workspaceId, str(formData, "expenseId"));
    refresh(workspaceId);
  });
}

export async function importExpensesAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Invalid("Choose a CSV file first.");
    if (file.size > 2_000_000) throw new Invalid("The file is too large (2 MB at most).");
    const rows = readCsvRecords(await file.text(), ["date", "category", "vendor", "amount", "notes"], ["amount"]);
    const count = await importExpenses(
      await getWebCtx(),
      workspaceId,
      rows.map((r) => ({
        spentOn: r.date || undefined,
        category: r.category || undefined,
        vendor: r.vendor,
        amount: r.amount.replace(/[$,\s]/g, ""),
        notes: r.notes,
      })),
    );
    refresh(workspaceId);
    return { ok: true, data: { message: `Imported ${count} expense${count === 1 ? "" : "s"}.` } };
  });
}

export async function setBudgetAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await setBudget(await getWebCtx(), workspaceId, {
      category: str(formData, "category"),
      month: str(formData, "month") || undefined,
      amount: str(formData, "amount"),
    });
    refresh(workspaceId);
  });
}

export async function deleteBudgetAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteBudget(await getWebCtx(), workspaceId, str(formData, "budgetId"));
    refresh(workspaceId);
  });
}
