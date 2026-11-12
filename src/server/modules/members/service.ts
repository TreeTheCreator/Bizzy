import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { authorize, authorizeAnyAccess } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { Invalid, NotFound, unwrap } from "@/server/errors";
import { id, parse } from "@/server/validate";

export interface Member {
  user_id: string;
  email: string;
  display_name: string;
  role_id: string | null;
  expires_at: string | null;
  is_owner: boolean;
  joined_at: string;
}

export interface Person {
  user_id: string;
  display_name: string;
}

export interface Invite {
  id: string;
  email: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

/** Full member list with emails and roles (Settings view). */
export async function listMembers(ctx: Ctx, workspaceId: string): Promise<Member[]> {
  await authorize(ctx, parse(id, workspaceId), "settings", "view");
  return unwrap<Member[]>(await ctx.db.rpc("workspace_members", { p_workspace: workspaceId }));
}

/** Names only, for assignee pickers and bylines. Needs access to at least one page. */
export async function listPeople(ctx: Ctx, workspaceId: string): Promise<Person[]> {
  await authorizeAnyAccess(ctx, parse(id, workspaceId));
  return unwrap<Person[]>(await ctx.db.rpc("workspace_people", { p_workspace: workspaceId }));
}

export async function listInvites(ctx: Ctx, workspaceId: string): Promise<Invite[]> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  return unwrap<Invite[]>(
    await ctx.db
      .from("invites")
      .select("id, email, created_at, expires_at, accepted_at, revoked_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false }),
  );
}

/**
 * Create an invite and return its secret token (shown once, as a link).
 * An invite grants nothing by itself: the person joins with no role.
 */
export async function createInvite(
  ctx: Ctx,
  workspaceId: string,
  input: { email: string },
): Promise<{ token: string }> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  const { email } = parse(z.object({ email: z.email().max(254) }), {
    email: input.email.trim().toLowerCase(),
  });
  const token = randomBytes(32).toString("base64url");
  // Same hash as public.hash_invite_token(): sha256 hex of the UTF-8 token.
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  unwrap(
    await ctx.db.from("invites").insert({
      workspace_id: workspaceId,
      email,
      token_hash: tokenHash,
      invited_by: ctx.userId,
    }),
  );
  return { token };
}

export async function revokeInvite(ctx: Ctx, workspaceId: string, inviteId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  const rows = unwrap<{ id: string }[]>(
    await ctx.db
      .from("invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, inviteId))
      .is("accepted_at", null)
      .select("id"),
  );
  if (rows.length === 0) throw new NotFound("Invite");
}

/** What an invite link points at. The secret token is the credential. */
// authz: user-scoped (requires the secret invite token)
export async function previewInvite(
  ctx: Ctx,
  token: string,
): Promise<{ workspace_name: string; email: string; usable: boolean } | null> {
  const rows = unwrap<{ workspace_name: string; email: string; usable: boolean }[]>(
    await ctx.db.rpc("invite_preview", { p_token: token }),
  );
  return rows[0] ?? null;
}

/** Join the workspace the invite was issued for. The new member has no role. */
// authz: user-scoped (accept_invite() checks the token and the caller's email)
export async function acceptInvite(ctx: Ctx, token: string): Promise<string> {
  return unwrap<string>(await ctx.db.rpc("accept_invite", { p_token: token }));
}

/**
 * Assign, change or revoke a member's role. OWNER ONLY.
 * `roleId: null` revokes all access. `expiresAt` is optional (used for guests).
 */
export async function setMemberRole(
  ctx: Ctx,
  workspaceId: string,
  input: { userId: string; roleId: string | null; expiresAt?: string | null },
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "membership.set_role");
  const data = parse(
    z.object({
      userId: id,
      roleId: id.nullable(),
      expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    }),
    input,
  );
  if (data.expiresAt && new Date(data.expiresAt) <= new Date()) {
    throw new Invalid("The expiry date must be in the future.");
  }
  const rows = unwrap<{ user_id: string }[]>(
    await ctx.db
      .from("memberships")
      .update({ role_id: data.roleId, expires_at: data.roleId ? (data.expiresAt ?? null) : null })
      .eq("workspace_id", workspaceId)
      .eq("user_id", data.userId)
      .select("user_id"),
  );
  if (rows.length === 0) throw new NotFound("Member");
}

/** Remove a member from the workspace. OWNER ONLY. */
export async function removeMember(ctx: Ctx, workspaceId: string, userId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "membership.remove");
  const rows = unwrap<{ user_id: string }[]>(
    await ctx.db
      .from("memberships")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("user_id", parse(id, userId))
      .select("user_id"),
  );
  if (rows.length === 0) throw new NotFound("Member");
}

/** Leave a workspace yourself. The owner cannot leave (transfer ownership first). */
// authz: user-scoped (deletes only the caller's own membership; RLS and a trigger protect the owner)
export async function leaveWorkspace(ctx: Ctx, workspaceId: string): Promise<void> {
  const rows = unwrap<{ user_id: string }[]>(
    await ctx.db
      .from("memberships")
      .delete()
      .eq("workspace_id", parse(id, workspaceId))
      .eq("user_id", ctx.userId)
      .select("user_id"),
  );
  if (rows.length === 0) throw new Invalid("You can't leave this workspace. Owners must transfer ownership first.");
}
