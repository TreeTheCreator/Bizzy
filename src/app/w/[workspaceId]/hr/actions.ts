"use server";

import { revalidatePath } from "next/cache";
import { type ActionState, run, str, strOrNull } from "@/app/_lib/action";
import { getWebCtx } from "@/server/db/web";
import {
  type LeaveStatus,
  createEmployee,
  decideLeave,
  deleteEmployee,
  deleteLeave,
  requestLeave,
  setPay,
  updateEmployee,
} from "@/server/modules/hr/service";

// Permission checks live in the service functions; these only translate forms.

function refresh(workspaceId: string) {
  revalidatePath(`/w/${workspaceId}`, "layout");
}

const readEmployee = (formData: FormData) => ({
  fullName: str(formData, "fullName"),
  jobTitle: str(formData, "jobTitle"),
  email: str(formData, "email"),
  phone: str(formData, "phone"),
  startDate: strOrNull(formData, "startDate"),
  status: (str(formData, "status") || "active") as "active" | "left",
  userId: strOrNull(formData, "userId"),
});

export async function createEmployeeAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await createEmployee(await getWebCtx(), workspaceId, readEmployee(formData));
    refresh(workspaceId);
  });
}

export async function updateEmployeeAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await updateEmployee(await getWebCtx(), workspaceId, str(formData, "employeeId"), readEmployee(formData));
    refresh(workspaceId);
  });
}

export async function deleteEmployeeAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteEmployee(await getWebCtx(), workspaceId, str(formData, "employeeId"));
    refresh(workspaceId);
  });
}

/** An empty amount clears the pay. */
export async function setPayAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const amount = str(formData, "amount");
    await setPay(
      await getWebCtx(),
      workspaceId,
      str(formData, "employeeId"),
      amount === "" ? null : { amount, period: (str(formData, "period") || "year") as "hour" | "month" | "year" },
    );
    refresh(workspaceId);
  });
}

export async function requestLeaveAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await requestLeave(await getWebCtx(), workspaceId, {
      employeeId: str(formData, "employeeId"),
      kind: (str(formData, "kind") || "holiday") as "holiday" | "sick" | "other",
      startDate: str(formData, "startDate"),
      endDate: str(formData, "endDate") || str(formData, "startDate"),
      note: str(formData, "note"),
    });
    refresh(workspaceId);
  });
}

export async function decideLeaveAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await decideLeave(await getWebCtx(), workspaceId, str(formData, "leaveId"), {
      status: str(formData, "status") as LeaveStatus,
    });
    refresh(workspaceId);
  });
}

export async function deleteLeaveAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteLeave(await getWebCtx(), workspaceId, str(formData, "leaveId"));
    refresh(workspaceId);
  });
}
