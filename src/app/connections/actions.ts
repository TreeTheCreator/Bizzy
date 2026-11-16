"use server";

import { revalidatePath } from "next/cache";
import { type ActionState, run, str, strOrNull } from "@/app/_lib/action";
import { getWebCtx } from "@/server/db/web";
import { revokeMyConnection } from "@/server/modules/mcp/service";

export async function revokeMyConnectionAction(_prev: ActionState, formData: FormData) {
  return run(async () => {
    await revokeMyConnection(await getWebCtx(), {
      clientId: str(formData, "clientId"),
      workspaceId: strOrNull(formData, "workspaceId"),
    });
    revalidatePath("/connections");
  });
}
