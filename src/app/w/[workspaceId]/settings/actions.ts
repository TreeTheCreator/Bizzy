"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionState, run, str, strOrNull } from "@/app/_lib/action";
import { LEVELS, PAGES, type Level, type Page } from "@/server/authz/pages";
import { appUrl, getWebCtx } from "@/server/db/web";
import {
  createInvite,
  leaveWorkspace,
  removeMember,
  revokeInvite,
  setMemberRole,
} from "@/server/modules/members/service";
import { type RoleInput, createRole, deleteRole, updateRole } from "@/server/modules/roles/service";
import { deleteWorkspace, renameWorkspace, transferOwnership } from "@/server/modules/workspaces/service";

// Every action takes the workspace id first (bound in the page) and then the
// form. Permission checks happen in the service functions, not here.

function refresh(workspaceId: string) {
  revalidatePath(`/w/${workspaceId}`, "layout");
}

export async function renameWorkspaceAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await renameWorkspace(await getWebCtx(), workspaceId, { name: str(formData, "name") });
    refresh(workspaceId);
  });
}

export async function deleteWorkspaceAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteWorkspace(await getWebCtx(), workspaceId, { confirmName: str(formData, "confirmName") });
    redirect("/workspaces");
  });
}

export async function transferOwnershipAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await transferOwnership(await getWebCtx(), workspaceId, {
      newOwnerId: str(formData, "newOwnerId"),
      confirmName: str(formData, "confirmName"),
    });
    refresh(workspaceId);
    redirect(`/w/${workspaceId}`);
  });
}

export async function leaveWorkspaceAction(workspaceId: string, _prev: ActionState, _formData: FormData) {
  return run(async () => {
    await leaveWorkspace(await getWebCtx(), workspaceId);
    redirect("/workspaces");
  });
}

export async function createInviteAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const { token } = await createInvite(await getWebCtx(), workspaceId, { email: str(formData, "email") });
    refresh(workspaceId);
    return { ok: true, data: { link: `${await appUrl()}/invite/${token}` } };
  });
}

export async function revokeInviteAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await revokeInvite(await getWebCtx(), workspaceId, str(formData, "inviteId"));
    refresh(workspaceId);
  });
}

export async function setMemberRoleAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const expires = strOrNull(formData, "expiresOn"); // YYYY-MM-DD, access ends at the end of that day (UTC)
    await setMemberRole(await getWebCtx(), workspaceId, {
      userId: str(formData, "userId"),
      roleId: strOrNull(formData, "roleId"),
      expiresAt: expires ? `${expires}T23:59:59Z` : null,
    });
    refresh(workspaceId);
  });
}

export async function removeMemberAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await removeMember(await getWebCtx(), workspaceId, str(formData, "userId"));
    refresh(workspaceId);
  });
}

function readRole(formData: FormData): RoleInput {
  const permissions: Partial<Record<Page, { level: Level; sensitive: boolean }>> = {};
  for (const page of PAGES) {
    const level = str(formData, `level_${page}`) as Level;
    if ((LEVELS as readonly string[]).includes(level) && level !== "none") {
      permissions[page] = { level, sensitive: formData.get(`sensitive_${page}`) === "on" };
    }
  }
  return {
    name: str(formData, "name"),
    kind: str(formData, "kind") === "guest" ? "guest" : "custom",
    permissions,
  };
}

export async function saveRoleAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const ctx = await getWebCtx();
    const roleId = strOrNull(formData, "roleId");
    if (roleId) await updateRole(ctx, workspaceId, roleId, readRole(formData));
    else await createRole(ctx, workspaceId, readRole(formData));
    refresh(workspaceId);
  });
}

export async function deleteRoleAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteRole(await getWebCtx(), workspaceId, str(formData, "roleId"));
    refresh(workspaceId);
  });
}
