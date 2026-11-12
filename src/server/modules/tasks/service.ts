import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { NotFound, unwrap } from "@/server/errors";
import { id, isoDate, parse } from "@/server/validate";

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export const RECURRENCES = ["none", "daily", "weekly", "monthly"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export interface Project {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  created_at: string;
}

export interface Task {
  id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: (typeof TASK_PRIORITIES)[number];
  assignee_id: string | null;
  due_date: string | null;
  recurrence: Recurrence;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskComment {
  id: string;
  task_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
}

export interface TemplateItem {
  title: string;
  description?: string;
  due_in_days?: number | null;
}

export interface TaskTemplate {
  id: string;
  name: string;
  items: TemplateItem[];
  created_at: string;
}

const TASK_COLUMNS =
  "id, workspace_id, project_id, title, description, status, priority, assignee_id, due_date, recurrence, created_by, created_at, updated_at, completed_at";

const taskFields = z.object({
  title: z.string().trim().min(1, "is required").max(300),
  description: z.string().max(20000).default(""),
  status: z.enum(TASK_STATUSES).default("todo"),
  priority: z.enum(TASK_PRIORITIES).default("normal"),
  projectId: id.nullable().default(null),
  assigneeId: id.nullable().default(null),
  dueDate: isoDate.nullable().default(null),
  recurrence: z.enum(RECURRENCES).default("none"),
});
export type TaskInput = z.input<typeof taskFields>;

const projectFields = z.object({
  name: z.string().trim().min(1, "is required").max(120),
  description: z.string().max(5000).default(""),
});

// --- Projects ---------------------------------------------------------------

export async function listProjects(ctx: Ctx, workspaceId: string): Promise<Project[]> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "view");
  return unwrap<Project[]>(
    await ctx.db
      .from("projects")
      .select("id, name, description, archived, created_at")
      .eq("workspace_id", workspaceId)
      .order("name"),
  );
}

export async function createProject(
  ctx: Ctx,
  workspaceId: string,
  input: z.input<typeof projectFields>,
): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "edit");
  const data = parse(projectFields, input);
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("projects")
      .insert({ workspace_id: workspaceId, ...data, created_by: ctx.userId })
      .select("id")
      .single(),
  );
  return row.id;
}

export async function updateProject(
  ctx: Ctx,
  workspaceId: string,
  projectId: string,
  input: { name?: string; description?: string; archived?: boolean },
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "edit");
  const data = parse(projectFields.partial().extend({ archived: z.boolean().optional() }), input);
  const rows = unwrap<{ id: string }[]>(
    await ctx.db
      .from("projects")
      .update(data)
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, projectId))
      .select("id"),
  );
  if (rows.length === 0) throw new NotFound("Project");
}

/** Delete a project. Its tasks are kept and become project-less. */
export async function deleteProject(ctx: Ctx, workspaceId: string, projectId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "manage");
  const rows = unwrap<{ id: string }[]>(
    await ctx.db
      .from("projects")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, projectId))
      .select("id"),
  );
  if (rows.length === 0) throw new NotFound("Project");
}

// --- Tasks ------------------------------------------------------------------

export interface TaskFilter {
  projectId?: string | null;
  assigneeId?: string | null;
  status?: TaskStatus;
  /** Hide completed tasks (default false). */
  openOnly?: boolean;
}

export async function listTasks(ctx: Ctx, workspaceId: string, filter: TaskFilter = {}): Promise<Task[]> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "view");
  let query = ctx.db.from("tasks").select(TASK_COLUMNS).eq("workspace_id", workspaceId);
  if (filter.projectId) query = query.eq("project_id", parse(id, filter.projectId));
  if (filter.assigneeId) query = query.eq("assignee_id", parse(id, filter.assigneeId));
  if (filter.status) query = query.eq("status", parse(z.enum(TASK_STATUSES), filter.status));
  if (filter.openOnly) query = query.neq("status", "done");
  return unwrap<Task[]>(
    await query
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(500),
  );
}

export async function getTask(
  ctx: Ctx,
  workspaceId: string,
  taskId: string,
): Promise<{ task: Task; comments: TaskComment[] }> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "view");
  const task = unwrap<Task | null>(
    await ctx.db
      .from("tasks")
      .select(TASK_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, taskId))
      .maybeSingle(),
  );
  if (!task) throw new NotFound("Task");
  const comments = unwrap<TaskComment[]>(
    await ctx.db
      .from("task_comments")
      .select("id, task_id, author_id, body, created_at")
      .eq("workspace_id", workspaceId)
      .eq("task_id", taskId)
      .order("created_at"),
  );
  return { task, comments };
}

function toRow(data: Partial<z.infer<typeof taskFields>>) {
  const row: Record<string, unknown> = {};
  if (data.title !== undefined) row.title = data.title;
  if (data.description !== undefined) row.description = data.description;
  if (data.status !== undefined) row.status = data.status;
  if (data.priority !== undefined) row.priority = data.priority;
  if (data.projectId !== undefined) row.project_id = data.projectId;
  if (data.assigneeId !== undefined) row.assignee_id = data.assigneeId;
  if (data.dueDate !== undefined) row.due_date = data.dueDate;
  if (data.recurrence !== undefined) row.recurrence = data.recurrence;
  return row;
}

export async function createTask(ctx: Ctx, workspaceId: string, input: TaskInput): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "edit");
  const data = parse(taskFields, input);
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("tasks")
      .insert({
        workspace_id: workspaceId,
        ...toRow(data),
        created_by: ctx.userId,
        completed_at: data.status === "done" ? new Date().toISOString() : null,
      })
      .select("id")
      .single(),
  );
  return row.id;
}

