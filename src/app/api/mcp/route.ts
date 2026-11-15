import { type NextRequest, NextResponse, after } from "next/server";
import { getMcpCtx } from "@/server/db/token";
import { appUrl } from "@/server/db/web";
import { handleMessage } from "@/server/mcp/server";
import { drainWebhooks } from "@/server/webhooks/deliver";

/**
 * The MCP endpoint (stateless streamable HTTP): one JSON-RPC message per POST,
 * answered with JSON. Authentication is an OAuth access token issued by
 * Supabase Auth after the user approved the client on /oauth/consent.
 */

const MAX_BODY_BYTES = 1_000_000;

// The endpoint is authenticated by a bearer token, never by cookies, so any
// origin may call it (browser-based MCP clients need this).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers": "www-authenticate",
};
const HEADERS = { ...CORS, "Cache-Control": "no-store" };

async function unauthorized(): Promise<NextResponse> {
  // Tells the client where to find the authorization server (RFC 9728).
  const metadata = `${await appUrl()}/.well-known/oauth-protected-resource`;
  return NextResponse.json(
    { error: "invalid_token", error_description: "Connect this client to Bizzy first." },
    { status: 401, headers: { ...HEADERS, "WWW-Authenticate": `Bearer resource_metadata="${metadata}"` } },
  );
}

export async function POST(request: NextRequest) {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return unauthorized();
  const ctx = await getMcpCtx(match[1]);
  if (!ctx) return unauthorized();

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request too large" }, { status: 413, headers: HEADERS });
  }
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: HEADERS },
    );
  }
  if (Array.isArray(message)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches are not supported" } },
      { status: 400, headers: HEADERS },
    );
  }

  after(() => drainWebhooks()); // a tool call may have queued webhook events
  const response = await handleMessage(ctx, message);
  if (response === null) return new NextResponse(null, { status: 202, headers: HEADERS });
  return NextResponse.json(response, { headers: HEADERS });
}

// No server-initiated stream and no sessions to end.
function notAllowed() {
  return new NextResponse(null, { status: 405, headers: { ...HEADERS, Allow: "POST, OPTIONS" } });
}
export const GET = notAllowed;
export const DELETE = notAllowed;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
