"use server";

import { redirect } from "next/navigation";
import { type ActionState, run, str } from "@/app/_lib/action";
import { getWebCtx } from "@/server/db/web";
import { acceptInvite } from "@/server/modules/members/service";
import { createWorkspace } from "@/server/modules/workspaces/service";

export async function createWorkspaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const ctx = await getWebCtx();
    const workspaceId = await createWorkspace(ctx, { name: str(formData, "name") });
    redirect(`/w/${workspaceId}`);
  });
}

export async function acceptInviteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const ctx = await getWebCtx();
    const workspaceId = await acceptInvite(ctx, str(formData, "token"));
    redirect(`/w/${workspaceId}`);
  });
}