/** Next due date for a recurring task, counted from its current due date (or today). */
export function nextDueDate(from: string | null, recurrence: Recurrence, today = new Date()): string | null {
  if (recurrence === "none") return null;
  const base = from ? new Date(`${from}T00:00:00Z`) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (recurrence === "daily") base.setUTCDate(base.getUTCDate() + 1);
  if (recurrence === "weekly") base.setUTCDate(base.getUTCDate() + 7);
  if (recurrence === "monthly") {
    const day = base.getUTCDate();
    base.setUTCDate(1);
    base.setUTCMonth(base.getUTCMonth() + 1);
    // Clamp to the last day of the target month (31 Jan -> 28/29 Feb).
    const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    base.setUTCDate(Math.min(day, lastDay));
  }
  return base.toISOString().slice(0, 10);
}

/**
 * Update a task. Completing a recurring task creates its next occurrence.
 */
export async function updateTask(
  ctx: Ctx,
  workspaceId: string,
  taskId: string,
  input: Partial<TaskInput>,
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "edit");
  const data = parse(taskFields.partial(), input);
  const before = unwrap<Task | null>(
    await ctx.db
      .from("tasks")
      .select(TASK_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, taskId))
      .maybeSingle(),
  );
  if (!before) throw new NotFound("Task");

  const row = toRow(data);
  const completing = data.status === "done" && before.status !== "done";
  if (completing) row.completed_at = new Date().toISOString();
  if (data.status !== undefined && data.status !== "done") row.completed_at = null;

  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("tasks").update(row).eq("workspace_id", workspaceId).eq("id", taskId).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Task");

  const recurrence = data.recurrence ?? before.recurrence;
  if (completing && recurrence !== "none") {
    unwrap(
      await ctx.db.from("tasks").insert({
        workspace_id: workspaceId,
        project_id: data.projectId !== undefined ? data.projectId : before.project_id,
        title: data.title ?? before.title,
        description: data.description ?? before.description,
        priority: data.priority ?? before.priority,
        assignee_id: data.assigneeId !== undefined ? data.assigneeId : before.assignee_id,
        due_date: nextDueDate(data.dueDate !== undefined ? data.dueDate : before.due_date, recurrence),
        recurrence,
        status: "todo",
        created_by: ctx.userId,
      }),
    );
  }
}

export async function deleteTask(ctx: Ctx, workspaceId: string, taskId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "manage");
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("tasks").delete().eq("workspace_id", workspaceId).eq("id", parse(id, taskId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Task");
}

// --- Comments ---------------------------------------------------------------

export async function addComment(
  ctx: Ctx,
  workspaceId: string,
  taskId: string,
  input: { body: string },
): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "edit");
  const { body } = parse(z.object({ body: z.string().trim().min(1, "is required").max(10000) }), input);
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("task_comments")
      .insert({ workspace_id: workspaceId, task_id: parse(id, taskId), author_id: ctx.userId, body })
      .select("id")
      .single(),
  );
  return row.id;
}

/** Delete a comment: your own with edit, anyone's with manage (enforced by RLS). */
export async function deleteComment(ctx: Ctx, workspaceId: string, commentId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "edit");
  const rows = unwrap<{ id: string }[]>(
    await ctx.db
      .from("task_comments")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, commentId))
      .select("id"),
  );
  if (rows.length === 0) throw new NotFound("Comment");
}

// --- Templates --------------------------------------------------------------

const templateFields = z.object({
  name: z.string().trim().min(1, "is required").max(120),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        description: z.string().max(5000).optional(),
        due_in_days: z.number().int().min(0).max(3650).nullable().optional(),
      }),
    )
    .min(1, "add at least one task")
    .max(100),
});

export async function listTemplates(ctx: Ctx, workspaceId: string): Promise<TaskTemplate[]> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "view");
  return unwrap<TaskTemplate[]>(
    await ctx.db
      .from("task_templates")
      .select("id, name, items, created_at")
      .eq("workspace_id", workspaceId)
      .order("name"),
  );
}

export async function createTemplate(
  ctx: Ctx,
  workspaceId: string,
  input: z.input<typeof templateFields>,
): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "edit");
  const data = parse(templateFields, input);
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("task_templates")
      .insert({ workspace_id: workspaceId, ...data, created_by: ctx.userId })
      .select("id")
      .single(),
  );
  return row.id;
}

export async function deleteTemplate(ctx: Ctx, workspaceId: string, templateId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "manage");
  const rows = unwrap<{ id: string }[]>(
    await ctx.db
      .from("task_templates")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, templateId))
      .select("id"),
  );
  if (rows.length === 0) throw new NotFound("Template");
}

/** Create one task per template item. Returns how many were created. */
export async function applyTemplate(
  ctx: Ctx,
  workspaceId: string,
  templateId: string,
  input: { projectId?: string | null } = {},
): Promise<number> {
  await authorize(ctx, parse(id, workspaceId), "tasks", "edit");
  const template = unwrap<TaskTemplate | null>(
    await ctx.db
      .from("task_templates")
      .select("id, name, items, created_at")
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, templateId))
      .maybeSingle(),
  );
  if (!template) throw new NotFound("Template");
  const projectId = input.projectId ? parse(id, input.projectId) : null;
  const today = new Date();
  const rows = template.items.map((item) => {
    let due: string | null = null;
    if (typeof item.due_in_days === "number") {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + item.due_in_days));
      due = d.toISOString().slice(0, 10);
    }
    return {
      workspace_id: workspaceId,
      project_id: projectId,
      title: item.title,
      description: item.description ?? "",
      due_date: due,
      created_by: ctx.userId,
    };
  });
  unwrap(await ctx.db.from("tasks").insert(rows));
  return rows.length;
}
