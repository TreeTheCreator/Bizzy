/**
 * The REST API (v1). Every route is a thin wrapper around the same service
 * functions the web app and the MCP server use, so the permission check is the
 * same authorize(). A key belongs to one workspace, so paths carry no
 * workspace id: /api/v1/tasks, /api/v1/deals/<id>, ...
 */
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/errors";
import {
  createCompany,
  createContact,
  createDeal,
  deleteCompany,
  deleteContact,
  deleteDeal,
  getDeal,
  listCompanies,
  listContacts,
  listDeals,
  listStages,
  updateCompany,
  updateContact,
  updateDeal,
} from "@/server/modules/crm/service";
import {
  type InvoiceStatus,
  createExpense,
  createInvoice,
  deleteExpense,
  deleteInvoice,
  getCashFlow,
  getInvoice,
  listExpenses,
  listInvoices,
  setInvoiceStatus,
  updateInvoice,
} from "@/server/modules/finance/service";
import { logApiCall } from "@/server/modules/apikeys/service";
import { withinRateLimit } from "@/server/modules/limits/service";
import {
  type TaskStatus,
  createTask,
  deleteTask,
  getTask,
  listProjects,
  listTasks,
  updateTask,
} from "@/server/modules/tasks/service";
import { getWorkspace } from "@/server/modules/workspaces/service";

type Body = Record<string, unknown>;

interface Request {
  ctx: Ctx;
  workspaceId: string;
  query: URLSearchParams;
  body: Body;
}

interface Resource {
  list?: (r: Request) => Promise<unknown>;
  get?: (r: Request, id: string) => Promise<unknown>;
  create?: (r: Request) => Promise<unknown>;
  update?: (r: Request, id: string) => Promise<unknown>;
  remove?: (r: Request, id: string) => Promise<unknown>;
}

/** Request bodies are snake_case; service inputs are camelCase. Unsent fields stay unsent. */
function camel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camel);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), camel(v)]),
  );
}
const input = <T>(body: Body) => camel(body) as T;
const updated = { updated: true };
const deleted = { deleted: true };

const RESOURCES: Record<string, Resource> = {
  workspace: {
    list: async ({ ctx, workspaceId }) => {
      const { workspace, access } = await getWorkspace(ctx, workspaceId);
      return {
        id: workspace.id,
        name: workspace.name,
        access: Object.fromEntries(Object.entries(access.levels).filter(([, level]) => level !== "none")),
      };
    },
  },
  tasks: {
    list: ({ ctx, workspaceId, query }) =>
      listTasks(ctx, workspaceId, {
        projectId: query.get("project_id"),
        assigneeId: query.get("assignee_id"),
        status: (query.get("status") as TaskStatus | null) ?? undefined,
        openOnly: query.get("open_only") === "true",
      }),
    get: ({ ctx, workspaceId }, id) => getTask(ctx, workspaceId, id),
    create: async ({ ctx, workspaceId, body }) => ({ id: await createTask(ctx, workspaceId, input(body)) }),
    update: async ({ ctx, workspaceId, body }, id) => (await updateTask(ctx, workspaceId, id, input(body)), updated),
    remove: async ({ ctx, workspaceId }, id) => (await deleteTask(ctx, workspaceId, id), deleted),
  },
  projects: { list: ({ ctx, workspaceId }) => listProjects(ctx, workspaceId) },
  companies: {
    list: ({ ctx, workspaceId }) => listCompanies(ctx, workspaceId),
    create: async ({ ctx, workspaceId, body }) => ({ id: await createCompany(ctx, workspaceId, input(body)) }),
    update: async ({ ctx, workspaceId, body }, id) => (await updateCompany(ctx, workspaceId, id, input(body)), updated),
    remove: async ({ ctx, workspaceId }, id) => (await deleteCompany(ctx, workspaceId, id), deleted),
  },
  contacts: {
    list: ({ ctx, workspaceId, query }) =>
      listContacts(ctx, workspaceId, { query: query.get("q") ?? undefined, companyId: query.get("company_id") }),
    create: async ({ ctx, workspaceId, body }) => ({ id: await createContact(ctx, workspaceId, input(body)) }),
    update: async ({ ctx, workspaceId, body }, id) => (await updateContact(ctx, workspaceId, id, input(body)), updated),
    remove: async ({ ctx, workspaceId }, id) => (await deleteContact(ctx, workspaceId, id), deleted),
  },
  "deal-stages": { list: ({ ctx, workspaceId }) => listStages(ctx, workspaceId) },
  deals: {
    list: ({ ctx, workspaceId, query }) =>
      listDeals(ctx, workspaceId, { stageId: query.get("stage_id"), openOnly: query.get("open_only") === "true" }),
    get: ({ ctx, workspaceId }, id) => getDeal(ctx, workspaceId, id),
    create: async ({ ctx, workspaceId, body }) => ({ id: await createDeal(ctx, workspaceId, input(body)) }),
    update: async ({ ctx, workspaceId, body }, id) => (await updateDeal(ctx, workspaceId, id, input(body)), updated),
    remove: async ({ ctx, workspaceId }, id) => (await deleteDeal(ctx, workspaceId, id), deleted),
  },
  invoices: {
    list: ({ ctx, workspaceId, query }) =>
      listInvoices(ctx, workspaceId, { status: (query.get("status") as InvoiceStatus | null) ?? undefined }),
    get: ({ ctx, workspaceId }, id) => getInvoice(ctx, workspaceId, id),
    create: async ({ ctx, workspaceId, body }) => ({ id: await createInvoice(ctx, workspaceId, input(body)) }),
    // Details first, then the status, so "paid" can be set in the same request.
    update: async ({ ctx, workspaceId, body }, id) => {
      const { status, ...rest } = input<{ status?: InvoiceStatus }>(body);
      await updateInvoice(ctx, workspaceId, id, rest);
      if (status !== undefined) await setInvoiceStatus(ctx, workspaceId, id, { status });
      return updated;
    },
    remove: async ({ ctx, workspaceId }, id) => (await deleteInvoice(ctx, workspaceId, id), deleted),
  },
  expenses: {
    list: ({ ctx, workspaceId, query }) =>
      listExpenses(ctx, workspaceId, { from: query.get("from") ?? undefined, to: query.get("to") ?? undefined }),
    create: async ({ ctx, workspaceId, body }) => ({ id: await createExpense(ctx, workspaceId, input(body)) }),
    remove: async ({ ctx, workspaceId }, id) => (await deleteExpense(ctx, workspaceId, id), deleted),
  },
  "cash-flow": { list: ({ ctx, workspaceId }) => getCashFlow(ctx, workspaceId) },
};

