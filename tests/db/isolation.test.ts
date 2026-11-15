import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDoc, createUpload, getDoc, getDownloadUrl, updateDoc } from "@/server/modules/docs/service";
import { listMembers } from "@/server/modules/members/service";
import { addComment, createProject, createTask, getTask, listTasks, updateTask } from "@/server/modules/tasks/service";
import { getWorkspace, listMyWorkspaces } from "@/server/modules/workspaces/service";
import { type Team, anonClient, cleanup, createTeam, expectCode, expectDenied, pgClient } from "../helpers";
import { dbTestsEnabled } from "../setup";

// Non-negotiable rule 7: a user in workspace A can never read or write
// workspace B's data. Team A's OWNER (the most powerful role there is) attacks
// team B through the services and through the raw database API.

describe.skipIf(!dbTestsEnabled)("tenant isolation", () => {
  let a: Team;
  let b: Team;
  let bTask: string;
  let bProject: string;
  let bDoc: string;
  let bComment: string;
  let tenantTables: string[] = [];

  beforeAll(async () => {
    [a, b] = await Promise.all([createTeam("A"), createTeam("B")]);
    bProject = await createProject(b.owner, b.workspaceId, { name: "B project" });
    bTask = await createTask(b.owner, b.workspaceId, { title: "B secret task", projectId: bProject, assigneeId: b.sales.userId });
    bComment = await addComment(b.owner, b.workspaceId, bTask, { body: "B secret comment" });
    bDoc = await createDoc(b.owner, b.workspaceId, { title: "B secret doc", content: "top secret" });

    const sql = await pgClient();
    const { rows } = await sql.query(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and c.relname not in ('profiles', 'workspaces', 'rate_limits') order by 1`,
    );
    tenantTables = rows.map((r) => r.name as string);
    await sql.end();
  });
  afterAll(cleanup);

  describe("schema guarantees (checked against the live database)", () => {
    it("every table in the public schema has row-level security enabled", async () => {
      const sql = await pgClient();
      const { rows } = await sql.query(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
      );
      await sql.end();
      expect(rows).toEqual([]);
    });

    it("every table except profiles and workspaces has a NOT NULL workspace_id", async () => {
      const sql = await pgClient();
      // rate_limits is the one other exception: request counters keyed by user,
      // holding no workspace data. It must stay unreachable for every client role.
      const counters = await sql.query(
        `select r from unnest(array['anon', 'authenticated']) as r, unnest(array['select', 'insert', 'update', 'delete']) as p
         where has_table_privilege(r, 'public.rate_limits', p)`,
      );
      expect(counters.rows).toEqual([]);
      const { rows } = await sql.query(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and c.relname not in ('profiles', 'workspaces', 'rate_limits')
           and not exists (select 1 from pg_attribute att where att.attrelid = c.oid
                           and att.attname = 'workspace_id' and att.attnotnull and not att.attisdropped)`,
      );
      await sql.end();
      expect(rows).toEqual([]);
      expect(tenantTables.length).toBeGreaterThanOrEqual(12);
    });

    it("signed-out visitors can execute no function and read no table", async () => {
      const sql = await pgClient();
      const fns = await sql.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`,
      );
      const tables = await sql.query(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
             or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))`,
      );
      await sql.end();
      expect(fns.rows).toEqual([]);
      expect(tables.rows).toEqual([]);
      const anon = anonClient();
      for (const table of ["workspaces", "tasks", "docs", "memberships", "profiles"]) {
        const { data } = await anon.from(table).select("*").limit(1);
        expect(data ?? [], table).toEqual([]);
      }
    });

    it("internal functions are not callable by signed-in users", async () => {
      const sql = await pgClient();
      const { rows } = await sql.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute') order by 1`,
      );
      await sql.end();
      expect(rows.map((r) => r.proname)).toEqual(
        [
          "accept_invite", "access_level", "api_key_create", "api_key_id", "api_key_resolve", "api_key_revoke",
          "app_pages", "can_manage_roles", "can_see_sensitive", "rate_limit_hit", "webhook_create",
          "webhook_event_page",
          "create_workspace", "has_any_access", "hash_invite_token", "invite_preview", "is_client_role",
          "is_member", "is_oauth_client", "is_owner", "log_event", "log_login", "mcp_cap", "mcp_connect",
          "mcp_log_call", "mcp_revoke", "mcp_revoke_any", "my_access", "my_overview", "my_role_id",
          "recently_authenticated", "save_role", "storage_workspace", "transfer_ownership",
          "workspace_members", "workspace_people",
        ].sort(),
      );
    });
  });

  describe("workspace A's owner against workspace B, through the services", () => {
    it("cannot open, list or read anything in B", async () => {
      await expectDenied(getWorkspace(a.owner, b.workspaceId));
      await expectDenied(listTasks(a.owner, b.workspaceId));
      await expectDenied(getTask(a.owner, b.workspaceId, bTask));
      await expectDenied(getDoc(a.owner, b.workspaceId, bDoc));
      await expectDenied(listMembers(a.owner, b.workspaceId));
      expect((await listMyWorkspaces(a.owner)).map((w) => w.id)).toEqual([a.workspaceId]);
    });

    it("cannot reach B's rows by asking for them inside A", async () => {
      await expectCode(getTask(a.owner, a.workspaceId, bTask), "not_found");
      await expectCode(getDoc(a.owner, a.workspaceId, bDoc), "not_found");
      await expectCode(updateTask(a.owner, a.workspaceId, bTask, { title: "hijacked" }), "not_found");
      await expectCode(updateDoc(a.owner, a.workspaceId, bDoc, { title: "hijacked" }), "not_found");
      await expectCode(addComment(a.owner, a.workspaceId, bTask, { body: "hello B" }), "invalid");
    });

    it("cannot link A's data to B's projects, people or docs", async () => {
      await expectCode(createTask(a.owner, a.workspaceId, { title: "x", projectId: bProject }), "invalid");
      await expectCode(createTask(a.owner, a.workspaceId, { title: "x", assigneeId: b.sales.userId }), "invalid");
      await expectCode(createDoc(a.owner, a.workspaceId, { title: "x", parentId: bDoc }), "invalid");
    });

    it("cannot write to or read from B's file storage", async () => {
      await expectDenied(createUpload(a.owner, b.workspaceId, { name: "x.txt", sizeBytes: 1 }));
      const path = `${b.workspaceId}/11111111-1111-4111-8111-111111111111/x.txt`;
      const upload = await a.owner.db.storage.from("workspace-files").upload(path, new Blob(["x"]));
      expect(upload.error).not.toBeNull();
      const signed = await a.owner.db.storage.from("workspace-files").createSignedUploadUrl(path);
      expect(signed.error).not.toBeNull();
      const listed = await a.owner.db.storage.from("workspace-files").list(b.workspaceId);
      expect(listed.data ?? []).toEqual([]);
      await expectDenied(getDownloadUrl(a.owner, b.workspaceId, "11111111-1111-4111-8111-111111111111"));
    });
  });

  describe("workspace A's owner against workspace B, through the raw database API", () => {
    it("reads zero rows from every tenant table", async () => {
      for (const table of tenantTables) {
        // Tables that hide a secret column from clients cannot be read with "*".
        const columns = ["api_keys", "webhooks", "webhook_deliveries"].includes(table) ? "id, workspace_id" : "*";
        const { data, error } = await a.owner.db.from(table).select(columns).eq("workspace_id", b.workspaceId);
        expect(error, table).toBeNull();
        expect(data, table).toEqual([]);
      }
      const ws = await a.owner.db.from("workspaces").select("*").eq("id", b.workspaceId);
      expect(ws.data).toEqual([]);
      const profiles = await a.owner.db.from("profiles").select("id");
      expect(profiles.data).toEqual([{ id: a.owner.userId }]);
    });

    it("an unfiltered select never contains a row from B", async () => {
      for (const table of tenantTables) {
        const { data } = await a.owner.db.from(table).select("workspace_id");
        expect((data ?? []).filter((r) => r.workspace_id === b.workspaceId), table).toEqual([]);
      }
    });

    it("cannot insert into B", async () => {
      const me = a.owner.userId;
      const inserts: [string, Record<string, unknown>][] = [
        ["tasks", { workspace_id: b.workspaceId, title: "x", created_by: me }],
        ["projects", { workspace_id: b.workspaceId, name: "x", created_by: me }],
        ["docs", { workspace_id: b.workspaceId, title: "x", created_by: me }],
        ["task_comments", { workspace_id: b.workspaceId, task_id: bTask, author_id: me, body: "x" }],
        ["task_templates", { workspace_id: b.workspaceId, name: "x", created_by: me }],
        ["files", { workspace_id: b.workspaceId, name: "x", storage_path: `${b.workspaceId}/x/x`, uploaded_by: me }],
        ["roles", { workspace_id: b.workspaceId, name: "x" }],
        ["role_permissions", { workspace_id: b.workspaceId, role_id: b.roles.sales, page: "finance", level: "manage" }],
        ["invites", { workspace_id: b.workspaceId, email: a.owner.email, token_hash: "x".repeat(64), invited_by: me }],
        ["memberships", { workspace_id: b.workspaceId, user_id: me }],
        ["notifications", { workspace_id: b.workspaceId, user_id: b.owner.userId, kind: "x", title: "x" }],
        ["audit_log", { workspace_id: b.workspaceId, channel: "web", event: "role.assigned" }],
      ];
      for (const [table, row] of inserts) {
        const { error } = await a.owner.db.from(table).insert(row);
        expect(error, `insert into ${table} should fail`).not.toBeNull();
      }
    });

    it("cannot update or delete B's rows", async () => {
      const targets: [string, string, string][] = [
        ["tasks", "id", bTask],
        ["projects", "id", bProject],
        ["docs", "id", bDoc],
        ["task_comments", "id", bComment],
        ["roles", "id", b.roles.sales],
        ["workspaces", "id", b.workspaceId],
      ];
      for (const [table, column, value] of targets) {
        const update = await a.owner.db.from(table).update(table === "task_comments" ? { body: "x" } : { [table === "tasks" || table === "docs" ? "title" : "name"]: "hijacked" }).eq(column, value).select();
        expect(update.data ?? [], `update ${table}`).toEqual([]);
        const del = await a.owner.db.from(table).delete().eq(column, value).select();
        expect(del.data ?? [], `delete ${table}`).toEqual([]);
      }
      // B's data is intact.
      const { task, comments } = await getTask(b.owner, b.workspaceId, bTask);
      expect(task.title).toBe("B secret task");
      expect(comments).toHaveLength(1);
      expect((await getDoc(b.owner, b.workspaceId, bDoc)).doc.content).toBe("top secret");
    });

    it("cannot move one of A's rows into B", async () => {
      const mine = await createTask(a.owner, a.workspaceId, { title: "A task" });
      const { data, error } = await a.owner.db.from("tasks").update({ workspace_id: b.workspaceId }).eq("id", mine).select();
      expect(error !== null || (data ?? []).length === 0).toBe(true);
      expect((await getTask(a.owner, a.workspaceId, mine)).task.workspace_id).toBe(a.workspaceId);
    });

    it("the access functions return nothing useful for B", async () => {
      const access = await a.owner.db.rpc("my_access", { p_workspace: b.workspaceId });
      expect(access.data).toMatchObject({ member: false, is_owner: false });
      expect(Object.values((access.data as { levels: Record<string, string> }).levels).every((l) => l === "none")).toBe(true);
      expect((await a.owner.db.rpc("workspace_members", { p_workspace: b.workspaceId })).data).toEqual([]);
      expect((await a.owner.db.rpc("workspace_people", { p_workspace: b.workspaceId })).data).toEqual([]);
    });
  });

  it("a user in both workspaces gets each workspace's own role, never a mix", async () => {
    // A's owner is invited to B and given B's Sales role (tasks edit, docs view).
    const { createInvite, acceptInvite, setMemberRole } = await import("@/server/modules/members/service");
    const { token } = await createInvite(b.owner, b.workspaceId, { email: a.owner.email });
    await acceptInvite(a.owner, token);
    await setMemberRole(b.owner, b.workspaceId, { userId: a.owner.userId, roleId: b.roles.sales });
    const inA = await getWorkspace(a.owner, a.workspaceId);
    const inB = await getWorkspace(a.owner, b.workspaceId);
    expect(inA.access.isOwner).toBe(true);
    expect(inB.access.isOwner).toBe(false);
    expect(inB.access.levels).toMatchObject({ tasks: "edit", docs: "view", settings: "none" });
    await expectDenied(listMembers(a.owner, b.workspaceId)); // owner powers do not carry over
    await expectDenied(updateDoc(a.owner, b.workspaceId, bDoc, { title: "x" }));
  });
});
