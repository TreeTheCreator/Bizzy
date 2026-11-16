import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleApi } from "@/server/api/handler";
import type { Ctx } from "@/server/context";
import { getApiCtx } from "@/server/db/apikey";
import { createApiKey, listApiKeys, revokeApiKey } from "@/server/modules/apikeys/service";
import { listAudit } from "@/server/modules/audit/service";
import {
  createCompany,
  createContact,
  createDeal,
  deleteDeal,
  getDeal,
  importContacts,
  listCompanies,
  listContacts,
  listDeals,
  listStages,
  updateDeal,
} from "@/server/modules/crm/service";
import {
  addInvoiceLine,
  createExpense,
  createInvoice,
  deleteInvoice,
  getCashFlow,
  getInvoice,
  listBudgets,
  listInvoices,
  setBudget,
  setInvoiceStatus,
} from "@/server/modules/finance/service";
import { withinRateLimit } from "@/server/modules/limits/service";
import { listMembers, setMemberRole } from "@/server/modules/members/service";
import { createRole, updateRole } from "@/server/modules/roles/service";
import { createTask } from "@/server/modules/tasks/service";
import { createWebhook, listWebhooks, setWebhookActive } from "@/server/modules/webhooks/service";
import { getWorkspace, listMyWorkspaces } from "@/server/modules/workspaces/service";
import { type Team, admin, cleanup, createTeam, expectCode, expectDenied, pgClient } from "../helpers";
import { dbTestsEnabled } from "../setup";

// Phase 2: CRM, Finance, API keys, rate limits and webhooks.
// In this team: `sales` sells (CRM edit), `writer` keeps the books (Finance
// manage), `guest` runs integrations (Settings manage + CRM view), and `full`
// holds Full Access.

const none = new URLSearchParams();

