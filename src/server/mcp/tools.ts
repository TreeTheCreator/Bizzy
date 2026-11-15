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
  createContact,
  createDeal,
  deleteDeal,
  getDeal,
  listContacts,
  listDeals,
  listStages,
  updateDeal,
} from "@/server/modules/crm/service";
import {
  INVOICE_STATUSES,
  createExpense,
  createInvoice,
  deleteInvoice,
  getCashFlow,
  getInvoice,
  listExpenses,
  listInvoices,
  setInvoiceStatus,
} from "@/server/modules/finance/service";
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
import { getOverview } from "@/server/modules/overview/service";
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
const amount = z.number().min(0).describe("Money amount, at most 2 decimal places.");

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

  tool({
    name: "get_cross_workspace_overview",
    description:
      "Headline numbers (tasks, deals, money) for every workspace where this connection may see the dashboard. A section is null where the member's role does not include that page.",
    page: null,
    level: null,
    input: z.object({}),
    run: async (ctx) => getOverview(ctx),
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

  // --- CRM ------------------------------------------------------------------
  tool({
    name: "search_contacts",
    description: "Find contacts by name or email. With no query, lists them all (at most 5000).",
    page: "crm",
    level: "view",
    input: z.object({ workspace_id, query: z.string().optional(), company_id: id.optional() }),
    run: (ctx, args) => listContacts(ctx, args.workspace_id, { query: args.query, companyId: args.company_id }),
  }),
  tool({
    name: "list_deals",
    description: "List deals and the stages of the deal board. Each deal's stage_id refers to a stage.",
    page: "crm",
    level: "view",
    input: z.object({
      workspace_id,
      stage_id: id.optional(),
      open_only: z.boolean().optional().describe("Hide deals that are won or lost."),
    }),
    run: async (ctx, args) => ({
      stages: await listStages(ctx, args.workspace_id),
      deals: await listDeals(ctx, args.workspace_id, { stageId: args.stage_id, openOnly: args.open_only }),
    }),
  }),
  tool({
    name: "get_deal",
    description: "Get one deal.",
    page: "crm",
    level: "view",
    input: z.object({ workspace_id, deal_id: id }),
    run: (ctx, args) => getDeal(ctx, args.workspace_id, args.deal_id),
  }),
  tool({
    name: "create_contact",
    description: "Add a contact.",
    page: "crm",
    level: "edit",
    input: z.object({
      workspace_id,
      name: z.string(),
      email: z.string().optional(),
      phone: z.string().optional(),
      title: z.string().optional().describe("Job title."),
      company_id: id.nullable().optional(),
    }),
    run: async (ctx, args) => ({
      contact_id: await createContact(ctx, args.workspace_id, {
        name: args.name,
        ...(args.email !== undefined && { email: args.email }),
        ...(args.phone !== undefined && { phone: args.phone }),
        ...(args.title !== undefined && { title: args.title }),
        ...(args.company_id !== undefined && { companyId: args.company_id }),
      }),
    }),
  }),
  tool({
    name: "create_deal",
    description: "Create a deal. Without stage_id it starts in the first stage of the board.",
    page: "crm",
    level: "edit",
    input: z.object({
      workspace_id,
      title: z.string(),
      amount: amount.optional(),
      stage_id: id.optional().describe("From list_deals."),
      company_id: id.nullable().optional(),
      contact_id: id.nullable().optional(),
      expected_close: isoDate.nullable().optional(),
      notes: z.string().optional(),
    }),
    run: async (ctx, args) => ({
      deal_id: await createDeal(ctx, args.workspace_id, {
        title: args.title,
        ...(args.amount !== undefined && { amount: args.amount }),
        ...(args.stage_id !== undefined && { stageId: args.stage_id }),
        ...(args.company_id !== undefined && { companyId: args.company_id }),
        ...(args.contact_id !== undefined && { contactId: args.contact_id }),
        ...(args.expected_close !== undefined && { expectedClose: args.expected_close }),
        ...(args.notes !== undefined && { notes: args.notes }),
      }),
    }),
  }),
  tool({
    name: "move_deal_stage",
    description: "Move a deal to another stage. A won or lost stage closes the deal.",
    page: "crm",
    level: "edit",
    input: z.object({ workspace_id, deal_id: id, stage_id: id.describe("From list_deals.") }),
    run: async (ctx, args) => {
      await updateDeal(ctx, args.workspace_id, args.deal_id, { stageId: args.stage_id });
      return { updated: true };
    },
  }),
  tool({
    name: "delete_deal",
    description: "Permanently delete a deal. Cannot be undone.",
    page: "crm",
    level: "manage",
    destructive: true,
    input: z.object({ workspace_id, deal_id: id, confirm }),
    run: async (ctx, args) => {
      await deleteDeal(ctx, args.workspace_id, args.deal_id);
      return { deleted: true };
    },
  }),

  // --- Finance --------------------------------------------------------------
  tool({
    name: "list_invoices",
    description: "List invoices, newest first, optionally by status.",
    page: "finance",
    level: "view",
    input: z.object({ workspace_id, status: z.enum(INVOICE_STATUSES).optional() }),
    run: (ctx, args) => listInvoices(ctx, args.workspace_id, { status: args.status }),
  }),
  tool({
    name: "get_invoice",
    description: "Get one invoice with its lines.",
    page: "finance",
    level: "view",
    input: z.object({ workspace_id, invoice_id: id }),
    run: (ctx, args) => getInvoice(ctx, args.workspace_id, args.invoice_id),
  }),
  tool({
    name: "list_expenses",
    description: "List expenses, newest first, optionally between two dates.",
    page: "finance",
    level: "view",
    input: z.object({ workspace_id, from: isoDate.optional(), to: isoDate.optional() }),
    run: (ctx, args) => listExpenses(ctx, args.workspace_id, { from: args.from, to: args.to }),
  }),
  tool({
    name: "get_cash_flow",
    description:
      "Money in (paid invoices) and out (expenses) per month, plus today's unpaid and overdue totals.",
    page: "finance",
    level: "view",
    input: z.object({ workspace_id, months: z.number().int().min(1).max(24).optional().describe("Default 6.") }),
    run: (ctx, args) => getCashFlow(ctx, args.workspace_id, { months: args.months }),
  }),
  tool({
    name: "create_invoice",
    description:
      "Create a draft invoice. With deal_id (needs CRM access) the customer and a first line come from the deal.",
    page: "finance",
    level: "edit",
    input: z.object({
      workspace_id,
      customer_name: z.string().optional().describe("Required unless deal_id is given."),
      deal_id: id.optional(),
      due_date: isoDate.nullable().optional(),
      notes: z.string().optional(),
      lines: z
        .array(z.object({ description: z.string(), quantity: z.number().positive().optional(), unit_price: amount }))
        .optional(),
    }),
    run: async (ctx, args) => ({
      invoice_id: await createInvoice(ctx, args.workspace_id, {
        ...(args.customer_name !== undefined && { customerName: args.customer_name }),
        ...(args.deal_id !== undefined && { dealId: args.deal_id }),
        ...(args.due_date !== undefined && { dueDate: args.due_date }),
        ...(args.notes !== undefined && { notes: args.notes }),
        lines: (args.lines ?? []).map((l) => ({
          description: l.description,
          unitPrice: l.unit_price,
          ...(l.quantity !== undefined && { quantity: l.quantity }),
        })),
      }),
    }),
  }),
  tool({
    name: "create_expense",
    description: "Record an expense.",
    page: "finance",
    level: "edit",
    input: z.object({
      workspace_id,
      amount,
      spent_on: isoDate.optional().describe("Default today."),
      category: z.string().optional(),
      vendor: z.string().optional().describe("Who was paid."),
      notes: z.string().optional(),
    }),
    run: async (ctx, args) => ({
      expense_id: await createExpense(ctx, args.workspace_id, {
        amount: args.amount,
        ...(args.spent_on !== undefined && { spentOn: args.spent_on }),
        ...(args.category !== undefined && { category: args.category }),
        ...(args.vendor !== undefined && { vendor: args.vendor }),
        ...(args.notes !== undefined && { notes: args.notes }),
      }),
    }),
  }),
  tool({
    name: "send_invoice",
    description:
      "Mark a draft invoice as sent. This records that it was sent and locks its lines; Bizzy does not email the customer.",
    page: "finance",
    level: "edit",
    input: z.object({
      workspace_id,
      invoice_id: id,
      confirm: z.literal(true, "must be true to confirm").describe("Must be true."),
    }),
    run: async (ctx, args) => {
      await setInvoiceStatus(ctx, args.workspace_id, args.invoice_id, { status: "sent" });
      return { sent: true };
    },
  }),
  tool({
    name: "delete_invoice",
    description: "Permanently delete an invoice and its lines. Cannot be undone.",
    page: "finance",
    level: "manage",
    destructive: true,
    input: z.object({ workspace_id, invoice_id: id, confirm }),
    run: async (ctx, args) => {
      await deleteInvoice(ctx, args.workspace_id, args.invoice_id);
      return { deleted: true };
    },
  }),
];
