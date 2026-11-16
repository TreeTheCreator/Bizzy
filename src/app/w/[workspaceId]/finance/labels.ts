import type { InvoiceStatus } from "@/server/modules/finance/service";

/** Plain names for where an invoice stands. */
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft (not sent yet)",
  sent: "Sent",
  paid: "Paid",
  void: "Cancelled",
};
