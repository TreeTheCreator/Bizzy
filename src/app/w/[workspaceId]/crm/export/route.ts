import { type NextRequest, NextResponse } from "next/server";
import { toCsv } from "@/server/csv";
import { getOptionalCtx } from "@/server/db/web";
import { AppError } from "@/server/errors";
import { recordExport } from "@/server/modules/audit/service";
import { listCompanies, listContacts, listDeals, listStages } from "@/server/modules/crm/service";

/** CSV download of contacts, companies or deals. Needs CRM view; every export is logged. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getOptionalCtx();
  if (!ctx) return new NextResponse("Sign in required", { status: 401 });
  const type = request.nextUrl.searchParams.get("type") ?? "contacts";
  try {
    let csv: string;
    let rows: number;
    if (type === "companies") {
      const companies = await listCompanies(ctx, workspaceId);
      rows = companies.length;
      csv = toCsv(["name", "website", "notes"], companies);
    } else if (type === "deals") {
      const [deals, stages, companies] = await Promise.all([
        listDeals(ctx, workspaceId),
        listStages(ctx, workspaceId),
        listCompanies(ctx, workspaceId),
      ]);
      rows = deals.length;
      csv = toCsv(
        ["title", "amount", "stage", "company", "expected_close", "closed_at", "notes"],
        deals.map((d) => ({
          ...d,
          stage: stages.find((s) => s.id === d.stage_id)?.name ?? "",
          company: companies.find((c) => c.id === d.company_id)?.name ?? "",
        })),
      );
    } else if (type === "contacts") {
      const [contacts, companies] = await Promise.all([listContacts(ctx, workspaceId), listCompanies(ctx, workspaceId)]);
      rows = contacts.length;
      csv = toCsv(
        ["name", "email", "phone", "title", "company", "notes"],
        contacts.map((c) => ({ ...c, company: companies.find((co) => co.id === c.company_id)?.name ?? "" })),
      );
    } else {
      return new NextResponse("Not found", { status: 404 });
    }
    await recordExport(ctx, workspaceId, `crm.${type}`, rows);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${type}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "permission_denied") return new NextResponse("Forbidden", { status: 403 });
    if (error instanceof AppError && (error.code === "not_found" || error.code === "invalid")) {
      return new NextResponse("Not found", { status: 404 });
    }
    throw error;
  }
}
