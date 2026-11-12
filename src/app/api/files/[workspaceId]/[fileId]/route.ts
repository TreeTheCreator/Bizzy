import { type NextRequest, NextResponse } from "next/server";
import { getOptionalCtx } from "@/server/db/web";
import { AppError } from "@/server/errors";
import { getDownloadUrl } from "@/server/modules/docs/service";

/**
 * File download. Checks Docs view through the service layer, then redirects to
 * a storage URL that is valid for 60 seconds.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; fileId: string }> },
) {
  const { workspaceId, fileId } = await params;
  const ctx = await getOptionalCtx();
  if (!ctx) return new NextResponse("Sign in required", { status: 401 });
  try {
    const url = await getDownloadUrl(ctx, workspaceId, fileId);
    return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError && error.code === "permission_denied") {
      return new NextResponse("Forbidden", { status: 403 });
    }
    if (error instanceof AppError && (error.code === "not_found" || error.code === "invalid")) {
      return new NextResponse("Not found", { status: 404 });
    }
    throw error;
  }
}
