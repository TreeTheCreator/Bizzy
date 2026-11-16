import { type NextRequest, NextResponse, after } from "next/server";
import { handleApi } from "@/server/api/handler";
import { apiEnabled, getApiCtx } from "@/server/db/apikey";
import { drainWebhooks } from "@/server/webhooks/deliver";

/**
 * The public REST API. Authentication is an API key created under
 * Settings → API keys, sent as "Authorization: Bearer bz_...". Cookies are
 * never read here, so a signed-in browser cannot be tricked into calling it.
 */

const MAX_BODY_BYTES = 1_000_000;
const HEADERS = { "Cache-Control": "no-store" };

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message } }, { status, headers: HEADERS });

async function handle(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!apiEnabled()) return fail(503, "unavailable", "The API is not set up on this deployment.");
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  const caller = match ? await getApiCtx(match[1]) : null;
  if (!caller) return fail(401, "unauthenticated", "Send a valid API key as a Bearer token.");

  let body: Record<string, unknown> = {};
  if (request.method === "POST" || request.method === "PATCH") {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return fail(413, "too_large", "The request body is too large.");
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return fail(400, "invalid", "The request body must be a JSON object.");
    }
    after(() => drainWebhooks()); // the change may have queued webhook events
  }

  const { path } = await params;
  const result = await handleApi(caller.ctx, caller.workspaceId, request.method, path, request.nextUrl.searchParams, body);
  return NextResponse.json(result.body, { status: result.status, headers: { ...HEADERS, ...result.headers } });
}

export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
