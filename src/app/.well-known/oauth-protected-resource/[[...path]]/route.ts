import { NextResponse } from "next/server";
import { supabaseEnv } from "@/lib/env";
import { appUrl } from "@/server/db/web";

/**
 * OAuth protected-resource metadata (RFC 9728). An MCP client that gets a 401
 * from /api/mcp reads this to learn which authorization server issues tokens
 * for it: Supabase Auth. Served at the root path and at ".../api/mcp", since
 * clients ask for either.
 */
export async function GET() {
  const base = await appUrl();
  return NextResponse.json(
    {
      resource: `${base}/api/mcp`,
      authorization_servers: [`${supabaseEnv().url.replace(/\/$/, "")}/auth/v1`],
      bearer_methods_supported: ["header"],
      resource_name: "Bizzy",
    },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } },
  );
}
