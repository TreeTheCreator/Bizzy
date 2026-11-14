import { createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "@/lib/env";
import type { Ctx } from "@/server/context";

function claims(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The caller of an MCP request, from its OAuth access token, or null.
 *
 * Two checks happen here, both on every request:
 *  1. The auth server verifies the token AND that its session still exists, so
 *     a token whose grant was revoked stops working at once (the database's
 *     own JWT check would accept it until it expires).
 *  2. The token must carry a "client_id" claim, i.e. it was issued to an OAuth
 *     client through the consent screen. A normal web session token is refused:
 *     the workspace list and AI policy only apply to OAuth-client tokens.
 *
 * Queries made with the returned client run as the user under row-level
 * security, with the connection's limits applied by the database.
 */
export async function getMcpCtx(token: string): Promise<Ctx | null> {
  const { url, anonKey } = supabaseEnv();
  const db = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  const clientId = claims(token)?.client_id;
  if (typeof clientId !== "string" || clientId === "") return null;
  return { userId: data.user.id, email: data.user.email ?? "", db, channel: "mcp" };
}
