import { createHash, randomBytes } from "node:crypto";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@/server/context";
import { getMcpCtx } from "@/server/db/token";
import { type JsonRpcResponse, handleMessage } from "@/server/mcp/server";
import { listAudit } from "@/server/modules/audit/service";
import { createDoc } from "@/server/modules/docs/service";
import {
  connectClient,
  listMyConnections,
  listWorkspaceConnections,
  revokeMemberConnection,
  revokeMyConnection,
  setMcpPolicy,
} from "@/server/modules/mcp/service";
import { acceptInvite, createInvite, setMemberRole } from "@/server/modules/members/service";
import { createTask, getTask } from "@/server/modules/tasks/service";
import { type Team, type TestUser, admin, cleanup, createTeam, expectDenied } from "../helpers";
import { dbTestsEnabled } from "../setup";

// Phase 2 acceptance: an AI connection acts as its member, limited to the
// workspaces chosen on the consent screen and to each workspace's AI policy,
// and every change (role, policy, revocation) applies on the very next call.
//
// Tokens here are REAL: each connection goes through the local Supabase OAuth
// server (client registration, PKCE, consent, code exchange), exactly as an
// MCP client would.

const AUTH = () => `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`;
const REDIRECT = "http://127.0.0.1:9999/callback";
const createdClients: string[] = [];

interface Ai {
  clientId: string;
  token: string;
  ctx: Ctx;
  /** A plain database client carrying the same token (bypasses our app). */
  raw: SupabaseClient;
}

async function connectAi(user: TestUser, workspaceIds: string[], name = "Test AI"): Promise<Ai> {
  const registered = await fetch(`${AUTH()}/oauth/clients/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  createdClients.push(clientId);

  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${AUTH()}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "s",
  }).toString();
  const started = await fetch(authorize, { redirect: "manual" });
  const authorizationId = new URL(started.headers.get("location")!).searchParams.get("authorization_id")!;

  // What the consent screen does: load the request (which also ties it to the
  // signed-in user), record the workspaces, then approve.
  const details = await user.db.auth.oauth.getAuthorizationDetails(authorizationId);
  if (details.error) throw new Error(`consent details failed: ${details.error.message}`);
  await connectClient(user, { clientId, clientName: name, workspaceIds });
  const approved = await user.db.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
  if (!approved.data) throw new Error(`approve failed: ${JSON.stringify(approved.error)} ${approved.error?.message}`);
  const code = new URL(approved.data.redirect_url).searchParams.get("code")!;

  const exchanged = await fetch(`${AUTH()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    }),
  });
  const token = ((await exchanged.json()) as { access_token: string }).access_token;
  const ctx = await getMcpCtx(token);
  if (!ctx) throw new Error("the OAuth token was not accepted");
  const raw = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { clientId, token, ctx, raw };
}

let nextId = 1;
async function rpc(ctx: Ctx, method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
  const response = await handleMessage(ctx, { jsonrpc: "2.0", id: nextId++, method, params });
  return response!;
}

