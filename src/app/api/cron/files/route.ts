import { type NextRequest, NextResponse } from "next/server";
import { isCronRequest } from "@/server/cron";
import { sweepOrphanFiles } from "@/server/files/cleanup";

export const maxDuration = 60;

/**
 * Daily sweep of stored files that no file row points to. Vercel Cron calls
 * this with "Authorization: Bearer $CRON_SECRET".
 */
export async function GET(request: NextRequest) {
  if (!isCronRequest(request)) return new NextResponse("Unauthorized", { status: 401 });
  let removed = 0;
  for (let round = 0; round < 5; round++) {
    const count = await sweepOrphanFiles(200);
    removed += count;
    if (count < 200) break;
  }
  return NextResponse.json({ removed }, { headers: { "Cache-Control": "no-store" } });
}
