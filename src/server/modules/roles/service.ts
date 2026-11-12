import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import { LEVELS, PAGES, type Level, type Page } from "@/server/authz/pages";
import type { Ctx } from "@/server/context";
import { NotFound, unwrap } from "@/server/errors";
import { id, parse } from "@/server/validate";

export interface RolePermission {
  level: Level;
  sensitive: boolean;
}

export interface Role {
  id: string;
  name: string;
  kind: "full_access" | "custom" | "guest";
  is_builtin: boolean;
  permissions: Partial<Record<Page, RolePermission>>;
}

const roleInput = z.object({
  name: z.string().trim().min(1, "is required").max(60),
  kind: z.enum(["custom", "guest"]),
  permissions: z.partialRecord(
    z.enum(PAGES),
    z.object({ level: z.enum(LEVELS), sensitive: z.boolean().default(false) }),
  ),
});
export type RoleInput = z.input<typeof roleInput>;

/** Roles and their permission maps (Settings view). */
export async function listRoles(ctx: Ctx, workspaceId: string): Promise<Role[]> {
  await authorize(ctx, parse(id, workspaceId), "settings", "view");
  const roles = unwrap<Omit<Role, "permissions">[]>(
    await ctx.db
      .from("roles")
      .select("id, name, kind, is_builtin")
      .eq("workspace_id", workspaceId)
      .order("is_builtin", { ascending: false })
      .order("name"),
  );
  const perms = unwrap<{ role_id: string; page: Page; level: Level; sensitive: boolean }[]>(
    await ctx.db
      .from("role_permissions")
      .select("role_id, page, level, sensitive")
      .eq("workspace_id", workspaceId),
  );
  return roles.map((role) => ({
    ...role,
    permissions: Object.fromEntries(
      perms
        .filter((p) => p.role_id === role.id)
        .map((p) => [p.page, { level: p.level, sensitive: p.sensitive }]),
    ),
  }));
}

/** Create a custom or guest role. OWNER ONLY. */
export async function createRole(ctx: Ctx, workspaceId: string, input: RoleInput): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "settings", "roles.manage");
  const data = parse(roleInput, input);
  return unwrap<string>(
    await ctx.db.rpc("save_role", {
      p_workspace: workspaceId,
      p_role_id: null,
      p_name: data.name,
      p_kind: data.kind,
      p_permissions: data.permissions,
    }),
  );
}

/** Rename a role and replace its permission map. OWNER ONLY. Built-in roles cannot be edited. */
export async function updateRole(
  ctx: Ctx,
  workspaceId: string,
  roleId: string,
  input: RoleInput,
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "roles.manage");
  const data = parse(roleInput, input);
  unwrap(
    await ctx.db.rpc("save_role", {
      p_workspace: workspaceId,
      p_role_id: parse(id, roleId),
      p_name: data.name,
      p_kind: data.kind,
      p_permissions: data.permissions,
    }),
  );
}

/** Delete a role. OWNER ONLY. Members who held it drop to no access. */
export async function deleteRole(ctx: Ctx, workspaceId: string, roleId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "roles.manage");
  const rows = unwrap<{ id: string }[]>(
    await ctx.db
      .from("roles")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, roleId))
      .select("id"),
  );
  if (rows.length === 0) throw new NotFound("Role");
}
