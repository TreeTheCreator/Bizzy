import { createHash, createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "@/lib/env";
import type { Ctx } from "@/server/context";

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Sign a short-lived database token (HS256) with the project's JWT secret. */
function signToken(claims: Record<string, unknown>, secret: string, seconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    role: "authenticated",
    aud: "authenticated",
    iat: now,
    exp: now + seconds,
    ...claims,
  })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

function clientFor(token: string) {
  const { url, anonKey } = supabaseEnv();
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Whether this deployment can serve the REST API at all. */
export function apiEnabled(): boolean {
  return Boolean(process.env.SUPABASE_JWT_SECRET);
}

/**
 * The caller of a REST API request, from its API key, or null.
 *
 * The key is never looked up with elevated rights. Instead:
 *  1. A token carrying only the key's hash asks the database who the key
 *     acts as (api_key_resolve). A revoked or unknown key returns nothing.
 *  2. A second token is minted for that member with an "api_key_id" claim.
 *     Queries made with it run as the member under row-level security, and the
 *     database caps them to the key's workspace and scope on every statement,
 *     so revoking the key takes effect on the next request.
 *
 * Both tokens are short-lived and never leave the server.
 */
export async function getApiCtx(key: string): Promise<{ ctx: Ctx; workspaceId: string } | null> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret || !/^bz_[0-9a-f]{48}$/.test(key)) return null;
  const hash = createHash("sha256").update(key, "utf8").digest("hex");
  const { data, error } = await clientFor(signToken({ api_key_hash: hash }, secret, 30)).rpc("api_key_resolve");
  if (error) {
    console.error("[api] could not resolve key", error.code);
    return null;
  }
  const row = (data as { key_id: string; user_id: string; workspace_id: string; email: string }[] | null)?.[0];
  if (!row) return null;
  const db = clientFor(signToken({ sub: row.user_id, api_key_id: row.key_id }, secret, 120));
  return { ctx: { userId: row.user_id, email: row.email, db, channel: "api" }, workspaceId: row.workspace_id };
}
