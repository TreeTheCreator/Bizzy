import { type NextRequest, NextResponse } from "next/server";
import { toCsv } from "@/server/csv";
import { getOptionalCtx } from "@/server/db/web";
import { AppError } from "@/server/errors";
import { recordExport } from "@/server/modules/audit/service";
import { listExpenses, listInvoices } from "@/server/modules/finance/service";

/** CSV download of invoices or expenses. Needs Finance view; every export is logged. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getOptionalCtx();
  if (!ctx) return new NextResponse("Sign in required", { status: 401 });
  const type = request.nextUrl.searchParams.get("type") ?? "invoices";
  try {
    let csv: string;
    let rows: number;
    if (type === "expenses") {
      const expenses = await listExpenses(ctx, workspaceId);
      rows = expenses.length;
      csv = toCsv(
        ["date", "category", "vendor", "amount", "notes"],
        expenses.map((e) => ({ ...e, date: e.spent_on })),
      );
    } else if (type === "invoices") {
      const invoices = await listInvoices(ctx, workspaceId);
      rows = invoices.length;
      csv = toCsv(["number", "customer_name", "status", "issue_date", "due_date", "total", "sent_at", "paid_at", "notes"], invoices);
    } else {
      return new NextResponse("Not found", { status: 404 });
    }
    await recordExport(ctx, workspaceId, `finance.${type}`, rows);
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
