import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAccess } from "@/server/authz/authorize";
import { listMembers, removeMember, setMemberRole } from "@/server/modules/members/service";
import { createRole, deleteRole, listRoles, updateRole } from "@/server/modules/roles/service";
import { createTask, listTasks } from "@/server/modules/tasks/service";
import { deleteWorkspace, getWorkspace, transferOwnership } from "@/server/modules/workspaces/service";
import {
  type Team,
  type TestUser,
  cleanup,
  createTeam,
  createUser,
  expectCode,
  expectDenied,
  freshAmr,
  pgClient,
  sqlAsClaims,
} from "../helpers";
import { dbTestsEnabled } from "../setup";

// Non-negotiable rule 1: only the workspace owner can create, edit, delete or
// assign roles. These tests attack that rule through the service layer AND
// directly through the database API, skipping our application code.

describe.skipIf(!dbTestsEnabled)("creator-only role granting", () => {
  let team: Team;
  let outsider: TestUser;
  const nonOwners = () => ({
    full: team.full,
    sales: team.sales,
    writer: team.writer,
    guest: team.guest,
    norole: team.norole,
    outsider,
  });

  beforeAll(async () => {
    team = await createTeam();
    outsider = await createUser("outsider");
  });
  afterAll(cleanup);

  describe("through the service layer", () => {
    for (const actor of ["full", "sales", "writer", "guest", "norole", "outsider"] as const) {
      it(`${actor} cannot create a role`, async () => {
        await expectDenied(createRole(nonOwners()[actor], team.workspaceId, { name: "Hack", kind: "custom", permissions: { finance: { level: "manage" } } }));
      });
      it(`${actor} cannot edit a role`, async () => {
        await expectDenied(updateRole(nonOwners()[actor], team.workspaceId, team.roles.sales, { name: "Sales", kind: "custom", permissions: { finance: { level: "manage" } } }));
      });
      it(`${actor} cannot delete a role`, async () => {
        await expectDenied(deleteRole(nonOwners()[actor], team.workspaceId, team.roles.sales));
      });
      it(`${actor} cannot give themselves Full Access`, async () => {
        const self = nonOwners()[actor];
        await expectDenied(setMemberRole(self, team.workspaceId, { userId: self.userId, roleId: team.roles.fullAccess }));
      });
      it(`${actor} cannot change someone else's role`, async () => {
        await expectDenied(setMemberRole(nonOwners()[actor], team.workspaceId, { userId: team.norole.userId, roleId: team.roles.sales }));
      });
      it(`${actor} cannot remove a member`, async () => {
        await expectDenied(removeMember(nonOwners()[actor], team.workspaceId, team.guest.userId));
      });
      it(`${actor} cannot transfer ownership or delete the workspace`, async () => {
        const self = nonOwners()[actor];
        const { workspace } = await getWorkspace(team.owner, team.workspaceId);
        await expectDenied(transferOwnership(self, team.workspaceId, { newOwnerId: self.userId, confirmName: workspace.name }));
        await expectDenied(deleteWorkspace(self, team.workspaceId, { confirmName: workspace.name }));
      });
    }

    it("nothing changed after all those attempts", async () => {
      const members = await listMembers(team.owner, team.workspaceId);
      const roleOf = (u: TestUser) => members.find((m) => m.user_id === u.userId)?.role_id;
      expect(roleOf(team.full)).toBe(team.roles.fullAccess);
      expect(roleOf(team.sales)).toBe(team.roles.sales);
      expect(roleOf(team.norole)).toBeNull();
      expect(members.some((m) => m.user_id === outsider.userId)).toBe(false);
      expect(members.filter((m) => m.is_owner).map((m) => m.user_id)).toEqual([team.owner.userId]);
      const roles = await listRoles(team.owner, team.workspaceId);
      expect(roles.map((r) => r.name).sort()).toEqual(["Full Access", "Guest accountant", "Sales", "Writer"]);
      expect(roles.find((r) => r.id === team.roles.sales)?.permissions.finance).toBeUndefined();
    });
  });

  describe("directly against the database API (bypassing the app)", () => {
    for (const actor of ["full", "sales", "norole", "outsider"] as const) {
      it(`${actor}: raw writes to roles, permissions and memberships are refused`, async () => {
        const db = nonOwners()[actor].db;
        const self = nonOwners()[actor].userId;

        const insertRole = await db.from("roles").insert({ workspace_id: team.workspaceId, name: `Raw ${actor}` });
        expect(insertRole.error).not.toBeNull();

        const builtin = await db.from("roles").insert({ workspace_id: team.workspaceId, name: `FA ${actor}`, kind: "full_access", is_builtin: true });
        expect(builtin.error).not.toBeNull();

        const perm = await db.from("role_permissions").insert({ role_id: team.roles.sales, workspace_id: team.workspaceId, page: "finance", level: "manage" });
        expect(perm.error).not.toBeNull();

        const upgrade = await db.from("role_permissions").update({ level: "manage" }).eq("role_id", team.roles.sales).select();
        expect(upgrade.data ?? []).toEqual([]);

        const selfPromote = await db.from("memberships").update({ role_id: team.roles.fullAccess }).eq("workspace_id", team.workspaceId).eq("user_id", self).select();
        expect(selfPromote.data ?? []).toEqual([]);

        const addMember = await db.from("memberships").insert({ workspace_id: team.workspaceId, user_id: outsider.userId, role_id: team.roles.fullAccess });
        expect(addMember.error).not.toBeNull();

        const rpc = await db.rpc("save_role", { p_workspace: team.workspaceId, p_role_id: null, p_name: `Rpc ${actor}`, p_kind: "custom", p_permissions: { finance: { level: "manage" } } });
        expect(rpc.error).not.toBeNull();

        const seize = await db.from("workspaces").update({ owner_id: self }).eq("id", team.workspaceId).select();
        expect(seize.error !== null || (seize.data ?? []).length === 0).toBe(true);

        const transfer = await db.rpc("transfer_ownership", { p_workspace: team.workspaceId, p_new_owner: self });
        expect(transfer.error).not.toBeNull();

        const kickOwner = await db.from("memberships").delete().eq("workspace_id", team.workspaceId).eq("user_id", team.owner.userId).select();
        expect(kickOwner.error !== null || (kickOwner.data ?? []).length === 0).toBe(true);

        const dropWorkspace = await db.from("workspaces").delete().eq("id", team.workspaceId).select();
        expect(dropWorkspace.data ?? []).toEqual([]);
      });
    }

    it("the workspace still has exactly one owner and the original roles", async () => {
      const { workspace } = await getWorkspace(team.owner, team.workspaceId);
      expect(workspace.owner_id).toBe(team.owner.userId);
      const roles = await listRoles(team.owner, team.workspaceId);
      expect(roles).toHaveLength(4);
    });
  });

  describe("guard rails that apply even to the owner", () => {
    it("the built-in Full Access role cannot be edited or deleted", async () => {
      await expectDenied(deleteRole(team.owner, team.workspaceId, team.roles.fullAccess));
      await expectDenied(updateRole(team.owner, team.workspaceId, team.roles.fullAccess, { name: "Renamed", kind: "custom", permissions: {} }));
    });

    it("the owner cannot be given a role, an expiry, or be removed", async () => {
      const raw = await team.owner.db.from("memberships").update({ role_id: team.roles.sales }).eq("workspace_id", team.workspaceId).eq("user_id", team.owner.userId).select();
      expect(raw.error).not.toBeNull();
      await expectDenied(removeMember(team.owner, team.workspaceId, team.owner.userId));
    });

    it("guest roles cannot be given manage or Settings", async () => {
      await expectCode(createRole(team.owner, team.workspaceId, { name: "Bad guest 1", kind: "guest", permissions: { docs: { level: "manage" } } }), "invalid");
      await expectCode(createRole(team.owner, team.workspaceId, { name: "Bad guest 2", kind: "guest", permissions: { settings: { level: "view" } } }), "invalid");
    });

    it("a role from another workspace cannot be assigned", async () => {
      const other = await createTeam("Other");
      await expectCode(setMemberRole(team.owner, team.workspaceId, { userId: team.norole.userId, roleId: other.roles.fullAccess }), "invalid");
    });
  });

  describe("a fresh login and a web session are required (simulated tokens)", () => {
    const assign = `update public.memberships set role_id = $1 where workspace_id = $2 and user_id = $3 returning user_id`;

    it("control: the owner with a fresh web token can assign a role", async () => {
      const result = await sqlAsClaims({ sub: team.owner.userId, amr: freshAmr() }, assign, [team.roles.sales, team.workspaceId, team.norole.userId]);
      expect(result.error).toBeUndefined();
      expect(result.rows).toHaveLength(1);
    });

    it("the owner with a login older than 10 minutes cannot", async () => {
      const stale = [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - 11 * 60 }];
      const result = await sqlAsClaims({ sub: team.owner.userId, amr: stale }, assign, [team.roles.sales, team.workspaceId, team.norole.userId]);
      expect(result.rows).toHaveLength(0);
      const access = await sqlAsClaims({ sub: team.owner.userId, amr: stale }, `select public.my_access($1) as a`, [team.workspaceId]);
      expect((access.rows[0].a as { recent_auth: boolean }).recent_auth).toBe(false);
    });

    it("a token with no amr claim fails closed", async () => {
      const result = await sqlAsClaims({ sub: team.owner.userId }, assign, [team.roles.sales, team.workspaceId, team.norole.userId]);
      expect(result.rows).toHaveLength(0);
    });

    it("the owner's token issued to an OAuth client (an AI connection) cannot manage roles at all", async () => {
      const claims = { sub: team.owner.userId, amr: freshAmr(), client_id: "some-mcp-client" };
      expect((await sqlAsClaims(claims, assign, [team.roles.sales, team.workspaceId, team.norole.userId])).rows).toHaveLength(0);
      expect((await sqlAsClaims(claims, `insert into public.roles (workspace_id, name) values ($1, 'Via MCP')`, [team.workspaceId])).error).toBeDefined();
      expect((await sqlAsClaims(claims, `select public.transfer_ownership($1, $2)`, [team.workspaceId, team.full.userId])).error).toBeDefined();
      expect((await sqlAsClaims(claims, `delete from public.workspaces where id = $1 returning id`, [team.workspaceId])).rows).toHaveLength(0);
      expect((await sqlAsClaims(claims, `select public.create_workspace('Via MCP')`)).error).toBeDefined();
      expect((await sqlAsClaims(claims, `select count(*)::int as c from public.audit_log where workspace_id = $1`, [team.workspaceId])).rows[0].c).toBe(0);
    });

    it("a real freshly signed-in session counts as recently authenticated", async () => {
      // Guards our assumption about the shape of Supabase's "amr" JWT claim.
      const access = await getAccess(team.owner, team.workspaceId);
      expect(access.recentAuth).toBe(true);
      expect(access.oauthClient).toBe(false);
    });

    it("refreshing the session does not renew the sign-in time", async () => {
      // Otherwise a session kept alive by silent refreshes would always count as fresh.
      const user = await createUser("refresher");
      const amrOf = (token: string) =>
        JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).amr as { timestamp: number }[];
      const before = (await user.db.auth.getSession()).data.session!;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const { data, error } = await user.db.auth.refreshSession();
      expect(error).toBeNull();
      expect(data.session!.access_token).not.toBe(before.access_token);
      expect(amrOf(data.session!.access_token)).toEqual(amrOf(before.access_token));
    });
  });

  describe("changes apply on the very next call", () => {
    it("revoking a role cuts access immediately, with the same session", async () => {
      await expect(listTasks(team.sales, team.workspaceId)).resolves.toBeDefined();
      await setMemberRole(team.owner, team.workspaceId, { userId: team.sales.userId, roleId: null });
      await expectDenied(listTasks(team.sales, team.workspaceId));
      const raw = await team.sales.db.from("tasks").select("id").eq("workspace_id", team.workspaceId);
      expect(raw.data).toEqual([]);
      await setMemberRole(team.owner, team.workspaceId, { userId: team.sales.userId, roleId: team.roles.sales });
      await expect(listTasks(team.sales, team.workspaceId)).resolves.toBeDefined();
    });

    it("editing a role's permissions applies immediately", async () => {
      await updateRole(team.owner, team.workspaceId, team.roles.sales, { name: "Sales", kind: "custom", permissions: { tasks: { level: "view" }, docs: { level: "view" } } });
      await expectDenied(createTask(team.sales, team.workspaceId, { title: "no longer allowed" }));
      await updateRole(team.owner, team.workspaceId, team.roles.sales, { name: "Sales", kind: "custom", permissions: { tasks: { level: "edit" }, docs: { level: "view" } } });
      await expect(createTask(team.sales, team.workspaceId, { title: "allowed again" })).resolves.toBeDefined();
    });

    it("deleting a role drops its members to no access", async () => {
      const roleId = await createRole(team.owner, team.workspaceId, { name: "Temp", kind: "custom", permissions: { tasks: { level: "view" } } });
      await setMemberRole(team.owner, team.workspaceId, { userId: team.norole.userId, roleId });
      await expect(listTasks(team.norole, team.workspaceId)).resolves.toBeDefined();
      await deleteRole(team.owner, team.workspaceId, roleId);
      await expectDenied(listTasks(team.norole, team.workspaceId));
    });

    it("a guest's access ends at the expiry time", async () => {
      await expectCode(
        setMemberRole(team.owner, team.workspaceId, { userId: team.guest.userId, roleId: team.roles.guest, expiresAt: new Date(Date.now() - 1000).toISOString() }),
        "invalid",
      );
      await setMemberRole(team.owner, team.workspaceId, { userId: team.guest.userId, roleId: team.roles.guest, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
      expect((await getAccess(team.guest, team.workspaceId)).levels.docs).toBe("view");
      // Move the expiry into the past directly (the service refuses past dates).
      const sql = await pgClient();
      await sql.query("update public.memberships set expires_at = now() - interval '1 second' where workspace_id = $1 and user_id = $2", [team.workspaceId, team.guest.userId]);
      await sql.end();
      const access = await getAccess(team.guest, team.workspaceId);
      expect(access.member).toBe(false);
      expect(Object.values(access.levels).every((l) => l === "none")).toBe(true);
      const raw = await team.guest.db.from("docs").select("id").eq("workspace_id", team.workspaceId);
      expect(raw.data).toEqual([]);
    });
  });

  describe("ownership transfer", () => {
    it("moves every owner power to the new owner and leaves the old owner with nothing", async () => {
      const t = await createTeam("Transfer");
      const { workspace } = await getWorkspace(t.owner, t.workspaceId);
      await expectCode(transferOwnership(t.owner, t.workspaceId, { newOwnerId: t.full.userId, confirmName: "wrong name" }), "invalid");
      const stranger = await createUser("stranger");
      await expectCode(transferOwnership(t.owner, t.workspaceId, { newOwnerId: stranger.userId, confirmName: workspace.name }), "invalid");

      await transferOwnership(t.owner, t.workspaceId, { newOwnerId: t.full.userId, confirmName: workspace.name });

      const after = await getWorkspace(t.full, t.workspaceId);
      expect(after.workspace.owner_id).toBe(t.full.userId);
      expect(after.access.isOwner).toBe(true);
      // Old owner: still a member, but no role and no powers.
      const old = await getAccess(t.owner, t.workspaceId);
      expect(old.isOwner).toBe(false);
      expect(Object.values(old.levels).every((l) => l === "none")).toBe(true);
      await expectDenied(setMemberRole(t.owner, t.workspaceId, { userId: t.owner.userId, roleId: t.roles.fullAccess }));
      await expectDenied(createRole(t.owner, t.workspaceId, { name: "Back door", kind: "custom", permissions: {} }));
      // New owner can now manage roles, and the transfer is in the audit log.
      await setMemberRole(t.full, t.workspaceId, { userId: t.owner.userId, roleId: t.roles.sales });
      const { data: log } = await t.full.db.from("audit_log").select("event, summary").eq("workspace_id", t.workspaceId).eq("event", "ownership.transferred");
      expect(log).toHaveLength(1);
      expect(log![0].summary).toMatchObject({ from: t.owner.userId, to: t.full.userId });
    });
  });
});
