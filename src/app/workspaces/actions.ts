"use server";

import { redirect } from "next/navigation";
import { type ActionState, run, str } from "@/app/_lib/action";
import { getWebCtx } from "@/server/db/web";
import { acceptInvite } from "@/server/modules/members/service";
import { applyBusinessTemplate } from "@/server/modules/templates/service";
import { createWorkspace } from "@/server/modules/workspaces/service";

export async function createWorkspaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const ctx = await getWebCtx();
    const workspaceId = await createWorkspace(ctx, { name: str(formData, "name") });
    const template = str(formData, "template");
    if (template) {
      // The business exists now; a problem with the starter kit must not hide it.
      try {
        await applyBusinessTemplate(ctx, workspaceId, { template });
      } catch (error) {
        console.error("[templates] could not apply", template, error);
      }
    }
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
