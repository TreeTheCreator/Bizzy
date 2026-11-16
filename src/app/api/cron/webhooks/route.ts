import { type NextRequest, NextResponse } from "next/server";
import { isCronRequest } from "@/server/cron";
import { drainWebhooks } from "@/server/webhooks/deliver";

export const maxDuration = 60;

/**
 * Retry sweep for webhook deliveries. Vercel Cron calls this with
 * "Authorization: Bearer $CRON_SECRET"; without that secret configured the
 * route refuses every request.
 */
export async function GET(request: NextRequest) {
  if (!isCronRequest(request)) return new NextResponse("Unauthorized", { status: 401 });
  let attempted = 0;
  for (let round = 0; round < 5; round++) {
    const count = await drainWebhooks(50);
    attempted += count;
    if (count < 50) break;
  }
  return NextResponse.json({ attempted }, { headers: { "Cache-Control": "no-store" } });
}
