import type { DOC_KINDS } from "@/server/modules/docs/service";

/** Plain names for the three kinds of doc. */
export const KIND_LABELS: Record<(typeof DOC_KINDS)[number], string> = {
  doc: "Note",
  wiki: "Reference page",
  sop: "How-to guide",
};