async function toolNames(ctx: Ctx): Promise<string[]> {
  const response = await rpc(ctx, "tools/list");
  return (response.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
}

interface ToolResult {
  isError: boolean;
  data: Record<string, unknown> & { error?: string };
}
async function call(ctx: Ctx, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const response = await rpc(ctx, "tools/call", { name, arguments: args });
  const result = response.result as { isError: boolean; content: { text: string }[] };
  return { isError: result.isError, data: JSON.parse(result.content[0].text) };
}

async function expectToolDenied(ctx: Ctx, name: string, args: Record<string, unknown>): Promise<void> {
  const result = await call(ctx, name, args);
  expect(result.isError, `${name} should be refused`).toBe(true);
  expect(result.data.error).toBe("permission_denied");
}

const VIEW_TOOLS = ["get_task", "list_projects", "list_tasks", "read_doc", "search_docs"];
const CRM_FINANCE_VIEW_TOOLS = [
  "get_cash_flow", "get_deal", "get_invoice", "list_deals", "list_expenses", "list_invoices", "search_contacts",
];
const BASE_TOOLS = ["get_cross_workspace_overview", "get_workspace_summary", "list_workspaces"];

describe.skipIf(!dbTestsEnabled)("AI connections (MCP)", () => {
  let team: Team;
  let other: Team;
  let ws: string;
  let task: string;
  let doc: string;

  beforeAll(async () => {
    [team, other] = await Promise.all([createTeam("Mcp"), createTeam("McpOther")]);
    ws = team.workspaceId;
    task = await createTask(team.owner, ws, { title: "Call the supplier" });
    doc = await createDoc(team.owner, ws, { title: "Price list", content: "confidential prices" });
    await setMcpPolicy(team.owner, ws, { policy: "read_write" });
  });
  afterAll(async () => {
    await cleanup();
    await Promise.all(createdClients.map((id) => admin().auth.admin.oauth.deleteClient(id)));
  });

  describe("protocol", () => {
    it("answers initialize and ping, and stays silent on notifications", async () => {
      const ai = await connectAi(team.sales, [ws]);
      const init = await rpc(ai.ctx, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "bizzy" } });
      expect((await rpc(ai.ctx, "ping")).result).toEqual({});
      expect(await handleMessage(ai.ctx, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
      expect((await rpc(ai.ctx, "resources/list")).error?.code).toBe(-32601);
      expect((await rpc(ai.ctx, "tools/call", { name: "grant_role", arguments: {} })).error?.code).toBe(-32602);
    });

    it("has no tool that touches roles, members, invites, policy or billing", async () => {
      const { TOOLS } = await import("@/server/mcp/tools");
      for (const tool of TOOLS) {
        expect(tool.name).not.toMatch(/role|member|invite|policy|billing|connection|owner|audit/);
        expect(tool.page).not.toBe("settings");
      }
    });
  });

  describe("only real AI-connection tokens are accepted", () => {
    it("refuses a normal web session token, garbage and an empty token", async () => {
      const session = await team.owner.db.auth.getSession();
      expect(await getMcpCtx(session.data.session!.access_token)).toBeNull();
      expect(await getMcpCtx("not-a-token")).toBeNull();
      expect(await getMcpCtx("")).toBeNull();
    });
  });

  describe("tools follow the member's role", () => {
    let sales: Ai;
    let owner: Ai;
    beforeAll(async () => {
      [sales, owner] = await Promise.all([connectAi(team.sales, [ws]), connectAi(team.owner, [ws])]);
    });

    it("lists only what the role allows (Sales: Tasks edit, Docs view)", async () => {
      expect(await toolNames(sales.ctx)).toEqual(
        [...BASE_TOOLS, ...VIEW_TOOLS, "comment_on_task", "create_task", "update_task"].sort(),
      );
      const all = await toolNames(owner.ctx);
      expect(all).toEqual(expect.arrayContaining(["delete_task", "delete_doc", "create_doc", "update_doc"]));
    });

    it("lets the member's AI do what the member can do", async () => {
      const created = await call(sales.ctx, "create_task", { workspace_id: ws, title: "Made by AI" });
      expect(created.isError).toBe(false);
      const id = created.data.task_id as string;
      expect((await call(sales.ctx, "update_task", { workspace_id: ws, task_id: id, status: "done" })).isError).toBe(false);
      const { task: saved } = await getTask(team.owner, ws, id);
      expect(saved).toMatchObject({ title: "Made by AI", status: "done", created_by: team.sales.userId });
      const read = await call(sales.ctx, "read_doc", { workspace_id: ws, doc_id: doc });
      expect((read.data.doc as { content: string }).content).toBe("confidential prices");
    });

    it("refuses a forced call to a tool that was not listed, and logs the denial", async () => {
      await expectToolDenied(sales.ctx, "create_doc", { workspace_id: ws, title: "Forced" });
      await expectToolDenied(sales.ctx, "delete_task", { workspace_id: ws, task_id: task, confirm: true });
      await expectToolDenied(sales.ctx, "delete_doc", { workspace_id: ws, doc_id: doc, confirm: true });
      const log = await listAudit(team.owner, ws, { event: "authz.denied" });
      const mine = log.filter((e) => e.actor_id === team.sales.userId && e.channel === "mcp");
      expect(mine.map((e) => e.target)).toEqual(expect.arrayContaining(["docs:edit", "tasks:manage", "docs:manage"]));
    });

    // Phase 2 acceptance: a Sales member's AI client cannot list or call Finance tools.
    it("hides Finance and CRM from a member whose role lacks them, and refuses forced calls", async () => {
      const { TOOLS } = await import("@/server/mcp/tools");
      const gated = TOOLS.filter((t) => t.page === "finance" || t.page === "crm").map((t) => t.name);
      expect(gated.length).toBeGreaterThanOrEqual(14);
      const listed = await toolNames(sales.ctx);
      for (const name of gated) expect(listed, name).not.toContain(name);
      expect(await toolNames(owner.ctx)).toEqual(expect.arrayContaining(gated));

      await expectToolDenied(sales.ctx, "list_invoices", { workspace_id: ws });
      await expectToolDenied(sales.ctx, "get_cash_flow", { workspace_id: ws });
      await expectToolDenied(sales.ctx, "create_expense", { workspace_id: ws, amount: 5 });
      await expectToolDenied(sales.ctx, "list_deals", { workspace_id: ws });
      const log = await listAudit(team.owner, ws, { event: "authz.denied" });
      const mine = log.filter((e) => e.actor_id === team.sales.userId && e.channel === "mcp");
      expect(mine.map((e) => e.target)).toEqual(expect.arrayContaining(["finance:view", "finance:edit", "crm:view"]));
      // The database refuses too, without our app in the way.
      expect((await sales.raw.from("invoices").select("id").eq("workspace_id", ws)).data).toEqual([]);
      expect((await sales.raw.from("expenses").insert({ workspace_id: ws, amount: 1, created_by: team.sales.userId })).error).not.toBeNull();
    });

    it("lets the owner's AI run a deal through to an invoice", async () => {
      const deal = await call(owner.ctx, "create_deal", { workspace_id: ws, title: "AI deal", amount: 1200 });
      expect(deal.isError).toBe(false);
      const board = await call(owner.ctx, "list_deals", { workspace_id: ws });
      const won = (board.data.stages as { id: string; kind: string }[]).find((s) => s.kind === "won")!;
      await call(owner.ctx, "move_deal_stage", { workspace_id: ws, deal_id: deal.data.deal_id, stage_id: won.id });
      const invoice = await call(owner.ctx, "create_invoice", { workspace_id: ws, deal_id: deal.data.deal_id });
      expect(invoice.isError).toBe(false);
      const unconfirmed = await call(owner.ctx, "send_invoice", { workspace_id: ws, invoice_id: invoice.data.invoice_id });
      expect(unconfirmed.data.error).toBe("invalid");
      await call(owner.ctx, "send_invoice", { workspace_id: ws, invoice_id: invoice.data.invoice_id, confirm: true });
      const flow = await call(owner.ctx, "get_cash_flow", { workspace_id: ws });
      expect((flow.data.summary as { unpaid: number }).unpaid).toBe(1200);
    });

    it("gives a member with no role, or no access to a page, nothing", async () => {
      const norole = await connectAi(team.norole, [ws]);
      expect(await toolNames(norole.ctx)).toEqual(BASE_TOOLS);
      await expectToolDenied(norole.ctx, "list_tasks", { workspace_id: ws });
      const writer = await connectAi(team.writer, [ws]); // Docs manage only
      expect(await toolNames(writer.ctx)).not.toContain("list_tasks");
      await expectToolDenied(writer.ctx, "list_tasks", { workspace_id: ws });
    });

    it("deleting needs confirm: true, even for the owner", async () => {
      const victim = await createTask(team.owner, ws, { title: "To delete" });
      const unconfirmed = await call(owner.ctx, "delete_task", { workspace_id: ws, task_id: victim });
      expect(unconfirmed).toMatchObject({ isError: true, data: { error: "invalid" } });
      const wrong = await call(owner.ctx, "delete_task", { workspace_id: ws, task_id: victim, confirm: "yes" });
      expect(wrong.isError).toBe(true);
      expect((await getTask(team.owner, ws, victim)).task.id).toBe(victim);
      expect((await call(owner.ctx, "delete_task", { workspace_id: ws, task_id: victim, confirm: true })).isError).toBe(false);
    });

    it("logs every call with ids only, never the text that was sent", async () => {
      await call(sales.ctx, "create_task", { workspace_id: ws, title: "SECRET-TITLE-123", description: "SECRET-BODY" });
      await call(sales.ctx, "search_docs", { workspace_id: ws, query: "SECRET-QUERY" });
      const log = await listAudit(team.owner, ws, { event: "mcp.call" });
      const calls = log.filter((e) => e.actor_id === team.sales.userId);
      expect(calls.map((e) => e.target)).toEqual(expect.arrayContaining(["create_task", "search_docs", "read_doc"]));
      expect(calls.every((e) => e.channel === "mcp")).toBe(true);
      expect(JSON.stringify(log)).not.toContain("SECRET");
    });

    it("even the owner's AI connection cannot reach owner powers or settings", async () => {
      await expectDenied(setMcpPolicy(owner.ctx, ws, { policy: "read_write" }));
      await expectDenied(listWorkspaceConnections(owner.ctx, ws));
      await expectDenied(listAudit(owner.ctx, ws));
      await expectDenied(setMemberRole(owner.ctx, ws, { userId: team.norole.userId, roleId: team.roles.fullAccess }));
      // Straight at the database with the same token, skipping our app:
      expect((await owner.raw.from("workspaces").update({ mcp_policy: "read_write" }).eq("id", ws).select()).data ?? []).toEqual([]);
      expect((await owner.raw.from("memberships").select("user_id").eq("workspace_id", ws)).data).toEqual([{ user_id: team.owner.userId }]);
      expect((await owner.raw.from("mcp_connections").select("client_id")).data ?? []).toEqual([]);
      expect((await owner.raw.from("audit_log").select("id").eq("workspace_id", ws)).data ?? []).toEqual([]);
      expect((await owner.raw.from("invites").select("id").eq("workspace_id", ws)).data ?? []).toEqual([]);
      expect((await owner.raw.rpc("workspace_members", { p_workspace: ws })).data ?? []).toEqual([]);
      const roleWrite = await owner.raw.from("roles").insert({ workspace_id: ws, name: "Via AI" });
      expect(roleWrite.error).not.toBeNull();
    });

    it("a connection cannot widen, restore or create connections for itself", async () => {
      const widen = await sales.raw.rpc("mcp_connect", {
        p_client_id: sales.clientId, p_client_name: "x", p_workspaces: [ws],
      });
      expect(widen.error?.code).toBe("42501");
      expect((await sales.raw.rpc("mcp_revoke", { p_client_id: sales.clientId })).error?.code).toBe("42501");
      const insert = await sales.raw.from("mcp_connections").insert({
        workspace_id: ws, user_id: team.sales.userId, client_id: "forged",
      });
      expect(insert.error).not.toBeNull();
      // Nor can a normal signed-in member write the table directly.
      const direct = await team.sales.db.from("mcp_connections").insert({
        workspace_id: ws, user_id: team.sales.userId, client_id: "forged",
      });
      expect(direct.error).not.toBeNull();
      const update = await team.sales.db.from("mcp_connections").update({ revoked_at: null }).eq("user_id", team.sales.userId).select();
      expect(update.data ?? []).toEqual([]);
    });
  });

  describe("a connection reaches only the workspaces chosen on the consent screen", () => {
    it("a member of two workspaces who connected one cannot touch the other", async () => {
      // team.sales also joins the other team, with Full Access there.
      const { token } = await createInvite(other.owner, other.workspaceId, { email: team.sales.email });
      await acceptInvite(team.sales, token);
      await setMemberRole(other.owner, other.workspaceId, { userId: team.sales.userId, roleId: other.roles.fullAccess });
      await setMcpPolicy(other.owner, other.workspaceId, { policy: "read_write" });
      const secret = await createTask(other.owner, other.workspaceId, { title: "Other team's task" });

      const ai = await connectAi(team.sales, [ws]);
      const listed = await call(ai.ctx, "list_workspaces");
      expect((listed.data as unknown as { id: string }[]).map((w) => w.id)).toEqual([ws]);
      await expectToolDenied(ai.ctx, "list_tasks", { workspace_id: other.workspaceId });
      await expectToolDenied(ai.ctx, "get_workspace_summary", { workspace_id: other.workspaceId });
      await expectToolDenied(ai.ctx, "create_task", { workspace_id: other.workspaceId, title: "x" });
      // Straight at the database:
      expect((await ai.raw.from("tasks").select("id").eq("id", secret)).data).toEqual([]);
      expect((await ai.raw.from("workspaces").select("id")).data).toEqual([{ id: ws }]);
      const insert = await ai.raw.from("tasks").insert({ workspace_id: other.workspaceId, title: "x", created_by: team.sales.userId });
      expect(insert.error).not.toBeNull();
      // The same person in the web app still has their access there.
      expect((await getTask(team.sales, other.workspaceId, secret)).task.id).toBe(secret);
    });

    it("refuses to connect a workspace the user is not a member of", async () => {
      await expectDenied(connectClient(team.writer, { clientId: "c", clientName: "x", workspaceIds: [other.workspaceId] }));
      expect(await listMyConnections(team.writer).then((rows) => rows.filter((r) => r.client_id === "c"))).toEqual([]);
    });
  });

  describe("the owner's AI policy", () => {
    it("off, read only and read-write each apply on the very next call", async () => {
      const ai = await connectAi(team.full, [ws]); // Full Access: everything the policy allows
      expect(await toolNames(ai.ctx)).toContain("delete_doc");

      await setMcpPolicy(team.owner, ws, { policy: "read_only" });
      expect(await toolNames(ai.ctx)).toEqual([...BASE_TOOLS, ...VIEW_TOOLS, ...CRM_FINANCE_VIEW_TOOLS].sort());
      expect((await call(ai.ctx, "list_tasks", { workspace_id: ws })).isError).toBe(false);
      await expectToolDenied(ai.ctx, "create_task", { workspace_id: ws, title: "x" });
      await expectToolDenied(ai.ctx, "update_doc", { workspace_id: ws, doc_id: doc, title: "x" });
      const write = await ai.raw.from("tasks").update({ title: "hijacked" }).eq("id", task).select();
      expect(write.data ?? []).toEqual([]);

      await setMcpPolicy(team.owner, ws, { policy: "off" });
      expect(await toolNames(ai.ctx)).toEqual([]);
      expect((await call(ai.ctx, "list_workspaces")).data).toEqual([]);
      await expectToolDenied(ai.ctx, "list_tasks", { workspace_id: ws });
      await expectToolDenied(ai.ctx, "get_workspace_summary", { workspace_id: ws });
      expect((await ai.raw.from("tasks").select("id").eq("workspace_id", ws)).data).toEqual([]);
      expect((await ai.raw.from("docs").select("id").eq("workspace_id", ws)).data).toEqual([]);

      await setMcpPolicy(team.owner, ws, { policy: "read_write" });
      expect((await call(ai.ctx, "create_task", { workspace_id: ws, title: "Allowed again" })).isError).toBe(false);
    });

    it("only the owner can change it; new workspaces start with AI access off", async () => {
      await expectDenied(setMcpPolicy(team.full, ws, { policy: "off" }));
      await expectDenied(setMcpPolicy(team.sales, ws, { policy: "off" }));
      const forced = await team.full.db.from("workspaces").update({ mcp_policy: "off" }).eq("id", ws).select();
      expect(forced.error !== null || (forced.data ?? []).length === 0).toBe(true);
      const { getWorkspace } = await import("@/server/modules/workspaces/service");
      expect((await getWorkspace(team.owner, ws)).workspace.mcp_policy).toBe("read_write");
      const fresh = await createTeam("McpFresh");
      expect((await getWorkspace(fresh.owner, fresh.workspaceId)).workspace.mcp_policy).toBe("off");
    });
  });

  describe("revocation applies on the very next call, with the same token", () => {
    it("the owner revoking the member's role", async () => {
      const ai = await connectAi(team.guest, [ws]); // Docs view
      expect((await call(ai.ctx, "read_doc", { workspace_id: ws, doc_id: doc })).isError).toBe(false);
      await setMemberRole(team.owner, ws, { userId: team.guest.userId, roleId: null });
      await expectToolDenied(ai.ctx, "read_doc", { workspace_id: ws, doc_id: doc });
      expect(await toolNames(ai.ctx)).toEqual(BASE_TOOLS);
      await setMemberRole(team.owner, ws, { userId: team.guest.userId, roleId: team.roles.guest });
    });

    it("the owner disconnecting a member's app", async () => {
      const ai = await connectAi(team.writer, [ws], "Writer's AI");
      expect((await call(ai.ctx, "read_doc", { workspace_id: ws, doc_id: doc })).isError).toBe(false);
      const seen = await listWorkspaceConnections(team.owner, ws);
      expect(seen).toContainEqual(expect.objectContaining({ user_id: team.writer.userId, client_name: "Writer's AI" }));
      expect(seen.find((c) => c.client_id === ai.clientId)?.last_used_at).not.toBeNull();

      // Only the owner may do this; not Full Access, not another member.
      await expectDenied(revokeMemberConnection(team.full, ws, { userId: team.writer.userId, clientId: ai.clientId }));
      await expectDenied(revokeMemberConnection(team.sales, ws, { userId: team.writer.userId, clientId: ai.clientId }));
      const forced = await team.full.db.rpc("mcp_revoke_any", { p_workspace: ws, p_user: team.writer.userId, p_client_id: ai.clientId });
      expect(forced.error?.code).toBe("42501");
      expect((await call(ai.ctx, "read_doc", { workspace_id: ws, doc_id: doc })).isError).toBe(false);

      await revokeMemberConnection(team.owner, ws, { userId: team.writer.userId, clientId: ai.clientId });
      await expectToolDenied(ai.ctx, "read_doc", { workspace_id: ws, doc_id: doc });
      expect((await ai.raw.from("docs").select("id").eq("workspace_id", ws)).data).toEqual([]);
      const log = await listAudit(team.owner, ws, { event: "mcp." });
      expect(log.map((e) => e.event)).toEqual(expect.arrayContaining(["mcp.connected", "mcp.revoked", "mcp.policy_changed"]));
    });

    it("the member disconnecting their own app kills the token itself", async () => {
      const ai = await connectAi(team.writer, [ws]);
      expect((await listMyConnections(team.writer)).map((c) => c.client_id)).toContain(ai.clientId);
      await revokeMyConnection(team.writer, { clientId: ai.clientId });
      // Our own rule, enforced by the database even while the JWT is unexpired:
      await expectToolDenied(ai.ctx, "read_doc", { workspace_id: ws, doc_id: doc });
      expect((await ai.raw.from("docs").select("id").eq("workspace_id", ws)).data).toEqual([]);
      // And the endpoint no longer accepts the token at all.
      expect(await getMcpCtx(ai.token)).toBeNull();
      expect((await listMyConnections(team.writer)).map((c) => c.client_id)).not.toContain(ai.clientId);
    });

    it("a member cannot see or revoke someone else's connection", async () => {
      const ai = await connectAi(team.sales, [ws]);
      expect((await listMyConnections(team.writer)).some((c) => c.client_id === ai.clientId)).toBe(false);
      const seen = await team.writer.db.from("mcp_connections").select("client_id").eq("client_id", ai.clientId);
      expect(seen.data).toEqual([]);
      await revokeMyConnection(team.writer, { clientId: ai.clientId }); // revokes nothing of theirs
      expect((await call(ai.ctx, "list_tasks", { workspace_id: ws })).isError).toBe(false);
      await expectDenied(listWorkspaceConnections(team.writer, ws));
    });

    it("removing the member from the workspace ends their connections to it", async () => {
      const { removeMember } = await import("@/server/modules/members/service");
      const ai = await connectAi(team.guest, [ws]);
      expect((await call(ai.ctx, "read_doc", { workspace_id: ws, doc_id: doc })).isError).toBe(false);
      await removeMember(team.owner, ws, team.guest.userId);
      await expectToolDenied(ai.ctx, "read_doc", { workspace_id: ws, doc_id: doc });
      expect((await listWorkspaceConnections(team.owner, ws)).some((c) => c.user_id === team.guest.userId)).toBe(false);
    });
  });
});