export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const STATUS: Record<AppError["code"], number> = {
  unauthenticated: 401,
  permission_denied: 403,
  reauth_required: 403,
  not_found: 404,
  invalid: 400,
  internal: 500,
};

const failure = (status: number, code: string, message: string, headers?: Record<string, string>): ApiResponse => ({
  status,
  body: { error: { code, message } },
  headers,
});

/** Handle one authenticated API request. */
export async function handleApi(
  ctx: Ctx,
  workspaceId: string,
  method: string,
  path: string[],
  query: URLSearchParams,
  body: Body,
): Promise<ApiResponse> {
  const write = method !== "GET";
  if (!(await withinRateLimit(ctx, write ? "api.write" : "api"))) {
    const retry = String(60 - new Date().getUTCSeconds());
    return failure(429, "rate_limited", "Too many requests. Try again in a minute.", { "Retry-After": retry });
  }
  const [name, id, ...rest] = path;
  const resource = RESOURCES[name ?? ""];
  if (!resource || rest.length > 0) return failure(404, "not_found", "No such endpoint.");
  const handler =
    method === "GET" ? (id ? resource.get : resource.list)
    : method === "POST" ? (id ? undefined : resource.create)
    : method === "PATCH" ? (id ? resource.update : undefined)
    : method === "DELETE" ? (id ? resource.remove : undefined)
    : undefined;
  if (!handler) return failure(405, "method_not_allowed", "That method is not available on this endpoint.");

  const request: Request = { ctx, workspaceId, query, body };
  const target = `${method} /${path.join("/")}`;
  try {
    const data = await (handler as (r: Request, id: string) => Promise<unknown>)(request, id);
    if (write) await logApiCall(ctx, workspaceId, target, "ok");
    return { status: method === "POST" ? 201 : 200, body: { data } };
  } catch (error) {
    if (error instanceof AppError) {
      // Denials are already logged by authorize().
      if (write && error.code !== "permission_denied") await logApiCall(ctx, workspaceId, target, "error");
      return failure(STATUS[error.code], error.code, error.message);
    }
    console.error("[api] request failed", target, error);
    return failure(500, "internal", "Something went wrong.");
  }
}
