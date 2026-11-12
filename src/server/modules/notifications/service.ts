import type { Ctx } from "@/server/context";
import { unwrap } from "@/server/errors";
import { id, parse } from "@/server/validate";

export interface Notification {
  id: string;
  workspace_id: string;
  kind: string;
  title: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

/** The caller's own notifications in one workspace, newest first. */
// authz: user-scoped (RLS returns only the caller's own notifications)
export async function listNotifications(ctx: Ctx, workspaceId: string): Promise<Notification[]> {
  return unwrap<Notification[]>(
    await ctx.db
      .from("notifications")
      .select("id, workspace_id, kind, title, link, read_at, created_at")
      .eq("workspace_id", parse(id, workspaceId))
      .eq("user_id", ctx.userId)
      .order("created_at", { ascending: false })
      .limit(100),
  );
}

// authz: user-scoped (RLS returns only the caller's own notifications)
export async function countUnread(ctx: Ctx, workspaceId: string): Promise<number> {
  const { count, error } = await ctx.db
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", parse(id, workspaceId))
    .eq("user_id", ctx.userId)
    .is("read_at", null);
  if (error) return 0;
  return count ?? 0;
}

// authz: user-scoped (RLS allows updating only the caller's own notifications)
export async function markAllRead(ctx: Ctx, workspaceId: string): Promise<void> {
  unwrap(
    await ctx.db
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("workspace_id", parse(id, workspaceId))
      .eq("user_id", ctx.userId)
      .is("read_at", null),
  );
}
