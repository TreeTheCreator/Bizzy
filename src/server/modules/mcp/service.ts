import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { Invalid, unwrap } from "@/server/errors";
import { id, parse } from "@/server/validate";

export const MCP_POLICIES = ["off", "read_only", "read_write"] as const;
export type McpPolicy = (typeof MCP_POLICIES)[number];

/** One AI client's access to one workspace, on behalf of one member. */
export interface Connection {
  workspace_id: string;
  user_id: string;
  client_id: string;
  client_name: string;
  created_at: string;
  last_used_at: string | null;
}

const COLUMNS = "workspace_id, user_id, client_id, client_name, created_at, last_used_at";
const clientId = z.string().trim().min(1).max(200);

/** The caller's own active connections, across all their workspaces. */
// authz: user-scoped (filtered to the caller; RLS allows a user their own rows)
export async function listMyConnections(ctx: Ctx): Promise<Connection[]> {
  return unwrap<Connection[]>(
    await ctx.db
      .from("mcp_connections")
      .select(COLUMNS)
      .eq("user_id", ctx.userId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false }),
  );
}

/** Every member's active connections to a workspace. Needs Settings manage. */
export async function listWorkspaceConnections(ctx: Ctx, workspaceId: string): Promise<Connection[]> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  return unwrap<Connection[]>(
    await ctx.db
      .from("mcp_connections")
      .select(COLUMNS)
      .eq("workspace_id", workspaceId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false }),
  );
}

/**
 * Record which workspaces an AI client may reach for the caller. Called from
 * the consent screen, before the authorization is approved. The set becomes
 * exactly `workspaceIds`; anything previously connected and not listed is revoked.
 */
// authz: user-scoped (mcp_connect() checks the caller's membership of every workspace)
export async function connectClient(
  ctx: Ctx,
  input: { clientId: string; clientName: string; workspaceIds: string[] },
): Promise<void> {
  const data = parse(
    z.object({
      clientId,
      clientName: z.string().max(200),
      workspaceIds: z.array(id).min(1, "choose at least one workspace").max(100),
    }),
    input,
  );
  unwrap(
    await ctx.db.rpc("mcp_connect", {
      p_client_id: data.clientId,
      p_client_name: data.clientName,
      p_workspaces: data.workspaceIds,
    }),
  );
}

/**
 * Revoke the caller's own connection, for one workspace or all of them. When
 * nothing is left, the client's grant is revoked at the auth server too, so
 * its tokens die and it must go through the consent screen again.
 */
// authz: user-scoped (mcp_revoke() only touches the caller's own connections)
export async function revokeMyConnection(
  ctx: Ctx,
  input: { clientId: string; workspaceId?: string | null },
): Promise<void> {
  const data = parse(z.object({ clientId, workspaceId: id.nullable().optional() }), input);
  unwrap(
    await ctx.db.rpc("mcp_revoke", { p_client_id: data.clientId, p_workspace: data.workspaceId ?? null }),
  );
  const left = unwrap<{ workspace_id: string }[]>(
    await ctx.db
      .from("mcp_connections")
      .select("workspace_id")
      .eq("user_id", ctx.userId)
      .eq("client_id", data.clientId)
      .is("revoked_at", null)
      .limit(1),
  );
  if (left.length === 0) {
    // Best effort: our own revocation above is already in force.
    const { error } = await ctx.db.auth.oauth.revokeGrant({ clientId: data.clientId });
    if (error) console.error("[mcp] could not revoke the OAuth grant", error.code);
  }
}

/** Cut any member's connection to this workspace. OWNER ONLY. */
export async function revokeMemberConnection(
  ctx: Ctx,
  workspaceId: string,
  input: { userId: string; clientId: string },
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "mcp.revoke_any");
  const data = parse(z.object({ userId: id, clientId }), input);
  unwrap(
    await ctx.db.rpc("mcp_revoke_any", {
      p_workspace: workspaceId,
      p_user: data.userId,
      p_client_id: data.clientId,
    }),
  );
}

/** Set what AI connections may do in this workspace. OWNER ONLY. */
export async function setMcpPolicy(ctx: Ctx, workspaceId: string, input: { policy: string }): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "mcp.set_policy");
  const { policy } = parse(z.object({ policy: z.enum(MCP_POLICIES) }), input);
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("workspaces").update({ mcp_policy: policy }).eq("id", workspaceId).select("id"),
  );
  if (rows.length === 0) throw new Invalid("Could not change the AI policy.");
}

/** Audit one MCP tool call and stamp the connection as used. Never throws. */
// authz: user-scoped (mcp_log_call() writes only for the caller's own connection)
export async function logMcpCall(
  ctx: Ctx,
  workspaceId: string,
  tool: string,
  summary: Record<string, unknown>,
  outcome: "ok" | "denied" | "error",
): Promise<void> {
  const { error } = await ctx.db.rpc("mcp_log_call", {
    p_workspace: workspaceId,
    p_tool: tool,
    p_summary: summary,
    p_outcome: outcome,
  });
  if (error) console.error("[mcp] could not log call", error.code);
}
