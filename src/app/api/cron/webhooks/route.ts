import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { drainWebhooks } from "@/server/webhooks/deliver";

export const maxDuration = 60;

/**
 * Retry sweep for webhook deliveries. Vercel Cron calls this with
 * "Authorization: Bearer $CRON_SECRET"; without that secret configured the
 * route refuses every request.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  let attempted = 0;
  for (let round = 0; round < 5; round++) {
    const count = await drainWebhooks(50);
    attempted += count;
    if (count < 50) break;
  }
  return NextResponse.json({ attempted }, { headers: { "Cache-Control": "no-store" } });
}
