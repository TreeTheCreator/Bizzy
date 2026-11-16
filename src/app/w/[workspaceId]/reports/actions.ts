"use server";

import { revalidatePath } from "next/cache";
import { type ActionState, run, str } from "@/app/_lib/action";
import { getWebCtx } from "@/server/db/web";
import { deleteSavedReport, saveReport } from "@/server/modules/reports/service";

// Permission checks live in the service functions; these only translate forms.

export async function saveReportAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await saveReport(await getWebCtx(), workspaceId, {
      name: str(formData, "name"),
      kind: str(formData, "kind"),
      period: str(formData, "period"),
    });
    revalidatePath(`/w/${workspaceId}/reports`);
    return { ok: true, data: { message: "Saved. You will find it under Saved reports." } };
  });
}

export async function deleteSavedReportAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteSavedReport(await getWebCtx(), workspaceId, str(formData, "reportId"));
    revalidatePath(`/w/${workspaceId}/reports`);
  });
}
