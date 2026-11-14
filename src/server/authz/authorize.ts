/**
 * The single authorization layer.
 *
 * Every service function calls authorize() (or authorizeAnyAccess / requireMember)
 * before touching data. The web UI, the REST API and the MCP server all go
 * through the same service functions, so they share this one check.
 *
 * Access levels are resolved by the database function public.my_access(), the
 * same logic RLS uses. Nothing is cached between calls: a revoked role stops
 * working on the very next request.
 */
import type { Ctx } from "@/server/context";
import { PermissionDenied, ReauthRequired, unwrap } from "@/server/errors";
import {
  type Action,
  type Level,
  type Page,
  NO_REAUTH,
  atLeast,
  isOwnerAction,
} from "./pages";

export interface Access {
  /** Has an unexpired membership (possibly with no role). */
  member: boolean;
  isOwner: boolean;
  roleId: string | null;
  roleName: string | null;
  roleKind: "full_access" | "custom" | "guest" | null;
  levels: Record<Page, Level>;
  sensitive: Record<Page, boolean>;
  /** Password entered within the last 10 minutes. */
  recentAuth: boolean;
  /** The session belongs to an OAuth client (an AI connection). */
  oauthClient: boolean;
}

interface RawAccess {
  member: boolean;
  is_owner: boolean;
  role_id: string | null;
  role_name: string | null;
  role_kind: Access["roleKind"];
  levels: Record<Page, Level>;
  sensitive: Record<Page, boolean>;
  recent_auth: boolean;
  oauth_client: boolean;
}

/** Load the caller's access in a workspace. One database round trip, never cached. */
export async function getAccess(ctx: Ctx, workspaceId: string): Promise<Access> {
  const raw = unwrap<RawAccess>(await ctx.db.rpc("my_access", { p_workspace: workspaceId }));
  return {
    member: raw.member,
    isOwner: raw.is_owner,
    roleId: raw.role_id,
    roleName: raw.role_name,
    roleKind: raw.role_kind,
    levels: raw.levels,
    sensitive: raw.sensitive,
    recentAuth: raw.recent_auth,
    oauthClient: raw.oauth_client,
  };
}

async function logDenied(ctx: Ctx, workspaceId: string, page: Page, action: Action): Promise<void> {
  // Best effort: a logging failure must not turn a denial into an error page.
  const { error } = await ctx.db.rpc("log_event", {
    p_workspace: workspaceId,
    p_event: "authz.denied",
    p_target: `${page}:${action}`,
    p_summary: {},
    p_outcome: "denied",
    p_channel: ctx.channel,
  });
  if (error) console.error("[audit] could not log denial", error.code);
}

/**
 * Throw unless the caller may perform `action` on `page` in `workspaceId`.
 * Returns the caller's access so services can reuse it (e.g. for sensitive fields).
 *
 * - Page actions (`view` / `edit` / `manage`) compare against the role's level.
 * - Owner actions (see OWNER_ACTIONS) require the workspace owner, the web
 *   channel, and a fresh password confirmation.
 */
export async function authorize(
  ctx: Ctx,
  workspaceId: string,
  page: Page,
  action: Action,
): Promise<Access> {
  const access = await getAccess(ctx, workspaceId);

  // The MCP endpoint only accepts tokens issued to an OAuth client, because
  // the database applies the connection's workspace list and the workspace's
  // AI policy to exactly those tokens. Anything else on that channel fails closed.
  if (ctx.channel === "mcp" && !access.oauthClient) {
    await logDenied(ctx, workspaceId, page, action);
    throw new PermissionDenied();
  }

  if (isOwnerAction(action)) {
    const allowed = access.isOwner && ctx.channel === "web" && !access.oauthClient;
    if (!allowed) {
      await logDenied(ctx, workspaceId, page, action);
      throw new PermissionDenied("Only the workspace owner can do that, from the web app.");
    }
    if (!NO_REAUTH.has(action) && !access.recentAuth) throw new ReauthRequired();
    return access;
  }

  if (!atLeast(access.levels[page], action)) {
    await logDenied(ctx, workspaceId, page, action);
    throw new PermissionDenied();
  }
  return access;
}

/** Throw unless the caller can use at least one page of the workspace. */
export async function authorizeAnyAccess(ctx: Ctx, workspaceId: string): Promise<Access> {
  const access = await getAccess(ctx, workspaceId);
  const any = Object.values(access.levels).some((level) => level !== "none");
  if (!any) throw new PermissionDenied();
  return access;
}

/** Throw unless the caller is a current member (a member with no role passes). */
export async function authorizeMember(ctx: Ctx, workspaceId: string): Promise<Access> {
  const access = await getAccess(ctx, workspaceId);
  if (!access.member) throw new PermissionDenied();
  return access;
}