describe.skipIf(!dbTestsEnabled || !process.env.SUPABASE_JWT_SECRET)("phase 2", () => {
  let team: Team;
  let other: Team;
  let ws: string;
  let integratorRole: string;
  let stage: Record<"lead" | "won" | "lost", string>;

  beforeAll(async () => {
    [team, other] = await Promise.all([createTeam("P2"), createTeam("P2Other")]);
    ws = team.workspaceId;
    const { owner } = team;
    const seller = await createRole(owner, ws, { name: "Seller", kind: "custom", permissions: { crm: { level: "edit" } } });
    const books = await createRole(owner, ws, { name: "Books", kind: "custom", permissions: { finance: { level: "manage" } } });
    integratorRole = await createRole(owner, ws, {
      name: "Integrator",
      kind: "custom",
      permissions: { settings: { level: "manage" }, crm: { level: "view" } },
    });
    await setMemberRole(owner, ws, { userId: team.sales.userId, roleId: seller });
    await setMemberRole(owner, ws, { userId: team.writer.userId, roleId: books });
    await setMemberRole(owner, ws, { userId: team.guest.userId, roleId: integratorRole });
    const stages = await listStages(owner, ws);
    stage = {
      lead: stages.find((s) => s.name === "Lead")!.id,
      won: stages.find((s) => s.kind === "won")!.id,
      lost: stages.find((s) => s.kind === "lost")!.id,
    };
  });
  afterAll(cleanup);

  describe("CRM", () => {
    it("every workspace starts with the same five stages", async () => {
      expect((await listStages(team.owner, ws)).map((s) => s.name)).toEqual(["Lead", "Qualified", "Proposal", "Won", "Lost"]);
      expect(await listStages(other.owner, other.workspaceId)).toHaveLength(5);
    });

    it("follows the role: edit can add and change, only manage deletes, others see nothing", async () => {
      const { sales, writer, norole, owner } = team;
      const company = await createCompany(sales, ws, { name: "Northwind" });
      const contact = await createContact(sales, ws, { name: "Maya", email: "maya@northwind.test", companyId: company });
      const deal = await createDeal(sales, ws, { title: "Redesign", amount: "6000.50", companyId: company, contactId: contact });
      expect(await getDeal(sales, ws, deal)).toMatchObject({ amount: 6000.5, stage_id: stage.lead, closed_at: null });
      await expectDenied(deleteDeal(sales, ws, deal));
      for (const user of [writer, norole]) {
        await expectDenied(listDeals(user, ws));
        await expectDenied(listContacts(user, ws));
        await expectDenied(createCompany(user, ws, { name: "x" }));
        expect((await user.db.from("deals").select("id").eq("workspace_id", ws)).data).toEqual([]);
      }
      await expectCode(createDeal(sales, ws, { title: "Bad", amount: -1 }), "invalid");
      await expectCode(createContact(sales, ws, { name: "Bad", email: "not-an-email" }), "invalid");
      await deleteDeal(owner, ws, deal);
    });

    it("closes a deal when it reaches a won or lost stage and reopens it when moved back", async () => {
      const deal = await createDeal(team.sales, ws, { title: "Retainer", amount: 3000 });
      await updateDeal(team.sales, ws, deal, { stageId: stage.won });
      expect((await getDeal(team.sales, ws, deal)).closed_at).not.toBeNull();
      expect((await listDeals(team.sales, ws, { openOnly: true })).map((d) => d.id)).not.toContain(deal);
      await updateDeal(team.sales, ws, deal, { stageId: stage.lead });
      expect((await getDeal(team.sales, ws, deal)).closed_at).toBeNull();
      // A stage from another workspace is refused.
      const foreign = (await listStages(other.owner, other.workspaceId))[0].id;
      await expectCode(updateDeal(team.sales, ws, deal, { stageId: foreign }), "invalid");
    });

    it("imports contacts and creates the companies they name", async () => {
      const count = await importContacts(team.sales, ws, [
        { name: "Ana", email: "ana@bolt.test", company: "Bolt" },
        { name: "Ben", company: "bolt" },
        { name: "Cy", company: "Northwind" },
        { name: "Di" },
      ]);
      expect(count).toBe(4);
      const companies = await listCompanies(team.sales, ws);
      expect(companies.map((c) => c.name).sort()).toEqual(["Bolt", "Northwind"]);
      const bolt = companies.find((c) => c.name === "Bolt")!.id;
      expect(await listContacts(team.sales, ws, { companyId: bolt })).toHaveLength(2);
      expect((await listContacts(team.sales, ws, { query: "ana@" })).map((c) => c.name)).toEqual(["Ana"]);
      await expectCode(importContacts(team.sales, ws, [{ name: "" }]), "invalid");
      await expectDenied(importContacts(team.writer, ws, [{ name: "x" }]));
    });
  });

  describe("Finance", () => {
    it("numbers invoices per workspace and keeps the total equal to the lines", async () => {
      const { writer } = team;
      const first = await createInvoice(writer, ws, {
        customerName: "Juno Ltd",
        lines: [{ description: "Design", quantity: 2, unitPrice: 1500 }, { description: "Hosting", unitPrice: "99.99" }],
      });
      const second = await createInvoice(writer, ws, { customerName: "Harbor Co" });
      const a = (await getInvoice(writer, ws, first)).invoice;
      const b = (await getInvoice(writer, ws, second)).invoice;
      expect(b.number).toBe(a.number + 1);
      expect(a).toMatchObject({ total: 3099.99, status: "draft", sent_at: null });
      // Another workspace has its own numbering.
      const theirs = await createInvoice(other.owner, other.workspaceId, { customerName: "Elsewhere" });
      expect((await getInvoice(other.owner, other.workspaceId, theirs)).invoice.number).toBe(1);

      // The client cannot set the number, the total or the timestamps directly.
      await writer.db.from("invoices").update({ number: 999, total: 1, paid_at: "2020-01-01" }).eq("id", first);
      expect((await getInvoice(writer, ws, first)).invoice).toMatchObject({ number: a.number, total: 3099.99, paid_at: null });
    });

    it("locks the lines once sent, and stamps sent and paid", async () => {
      const { writer } = team;
      const invoice = await createInvoice(writer, ws, { customerName: "Lock Test", dueDate: "2020-01-31" });
      const line = await addInvoiceLine(writer, ws, invoice, { description: "Work", unitPrice: 400 });
      await setInvoiceStatus(writer, ws, invoice, { status: "sent" });
      await expectCode(addInvoiceLine(writer, ws, invoice, { description: "Late", unitPrice: 1 }), "invalid");
      expect((await writer.db.from("invoice_lines").delete().eq("id", line)).error).not.toBeNull();
      const flow = await getCashFlow(writer, ws);
      expect(flow.summary.unpaid).toBeGreaterThanOrEqual(400);
      expect(flow.summary.overdue).toBeGreaterThanOrEqual(400); // due in 2020
      await setInvoiceStatus(writer, ws, invoice, { status: "paid" });
      const paid = (await getInvoice(writer, ws, invoice)).invoice;
      expect(paid.sent_at).not.toBeNull();
      expect(paid.paid_at).not.toBeNull();
      expect((await getCashFlow(writer, ws)).summary.paidThisMonth).toBeGreaterThanOrEqual(400);
      await deleteInvoice(writer, ws, invoice);
    });

    it("follows the role, and an invoice from a deal needs CRM access too", async () => {
      const { owner, sales, writer, full } = team;
      await expectDenied(listInvoices(sales, ws));
      await expectDenied(createExpense(sales, ws, { amount: 5 }));
      await expectDenied(getCashFlow(sales, ws));
      expect((await sales.db.from("expenses").select("id").eq("workspace_id", ws)).data).toEqual([]);

      const company = await createCompany(owner, ws, { name: "Deal Customer" });
      const deal = await createDeal(owner, ws, { title: "Branding", amount: 4000, companyId: company, stageId: stage.won });
      // The bookkeeper has no CRM access: the deal does not exist for them.
      await expectCode(createInvoice(writer, ws, { dealId: deal }), "not_found");
      const invoice = await createInvoice(full, ws, { dealId: deal });
      const loaded = await getInvoice(writer, ws, invoice);
      expect(loaded.invoice).toMatchObject({ customer_name: "Deal Customer", total: 4000, deal_id: deal });
      expect(loaded.lines.map((l) => l.description)).toEqual(["Branding"]);
    });

    it("tracks expenses against budgets", async () => {
      const { writer } = team;
      const month = new Date().toISOString().slice(0, 7);
      await createExpense(writer, ws, { amount: 120, category: "Software" });
      await createExpense(writer, ws, { amount: "30.50", category: "software" });
      await createExpense(writer, ws, { amount: 75, category: "Travel" });
      await setBudget(writer, ws, { category: "Software", amount: 100 });
      await setBudget(writer, ws, { category: "Software", amount: 200 }); // replaces
      const result = await listBudgets(writer, ws, { month });
      expect(result.budgets).toMatchObject([{ category: "Software", amount: 200, spent: 150.5 }]);
      expect(result.unbudgeted).toBe(75);
      expect((await getCashFlow(writer, ws)).summary.spentThisMonth).toBeGreaterThanOrEqual(225.5);
    });
  });

  describe("API keys", () => {
    let writeKey: string;
    let readKey: string;
    let write: { ctx: Ctx; workspaceId: string };
    let read: { ctx: Ctx; workspaceId: string };

    beforeAll(async () => {
      writeKey = (await createApiKey(team.owner, ws, { name: "Sync", scope: "write" })).key;
      readKey = (await createApiKey(team.owner, ws, { name: "Reports", scope: "read" })).key;
      write = (await getApiCtx(writeKey))!;
      read = (await getApiCtx(readKey))!;
    });

    it("only Settings managers create keys; the key itself is never stored", async () => {
      await expectDenied(createApiKey(team.sales, ws, { name: "x", scope: "read" }));
      await expectDenied(listApiKeys(team.writer, ws));
      expect(writeKey).toMatch(/^bz_[0-9a-f]{48}$/);
      const sql = await pgClient();
      const { rows } = await sql.query("select prefix, key_hash from public.api_keys where workspace_id = $1", [ws]);
      await sql.end();
      for (const row of rows) {
        expect(writeKey.startsWith(row.prefix) || readKey.startsWith(row.prefix)).toBe(true);
        expect(row.key_hash).not.toContain(writeKey.slice(11));
      }
      expect((await team.owner.db.from("api_keys").select("key_hash")).error).not.toBeNull();
    });

    it("refuses unknown, malformed and revoked keys", async () => {
      expect(await getApiCtx("bz_" + "0".repeat(48))).toBeNull();
      expect(await getApiCtx("nonsense")).toBeNull();
      expect(await getApiCtx("")).toBeNull();
      expect(write.workspaceId).toBe(ws);
      expect(write.ctx.userId).toBe(team.owner.userId);
    });

    it("serves the API as the member, within the key's scope", async () => {
      const made = await handleApi(write.ctx, ws, "POST", ["tasks"], none, { title: "From the API", due_date: "2030-01-02" });
      expect(made.status).toBe(201);
      const id = (made.body as { data: { id: string } }).data.id;
      const got = await handleApi(read.ctx, ws, "GET", ["tasks", id], none, {});
      expect(got.body).toMatchObject({ data: { task: { title: "From the API", due_date: "2030-01-02" } } });
      expect((await handleApi(write.ctx, ws, "PATCH", ["tasks", id], none, { status: "done" })).status).toBe(200);
      expect((await handleApi(read.ctx, ws, "GET", ["deals"], none, {})).status).toBe(200);
      expect((await handleApi(read.ctx, ws, "GET", ["cash-flow"], none, {})).status).toBe(200);

      // A read key changes nothing, through the API or the raw database.
      for (const [method, path, body] of [
        ["POST", ["tasks"], { title: "no" }],
        ["PATCH", ["tasks", id], { title: "no" }],
        ["DELETE", ["tasks", id], {}],
        ["POST", ["expenses"], { amount: 1 }],
      ] as const) {
        expect((await handleApi(read.ctx, ws, method, [...path], none, body)).status, `${method} ${path}`).toBe(403);
      }
      expect((await read.ctx.db.from("tasks").update({ title: "hacked" }).eq("id", id).select("id")).data).toEqual([]);

      expect((await handleApi(write.ctx, ws, "GET", ["nope"], none, {})).status).toBe(404);
      expect((await handleApi(write.ctx, ws, "DELETE", ["tasks"], none, {})).status).toBe(405);
      expect((await handleApi(write.ctx, ws, "POST", ["tasks"], none, {})).status).toBe(400);
      expect((await handleApi(write.ctx, ws, "GET", ["tasks", "not-an-id"], none, {})).status).toBe(400);

      const log = await listAudit(team.owner, ws, { event: "api.call" });
      expect(log.filter((e) => e.channel === "api").map((e) => e.target)).toEqual(
        expect.arrayContaining(["POST /tasks", `PATCH /tasks/${id}`]),
      );
    });

    it("never reaches settings, owner powers, other workspaces, or more keys", async () => {
      const { ctx } = write; // the OWNER's own write key
      await expectDenied(listMembers(ctx, ws));
      await expectDenied(createApiKey(ctx, ws, { name: "more", scope: "write" }));
      await expectDenied(createWebhook(ctx, ws, { url: "https://example.com/h", events: ["task.created"] }));
      await expectDenied(setMemberRole(ctx, ws, { userId: team.sales.userId, roleId: team.roles.fullAccess }));
      await expectDenied(listAudit(ctx, ws));
      const { access } = await getWorkspace(ctx, ws);
      expect(access.levels.settings).toBe("none");
      for (const table of ["roles", "invites", "audit_log", "api_keys", "webhooks"]) {
        expect((await ctx.db.from(table).select("workspace_id")).data ?? [], table).toEqual([]);
      }
      // Like any member, the key's member sees their own membership row, and no one else's.
      expect((await ctx.db.from("memberships").select("user_id")).data).toEqual([{ user_id: team.owner.userId }]);
      expect((await ctx.db.from("memberships").update({ role_id: team.roles.fullAccess }).eq("user_id", team.sales.userId).select("user_id")).data ?? []).toEqual([]);
      expect((await ctx.db.rpc("api_key_create", { p_workspace: ws, p_name: "x", p_scope: "write" })).error).not.toBeNull();
      expect((await ctx.db.rpc("create_workspace", { p_name: "x" })).error).not.toBeNull();

      // A user in two workspaces: the key reaches only the one it was made in.
      const both = team.full;
      const { data: role } = await other.owner.db.from("roles").select("id").eq("workspace_id", other.workspaceId).eq("kind", "full_access").single();
      const { createInvite, acceptInvite } = await import("@/server/modules/members/service");
      const { token } = await createInvite(other.owner, other.workspaceId, { email: both.email });
      await acceptInvite(both, token);
      await setMemberRole(other.owner, other.workspaceId, { userId: both.userId, roleId: role!.id });
      const key = (await createApiKey(both, ws, { name: "Both", scope: "write" })).key;
      const api = (await getApiCtx(key))!;
      expect((await listMyWorkspaces(api.ctx)).map((w) => w.id)).toEqual([ws]);
      await expectDenied(createTask(api.ctx, other.workspaceId, { title: "x" }));
      expect((await api.ctx.db.from("tasks").select("id").eq("workspace_id", other.workspaceId)).data).toEqual([]);
    });

    it("a web session, or a key token on its own, is not an API caller", async () => {
      const impostor: Ctx = { ...team.owner, channel: "api" };
      await expectDenied(createTask(impostor, ws, { title: "x" }));
    });

    it("stops on the next call when the key is revoked or the member loses access", async () => {
      const key = (await createApiKey(team.full, ws, { name: "Temp", scope: "write" })).key;
      const api = (await getApiCtx(key))!;
      expect((await handleApi(api.ctx, ws, "GET", ["tasks"], none, {})).status).toBe(200);

      await setMemberRole(team.owner, ws, { userId: team.full.userId, roleId: null });
      expect((await handleApi(api.ctx, ws, "GET", ["tasks"], none, {})).status).toBe(403);
      await setMemberRole(team.owner, ws, { userId: team.full.userId, roleId: team.roles.fullAccess });
      expect((await handleApi(api.ctx, ws, "GET", ["tasks"], none, {})).status).toBe(200);

      const { id } = (await listApiKeys(team.owner, ws)).find((k) => k.name === "Temp")!;
      await revokeApiKey(team.owner, ws, id);
      expect((await handleApi(api.ctx, ws, "GET", ["tasks"], none, {})).status).toBe(403); // the token already minted
      expect(await getApiCtx(key)).toBeNull();
      expect((await listApiKeys(team.owner, ws)).map((k) => k.name)).not.toContain("Temp");
    });

    it("a token signed with the wrong secret is worthless", async () => {
      const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const { createHmac } = await import("node:crypto");
      const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
        role: "authenticated", aud: "authenticated", sub: team.owner.userId, exp: Math.floor(Date.now() / 1000) + 60,
      })}`;
      const forged = `${body}.${createHmac("sha256", "not-the-secret-not-the-secret-0000").update(body).digest("base64url")}`;
      const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        global: { headers: { Authorization: `Bearer ${forged}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const result = await db.from("tasks").select("id").eq("workspace_id", ws);
      expect(result.data ?? []).toEqual([]);
      expect(result.error).not.toBeNull();
    });
  });

  describe("rate limits", () => {
    it("allows the bucket's quota per minute, per caller, then refuses", async () => {
      // If the minute is about to roll over, wait so all calls share one window.
      const seconds = new Date().getUTCSeconds();
      if (seconds > 50) await new Promise((resolve) => setTimeout(resolve, (61 - seconds) * 1000));
      const results: boolean[] = [];
      for (let i = 0; i < 11; i++) results.push(await withinRateLimit(team.norole, "mcp.destructive"));
      expect(results).toEqual([...Array(10).fill(true), false]);
      expect(await withinRateLimit(team.sales, "mcp.destructive")).toBe(true); // someone else's allowance
      expect((await team.norole.db.rpc("rate_limit_hit", { p_bucket: "made-up" })).error).not.toBeNull();
      expect((await team.norole.db.from("rate_limits").select("*")).error).not.toBeNull();
    });

    it("answers 429 on the API once a key is over its allowance", async () => {
      const key = (await createApiKey(team.owner, ws, { name: "Busy", scope: "read" })).key;
      const api = (await getApiCtx(key))!;
      const sql = await pgClient();
      await sql.query(
        `insert into public.rate_limits (user_id, subject, bucket, window_start, count)
         select user_id, id::text, 'api', date_trunc('minute', now()) + i * interval '1 minute', 120
         from public.api_keys, generate_series(0, 1) as i where name = 'Busy' and workspace_id = $1`,
        [ws],
      );
      await sql.end();
      const response = await handleApi(api.ctx, ws, "GET", ["tasks"], none, {});
      expect(response.status).toBe(429);
      expect(Number(response.headers?.["Retry-After"])).toBeGreaterThan(0);
    });
  });

  describe("webhooks", () => {
    const pending = async (webhookId: string) => {
      const sql = await pgClient();
      const { rows } = await sql.query(
        "select event, payload from public.webhook_deliveries where webhook_id = $1 order by id",
        [webhookId],
      );
      await sql.end();
      return rows as { event: string; payload: { data: Record<string, unknown> } }[];
    };

    it("queues the chosen events, signed with a secret no client can read back", async () => {
      const { owner } = team;
      const hook = await createWebhook(owner, ws, {
        url: "https://hooks.example.com/bizzy",
        events: ["deal.won", "invoice.paid", "task.completed"],
      });
      expect(hook.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
      expect((await owner.db.from("webhooks").select("secret")).error).not.toBeNull();
      expect((await owner.db.from("webhook_deliveries").select("payload")).error).not.toBeNull();

      const deal = await createDeal(owner, ws, { title: "Hooked", amount: 900 }); // deal.created: not subscribed
      await updateDeal(owner, ws, deal, { stageId: stage.won });
      const invoice = await createInvoice(owner, ws, { customerName: "Hook Co", lines: [{ description: "x", unitPrice: 50 }] });
      await setInvoiceStatus(owner, ws, invoice, { status: "sent" }); // invoice.sent: not subscribed
      await setInvoiceStatus(owner, ws, invoice, { status: "paid" });
      const queued = await pending(hook.id);
      expect(queued.map((d) => d.event)).toEqual(["deal.won", "invoice.paid"]);
      expect(queued[0].payload.data).toMatchObject({ id: deal, title: "Hooked", stage: "Won" });
      expect(queued[1].payload.data).toMatchObject({ id: invoice, total: 50, status: "paid" });

      const listed = await listWebhooks(owner, ws);
      expect(listed.deliveries.filter((d) => d.webhook_id === hook.id)).toHaveLength(2);
      await setWebhookActive(owner, ws, hook.id, { active: false });
      await updateDeal(owner, ws, deal, { stageId: stage.lead });
      await updateDeal(owner, ws, deal, { stageId: stage.won });
      expect(await pending(hook.id)).toHaveLength(2); // paused: nothing new
    });

    it("carries only what its creator may see, checked again at every event", async () => {
      const { owner, guest, sales } = team; // guest = Integrator: Settings manage + CRM view
      await expectDenied(createWebhook(sales, ws, { url: "https://example.com/h", events: ["deal.won"] }));
      await expectCode(createWebhook(guest, ws, { url: "https://example.com/h", events: ["invoice.paid"] }), "invalid");
      await expectCode(createWebhook(guest, ws, { url: "http://example.com/h", events: ["deal.won"] }), "invalid");
      for (const url of ["https://127.0.0.1/h", "https://localhost/h", "https://10.0.0.5/h", "https://[::1]/h", "https://printer.local/h"]) {
        await expectCode(createWebhook(guest, ws, { url, events: ["deal.won"] }), "invalid");
      }
      await expectCode(createWebhook(guest, ws, { url: "https://example.com/h", events: [] }), "invalid");
      const hook = await createWebhook(guest, ws, { url: "https://example.com/h", events: ["deal.created"] });

      await createDeal(owner, ws, { title: "Seen" });
      expect((await pending(hook.id)).map((d) => d.payload.data.title)).toEqual(["Seen"]);
      // The owner takes CRM away from the Integrator role: their webhook goes quiet.
      await updateRole(owner, ws, integratorRole, {
        name: "Integrator",
        kind: "custom",
        permissions: { settings: { level: "manage" } },
      });
      await createDeal(owner, ws, { title: "Unseen" });
      expect(await pending(hook.id)).toHaveLength(1);
    });

    it("lets only the delivery worker claim and report, with retries and give-up", async () => {
      const { owner } = team;
      expect((await owner.db.rpc("webhook_claim", { p_limit: 5 })).error).not.toBeNull();
      expect((await owner.db.rpc("webhook_report", { p_delivery: 1, p_status: 200 })).error).not.toBeNull();

      const hook = await createWebhook(owner, ws, { url: "https://retry.example.com/h", events: ["task.created"] });
      await createTask(owner, ws, { title: "Ping" });
      const mine = async () => {
        const { data } = await admin().rpc("webhook_claim", { p_limit: 100 });
        return (data as { delivery_id: number; url: string; secret: string; attempts: number }[]).filter(
          (d) => d.url === "https://retry.example.com/h",
        );
      };
      const [claimed] = await mine();
      expect(claimed).toMatchObject({ secret: hook.secret, attempts: 1 });
      expect(await mine()).toEqual([]); // not due again yet

      await admin().rpc("webhook_report", { p_delivery: claimed.delivery_id, p_status: 500 });
      let state = (await listWebhooks(owner, ws)).webhooks.find((w) => w.id === hook.id)!;
      expect(state).toMatchObject({ failure_count: 1, last_status: 500, active: true });
      let delivery = (await listWebhooks(owner, ws)).deliveries.find((d) => d.id === claimed.delivery_id)!;
      expect(delivery).toMatchObject({ status: "pending", attempts: 1, response_status: 500 });

      // Make it due again, then succeed.
      const sql = await pgClient();
      await sql.query("update public.webhook_deliveries set next_attempt_at = now() where id = $1", [claimed.delivery_id]);
      await sql.end();
      const [again] = await mine();
      expect(again).toMatchObject({ delivery_id: claimed.delivery_id, attempts: 2 });
      await admin().rpc("webhook_report", { p_delivery: again.delivery_id, p_status: 204 });
      state = (await listWebhooks(owner, ws)).webhooks.find((w) => w.id === hook.id)!;
      expect(state).toMatchObject({ failure_count: 0, last_status: 204 });
      delivery = (await listWebhooks(owner, ws)).deliveries.find((d) => d.id === claimed.delivery_id)!;
      expect(delivery).toMatchObject({ status: "delivered", attempts: 2 });
    });
  });
});
