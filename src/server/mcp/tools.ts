/**
 * The MCP tool registry.
 *
 * Every tool is a thin wrapper around a service function, so the permission
 * check is the same authorize() the web app uses. `page` and `level` here only
 * decide whether a tool is LISTED for a caller; they are never the enforcement.
 *
 * Roles, members, invites, the AI policy, connections and billing have no
 * tools and must never get any.
 */
import { z } from "zod";
import type { Page, PageAction } from "@/server/authz/pages";
import type { Ctx } from "@/server/context";
import {
  DOC_KINDS,
  createDoc,
  deleteDoc,
  getDoc,
  searchDocs,
  updateDoc,
} from "@/server/modules/docs/service";
import {
  RECURRENCES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  addComment,
  createTask,
  deleteTask,
  getTask,
  listProjects,
  listTasks,
  updateTask,
} from "@/server/modules/tasks/service";
import { getWorkspace, listMyWorkspaces } from "@/server/modules/workspaces/service";
import { id, isoDate } from "@/server/validate";

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  /** Page and level a role needs for the tool to be listed. null = any connected workspace. */
  page: Page | null;
  level: PageAction | null;
  /** Deletes data: needs `confirm: true` and the exact target id. */
  destructive?: boolean;
  input: S;
  run: (ctx: Ctx, args: z.infer<S>) => Promise<unknown>;
}

function tool<S extends z.ZodObject>(definition: Tool<S>): Tool {
  return definition as unknown as Tool;
}

const workspace_id = id.describe("Workspace id, from list_workspaces.");
const confirm = z
  .literal(true, "must be true to confirm the deletion")
  .describe("Must be true. Deletion is permanent.");

const taskFields = {
  title: z.string().describe("Short title."),
  description: z.string().describe("Longer details."),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  project_id: id.nullable().describe("Project id from list_projects, or null for none."),
  assignee_id: id.nullable().describe("User id of a workspace member, or null for unassigned."),
  due_date: isoDate.nullable().describe("YYYY-MM-DD, or null for none."),
  recurrence: z.enum(RECURRENCES),
};
const optionalTaskFields = z.object(taskFields).partial().shape;

interface TaskArgs {
  title?: string;
  description?: string;
  status?: (typeof TASK_STATUSES)[number];
  priority?: (typeof TASK_PRIORITIES)[number];
  project_id?: string | null;
  assignee_id?: string | null;
  due_date?: string | null;
  recurrence?: (typeof RECURRENCES)[number];
}

/** Tool arguments are snake_case; service inputs are camelCase. Unsent fields stay unsent. */
function taskInput(args: TaskArgs) {
  return {
    ...(args.title !== undefined && { title: args.title }),
    ...(args.description !== undefined && { description: args.description }),
    ...(args.status !== undefined && { status: args.status }),
    ...(args.priority !== undefined && { priority: args.priority }),
    ...(args.project_id !== undefined && { projectId: args.project_id }),
    ...(args.assignee_id !== undefined && { assigneeId: args.assignee_id }),
    ...(args.due_date !== undefined && { dueDate: args.due_date }),
    ...(args.recurrence !== undefined && { recurrence: args.recurrence }),
  };
}

const docFields = {
  title: z.string(),
  content: z.string().describe("The full text of the doc."),
  kind: z.enum(DOC_KINDS),
  parent_id: id.nullable().describe("Id of the doc this one sits under, or null for the top level."),
};
const optionalDocFields = z.object(docFields).partial().shape;

interface DocArgs {
  title?: string;
  content?: string;
  kind?: (typeof DOC_KINDS)[number];
  parent_id?: string | null;
}

function docInput(args: DocArgs) {
  return {
    ...(args.title !== undefined && { title: args.title }),
    ...(args.content !== undefined && { content: args.content }),
    ...(args.kind !== undefined && { kind: args.kind }),
    ...(args.parent_id !== undefined && { parentId: args.parent_id }),
  };
}

