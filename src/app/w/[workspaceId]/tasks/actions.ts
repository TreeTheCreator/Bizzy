"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionState, run, str, strOrNull } from "@/app/_lib/action";
import { getWebCtx } from "@/server/db/web";
import {
  type Recurrence,
  type TaskInput,
  type TaskStatus,
  type TemplateItem,
  addComment,
  applyTemplate,
  createProject,
  createTask,
  createTemplate,
  deleteComment,
  deleteProject,
  deleteTask,
  deleteTemplate,
  updateProject,
  updateTask,
} from "@/server/modules/tasks/service";

// Permission checks live in the service functions; these only translate forms.

function refresh(workspaceId: string) {
  revalidatePath(`/w/${workspaceId}`, "layout");
}

function readTask(formData: FormData): TaskInput {
  return {
    title: str(formData, "title"),
    description: str(formData, "description"),
    status: (str(formData, "status") || "todo") as TaskStatus,
    priority: (str(formData, "priority") || "normal") as TaskInput["priority"],
    projectId: strOrNull(formData, "projectId"),
    assigneeId: strOrNull(formData, "assigneeId"),
    dueDate: strOrNull(formData, "dueDate"),
    recurrence: (str(formData, "recurrence") || "none") as Recurrence,
  };
}

export async function createTaskAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await createTask(await getWebCtx(), workspaceId, readTask(formData));
    refresh(workspaceId);
  });
}

export async function updateTaskAction(workspaceId: string, taskId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await updateTask(await getWebCtx(), workspaceId, taskId, readTask(formData));
    refresh(workspaceId);
  });
}

export async function setTaskStatusAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await updateTask(await getWebCtx(), workspaceId, str(formData, "taskId"), {
      status: str(formData, "status") as TaskStatus,
    });
    refresh(workspaceId);
  });
}

export async function deleteTaskAction(workspaceId: string, taskId: string, _prev: ActionState, _formData: FormData) {
  return run(async () => {
    await deleteTask(await getWebCtx(), workspaceId, taskId);
    refresh(workspaceId);
    redirect(`/w/${workspaceId}/tasks`);
  });
}

export async function addCommentAction(workspaceId: string, taskId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await addComment(await getWebCtx(), workspaceId, taskId, { body: str(formData, "body") });
    refresh(workspaceId);
  });
}

export async function deleteCommentAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteComment(await getWebCtx(), workspaceId, str(formData, "commentId"));
    refresh(workspaceId);
  });
}

export async function createProjectAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await createProject(await getWebCtx(), workspaceId, { name: str(formData, "name") });
    refresh(workspaceId);
  });
}

export async function archiveProjectAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await updateProject(await getWebCtx(), workspaceId, str(formData, "projectId"), {
      archived: str(formData, "archived") === "true",
    });
    refresh(workspaceId);
  });
}

export async function deleteProjectAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteProject(await getWebCtx(), workspaceId, str(formData, "projectId"));
    refresh(workspaceId);
  });
}

/** Template items are typed one per line; "Title | 3" means due 3 days after the template is used. */
function readTemplateItems(text: string): TemplateItem[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [title, days] = line.split("|").map((part) => part.trim());
      const due = days !== undefined && /^\d+$/.test(days) ? Number(days) : null;
      return { title, due_in_days: due };
    });
}

export async function createTemplateAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await createTemplate(await getWebCtx(), workspaceId, {
      name: str(formData, "name"),
      items: readTemplateItems(str(formData, "items")),
    });
    refresh(workspaceId);
  });
}

export async function applyTemplateAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const count = await applyTemplate(await getWebCtx(), workspaceId, str(formData, "templateId"), {
      projectId: strOrNull(formData, "projectId"),
    });
    refresh(workspaceId);
    return { ok: true, data: { message: `Created ${count} task${count === 1 ? "" : "s"}.` } };
  });
}

export async function deleteTemplateAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteTemplate(await getWebCtx(), workspaceId, str(formData, "templateId"));
    refresh(workspaceId);
  });
}
