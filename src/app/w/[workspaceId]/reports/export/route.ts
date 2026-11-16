import { type NextRequest, NextResponse } from "next/server";
import { toCsv } from "@/server/csv";
import { getOptionalCtx } from "@/server/db/web";
import { AppError } from "@/server/errors";
import { recordExport } from "@/server/modules/audit/service";
import { runReport } from "@/server/modules/reports/service";

/** CSV download of one report. Needs view on the report's page; every export is logged. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getOptionalCtx();
  if (!ctx) return new NextResponse("Sign in required", { status: 401 });
  const query = request.nextUrl.searchParams;
  try {
    const report = await runReport(ctx, workspaceId, {
      kind: query.get("kind") ?? "",
      period: query.get("period") ?? undefined,
    });
    const csv = toCsv(report.columns.map((c) => c.key), report.rows);
    await recordExport(ctx, workspaceId, `report.${report.kind}`, report.rows.length);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${report.kind}-${report.from}-to-${report.to}.csv"`,
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
