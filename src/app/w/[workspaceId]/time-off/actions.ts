"use server";

import { revalidatePath } from "next/cache";
import { type ActionState, run, str } from "@/app/_lib/action";
import { getWebCtx } from "@/server/db/web";
import { cancelMyLeave, requestMyLeave } from "@/server/modules/hr/service";

// Permission checks live in the service functions; these only translate forms.

export async function requestMyLeaveAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await requestMyLeave(await getWebCtx(), workspaceId, {
      kind: (str(formData, "kind") || "holiday") as "holiday" | "sick" | "other",
      startDate: str(formData, "startDate"),
      endDate: str(formData, "endDate") || str(formData, "startDate"),
      note: str(formData, "note"),
    });
    revalidatePath(`/w/${workspaceId}`, "layout");
  });
}

export async function cancelMyLeaveAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await cancelMyLeave(await getWebCtx(), workspaceId, str(formData, "leaveId"));
    revalidatePath(`/w/${workspaceId}`, "layout");
  });
}
