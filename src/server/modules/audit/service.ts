import { authorize } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { unwrap } from "@/server/errors";
import { id, parse } from "@/server/validate";

export interface AuditEntry {
  id: number;
  actor_id: string | null;
  channel: "web" | "api" | "mcp" | "system";
  event: string;
  target: string | null;
  summary: Record<string, unknown>;
  outcome: "ok" | "denied" | "error";
  created_at: string;
}

/** The workspace audit log, newest first. OWNER ONLY. */
export async function listAudit(
  ctx: Ctx,
  workspaceId: string,
  options: { beforeId?: number; limit?: number; event?: string } = {},
): Promise<AuditEntry[]> {
  await authorize(ctx, parse(id, workspaceId), "settings", "audit.read");
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  let query = ctx.db
    .from("audit_log")
    .select("id, actor_id, channel, event, target, summary, outcome, created_at")
    .eq("workspace_id", workspaceId);
  if (options.beforeId) query = query.lt("id", options.beforeId);
  if (options.event) query = query.like("event", `${options.event.replace(/[%_\\]/g, "")}%`);
  return unwrap<AuditEntry[]>(await query.order("id", { ascending: false }).limit(limit));
}

/** Record one sign-in against every workspace the caller belongs to. */
// authz: user-scoped (log_login() writes only for the caller)
export async function recordLogin(ctx: Ctx): Promise<void> {
  const { error } = await ctx.db.rpc("log_login");
  if (error) console.error("[audit] could not log login", error.code);
}

/** Record that the caller exported data (a CSV download). Never throws. */
// authz: user-scoped (log_event() records only the caller's own action)
export async function recordExport(ctx: Ctx, workspaceId: string, what: string, rows: number): Promise<void> {
  const { error } = await ctx.db.rpc("log_event", {
    p_workspace: workspaceId,
    p_event: "data.export",
    p_target: what,
    p_summary: { rows },
    p_outcome: "ok",
    p_channel: ctx.channel,
  });
  if (error) console.error("[audit] could not log export", error.code);
}