export const TOOLS: readonly Tool[] = [
  // --- Any connected workspace ----------------------------------------------
  tool({
    name: "list_workspaces",
    description: "List the workspaces (businesses) this connection can reach.",
    page: null,
    level: null,
    input: z.object({}),
    run: async (ctx) =>
      (await listMyWorkspaces(ctx)).map((w) => ({ id: w.id, name: w.name, ai_policy: w.mcp_policy })),
  }),
  tool({
    name: "get_workspace_summary",
    description: "Show one workspace and what this connection may do on each of its pages.",
    page: null,
    level: null,
    input: z.object({ workspace_id }),
    run: async (ctx, args) => {
      const { workspace, access } = await getWorkspace(ctx, args.workspace_id);
      return {
        id: workspace.id,
        name: workspace.name,
        ai_policy: workspace.mcp_policy,
        role: access.isOwner ? "Owner" : access.roleName,
        access: Object.fromEntries(Object.entries(access.levels).filter(([, level]) => level !== "none")),
      };
    },
  }),

  // --- Tasks ----------------------------------------------------------------
  tool({
    name: "list_tasks",
    description: "List tasks in a workspace, optionally filtered. Returns at most 500.",
    page: "tasks",
    level: "view",
    input: z.object({
      workspace_id,
      project_id: id.optional(),
      assignee_id: id.optional(),
      status: z.enum(TASK_STATUSES).optional(),
      open_only: z.boolean().optional().describe("Hide completed tasks."),
    }),
    run: (ctx, args) =>
      listTasks(ctx, args.workspace_id, {
        projectId: args.project_id,
        assigneeId: args.assignee_id,
        status: args.status,
        openOnly: args.open_only,
      }),
  }),
  tool({
    name: "get_task",
    description: "Get one task with its comments.",
    page: "tasks",
    level: "view",
    input: z.object({ workspace_id, task_id: id }),
    run: (ctx, args) => getTask(ctx, args.workspace_id, args.task_id),
  }),
  tool({
    name: "list_projects",
    description: "List the projects tasks can be grouped under.",
    page: "tasks",
    level: "view",
    input: z.object({ workspace_id }),
    run: (ctx, args) => listProjects(ctx, args.workspace_id),
  }),
  tool({
    name: "create_task",
    description: "Create a task.",
    page: "tasks",
    level: "edit",
    input: z.object({ workspace_id, ...optionalTaskFields, title: taskFields.title }),
    run: async (ctx, args) => ({
      task_id: await createTask(ctx, args.workspace_id, { ...taskInput(args), title: args.title }),
    }),
  }),
  tool({
    name: "update_task",
    description:
      "Change fields of a task. Only the fields you send are changed. Completing a recurring task creates its next occurrence.",
    page: "tasks",
    level: "edit",
    input: z.object({ workspace_id, task_id: id, ...optionalTaskFields }),
    run: async (ctx, args) => {
      await updateTask(ctx, args.workspace_id, args.task_id, taskInput(args));
      return { updated: true };
    },
  }),
  tool({
    name: "comment_on_task",
    description: "Add a comment to a task.",
    page: "tasks",
    level: "edit",
    input: z.object({ workspace_id, task_id: id, body: z.string() }),
    run: async (ctx, args) => ({
      comment_id: await addComment(ctx, args.workspace_id, args.task_id, { body: args.body }),
    }),
  }),
  tool({
    name: "delete_task",
    description: "Permanently delete a task and its comments. Cannot be undone.",
    page: "tasks",
    level: "manage",
    destructive: true,
    input: z.object({ workspace_id, task_id: id, confirm }),
    run: async (ctx, args) => {
      await deleteTask(ctx, args.workspace_id, args.task_id);
      return { deleted: true };
    },
  }),

  // --- Docs -----------------------------------------------------------------
  tool({
    name: "search_docs",
    description: "Find docs whose title or text contains a phrase. Returns titles and ids, not content.",
    page: "docs",
    level: "view",
    input: z.object({ workspace_id, query: z.string().describe("At least 2 characters.") }),
    run: (ctx, args) => searchDocs(ctx, args.workspace_id, args.query),
  }),
  tool({
    name: "read_doc",
    description: "Read one doc: its text and the names of attached files.",
    page: "docs",
    level: "view",
    input: z.object({ workspace_id, doc_id: id }),
    run: async (ctx, args) => {
      const { doc, files } = await getDoc(ctx, args.workspace_id, args.doc_id);
      return { doc, files: files.map((f) => ({ id: f.id, name: f.name, size_bytes: f.size_bytes })) };
    },
  }),
  tool({
    name: "create_doc",
    description: "Create a doc.",
    page: "docs",
    level: "edit",
    input: z.object({ workspace_id, ...optionalDocFields, title: docFields.title }),
    run: async (ctx, args) => ({
      doc_id: await createDoc(ctx, args.workspace_id, { ...docInput(args), title: args.title }),
    }),
  }),
  tool({
    name: "update_doc",
    description: "Change a doc. Only the fields you send are changed; `content` replaces the whole text.",
    page: "docs",
    level: "edit",
    input: z.object({ workspace_id, doc_id: id, ...optionalDocFields }),
    run: async (ctx, args) => {
      await updateDoc(ctx, args.workspace_id, args.doc_id, docInput(args));
      return { updated: true };
    },
  }),
  tool({
    name: "delete_doc",
    description: "Permanently delete a doc and its attached files. Cannot be undone.",
    page: "docs",
    level: "manage",
    destructive: true,
    input: z.object({ workspace_id, doc_id: id, confirm }),
    run: async (ctx, args) => {
      await deleteDoc(ctx, args.workspace_id, args.doc_id);
      return { deleted: true };
    },
  }),
];
