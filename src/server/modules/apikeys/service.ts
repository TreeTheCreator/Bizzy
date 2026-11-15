import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { NotFound, unwrap } from "@/server/errors";
import { id, parse } from "@/server/validate";

export const API_KEY_SCOPES = ["read", "write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  scope: ApiKeyScope;
  created_at: string;
  last_used_at: string | null;
}

/** The workspace's active API keys. Needs Settings manage. */
export async function listApiKeys(ctx: Ctx, workspaceId: string): Promise<ApiKey[]> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  return unwrap<ApiKey[]>(
    await ctx.db
      .from("api_keys")
      .select("id, user_id, name, prefix, scope, created_at, last_used_at")
      .eq("workspace_id", workspaceId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false }),
  );
}

/**
 * Create an API key that acts as the caller in this workspace. Returns the key
 * itself, which is shown once and cannot be recovered.
 */
export async function createApiKey(
  ctx: Ctx,
  workspaceId: string,
  input: { name: string; scope: string },
): Promise<{ id: string; key: string }> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  const data = parse(
    z.object({ name: z.string().trim().min(1, "is required").max(80), scope: z.enum(API_KEY_SCOPES) }),
    input,
  );
  return unwrap<{ id: string; key: string }>(
    await ctx.db.rpc("api_key_create", { p_workspace: workspaceId, p_name: data.name, p_scope: data.scope }),
  );
}

export async function revokeApiKey(ctx: Ctx, workspaceId: string, keyId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  const count = unwrap<number>(
    await ctx.db.rpc("api_key_revoke", { p_workspace: workspaceId, p_key: parse(id, keyId) }),
  );
  if (count === 0) throw new NotFound("API key");
}

/** Audit one changing REST API request. Never throws. */
// authz: user-scoped (log_event() records only the caller's own action)
export async function logApiCall(
  ctx: Ctx,
  workspaceId: string,
  target: string,
  outcome: "ok" | "error",
): Promise<void> {
  const { error } = await ctx.db.rpc("log_event", {
    p_workspace: workspaceId,
    p_event: "api.call",
    p_target: target,
    p_summary: {},
    p_outcome: outcome,
    p_channel: "api",
  });
  if (error) console.error("[api] could not log call", error.code);
}
