import { z } from "zod";
import { type Access, authorize, authorizeMember } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { Invalid, NotFound, unwrap } from "@/server/errors";
import { id, parse } from "@/server/validate";

export interface Workspace {
  id: string;
  name: string;
  owner_id: string;
  mcp_policy: "off" | "read_only" | "read_write";
  created_at: string;
}

const name = z.string().trim().min(1, "is required").max(80);

/** Workspaces the caller belongs to. */
// authz: user-scoped (RLS returns only the caller's workspaces)
export async function listMyWorkspaces(ctx: Ctx): Promise<Workspace[]> {
  return unwrap<Workspace[]>(
    await ctx.db.from("workspaces").select("id, name, owner_id, mcp_policy, created_at").order("name"),
  );
}

/** Create a workspace; the caller becomes its owner. */
// authz: user-scoped (any signed-in user may create a workspace; done in create_workspace())
export async function createWorkspace(ctx: Ctx, input: { name: string }): Promise<string> {
  const { name: n } = parse(z.object({ name }), input);
  return unwrap<string>(await ctx.db.rpc("create_workspace", { p_name: n }));
}

/** The workspace plus the caller's access to it. Members with no role still get this. */
export async function getWorkspace(
  ctx: Ctx,
  workspaceId: string,
): Promise<{ workspace: Workspace; access: Access }> {
  const access = await authorizeMember(ctx, parse(id, workspaceId));
  const workspace = unwrap<Workspace | null>(
    await ctx.db
      .from("workspaces")
      .select("id, name, owner_id, mcp_policy, created_at")
      .eq("id", workspaceId)
      .maybeSingle(),
  );
  if (!workspace) throw new NotFound("Workspace");
  return { workspace, access };
}

export async function renameWorkspace(ctx: Ctx, workspaceId: string, input: { name: string }): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  const { name: n } = parse(z.object({ name }), input);
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("workspaces").update({ name: n }).eq("id", workspaceId).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Workspace");
}

/** Permanently delete a workspace and all its data. Owner only, typed-name confirmation. */
export async function deleteWorkspace(
  ctx: Ctx,
  workspaceId: string,
  input: { confirmName: string },
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "workspace.delete");
  const { workspace } = await getWorkspace(ctx, workspaceId);
  if (input.confirmName.trim() !== workspace.name) {
    throw new Invalid("Type the workspace name exactly to confirm deletion.");
  }
  // Remove stored files first: database rows cascade, storage objects do not.
  const files = unwrap<{ storage_path: string }[]>(
    await ctx.db.from("files").select("storage_path").eq("workspace_id", workspaceId),
  );
  if (files.length > 0) {
    await ctx.db.storage.from("workspace-files").remove(files.map((f) => f.storage_path));
  }
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("workspaces").delete().eq("id", workspaceId).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Workspace");
}

/** Hand the workspace to another member. Owner only; the database function re-checks and audits. */
export async function transferOwnership(
  ctx: Ctx,
  workspaceId: string,
  input: { newOwnerId: string; confirmName: string },
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "ownership.transfer");
  const { workspace } = await getWorkspace(ctx, workspaceId);
  if (input.confirmName.trim() !== workspace.name) {
    throw new Invalid("Type the workspace name exactly to confirm the transfer.");
  }
  unwrap(
    await ctx.db.rpc("transfer_ownership", {
      p_workspace: workspaceId,
      p_new_owner: parse(id, input.newOwnerId),
    }),
  );
}
