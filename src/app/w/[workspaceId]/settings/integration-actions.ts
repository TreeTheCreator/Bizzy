"use server";

import { revalidatePath } from "next/cache";
import { type ActionState, run, str } from "@/app/_lib/action";
import { getWebCtx } from "@/server/db/web";
import { createApiKey, revokeApiKey } from "@/server/modules/apikeys/service";
import { createWebhook, deleteWebhook, setWebhookActive } from "@/server/modules/webhooks/service";

// API keys and webhooks. Permission checks happen in the service functions.

function refresh(workspaceId: string) {
  revalidatePath(`/w/${workspaceId}/settings`, "layout");
}

export async function createApiKeyAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const { key } = await createApiKey(await getWebCtx(), workspaceId, {
      name: str(formData, "name"),
      scope: str(formData, "scope"),
    });
    refresh(workspaceId);
    return { ok: true, data: { secret: key, secretNote: "Key created. Copy it now: it is shown only once." } };
  });
}

export async function revokeApiKeyAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await revokeApiKey(await getWebCtx(), workspaceId, str(formData, "keyId"));
    refresh(workspaceId);
  });
}

export async function createWebhookAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const { secret } = await createWebhook(await getWebCtx(), workspaceId, {
      url: str(formData, "url"),
      events: formData.getAll("events").filter((e): e is string => typeof e === "string"),
    });
    refresh(workspaceId);
    return {
      ok: true,
      data: { secret, secretNote: "Webhook added. Copy its signing secret now: it is shown only once." },
    };
  });
}

export async function setWebhookActiveAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await setWebhookActive(await getWebCtx(), workspaceId, str(formData, "webhookId"), {
      active: str(formData, "active") === "true",
    });
    refresh(workspaceId);
  });
}

export async function deleteWebhookAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteWebhook(await getWebCtx(), workspaceId, str(formData, "webhookId"));
    refresh(workspaceId);
  });
}
