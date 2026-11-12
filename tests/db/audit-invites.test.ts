import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAccess } from "@/server/authz/authorize";
import { listAudit, recordLogin } from "@/server/modules/audit/service";
import { acceptInvite, createInvite, listInvites, previewInvite, revokeInvite } from "@/server/modules/members/service";
import { listTasks } from "@/server/modules/tasks/service";
import { type Team, cleanup, createTeam, createUser, expectCode, expectDenied, pgClient } from "../helpers";
import { dbTestsEnabled } from "../setup";

describe.skipIf(!dbTestsEnabled)("audit log", () => {
  let team: Team;
  beforeAll(async () => {
    team = await createTeam();
  });
  afterAll(cleanup);

  it("records workspace, invite, member and role history automatically", async () => {
    const events = (await listAudit(team.owner, team.workspaceId, { limit: 200 })).map((e) => e.event);
    for (const expected of ["workspace.created", "invite.created", "invite.accepted", "member.joined", "role.created", "role.permission_set", "role.assigned"]) {
      expect(events, expected).toContain(expected);
    }
  });

  it("records who assigned which role to whom", async () => {
    const entries = await listAudit(team.owner, team.workspaceId, { event: "role.assigned", limit: 200 });
    const forSales = entries.find((e) => e.target === team.sales.userId);
    expect(forSales).toBeDefined();
    expect(forSales!.actor_id).toBe(team.owner.userId);
    expect(forSales!.summary).toMatchObject({ from_role: null, to_role: team.roles.sales });
  });

  it("records permission denials with the actor, page and action", async () => {
    await expectDenied(listTasks(team.guest, team.workspaceId));
    const denials = await listAudit(team.owner, team.workspaceId, { event: "authz.denied" });
    const mine = denials.find((e) => e.actor_id === team.guest.userId && e.target === "tasks:view");
    expect(mine).toBeDefined();
    expect(mine!.outcome).toBe("denied");
  });

  it("records sign-ins", async () => {
    await recordLogin(team.sales);
    const logins = await listAudit(team.owner, team.workspaceId, { event: "auth.login" });
    expect(logins.some((e) => e.actor_id === team.sales.userId)).toBe(true);
  });

  it("is readable by the owner only", async () => {
    for (const user of [team.full, team.sales, team.guest, team.norole]) {
      await expectDenied(listAudit(user, team.workspaceId));
      const raw = await user.db.from("audit_log").select("id").eq("workspace_id", team.workspaceId);
      expect(raw.data).toEqual([]);
    }
  });

  it("cannot be edited, deleted or forged, even by the owner", async () => {
    const db = team.owner.db;
    const update = await db.from("audit_log").update({ event: "nothing.happened" }).eq("workspace_id", team.workspaceId).select();
    expect(update.error !== null || (update.data ?? []).length === 0).toBe(true);
    const del = await db.from("audit_log").delete().eq("workspace_id", team.workspaceId).select();
    expect(del.error !== null || (del.data ?? []).length === 0).toBe(true);
    const insert = await db.from("audit_log").insert({ workspace_id: team.workspaceId, channel: "web", event: "role.assigned" });
    expect(insert.error).not.toBeNull();
    // The app-level writer only accepts a fixed list of events...
    const forged = await team.sales.db.rpc("log_event", { p_workspace: team.workspaceId, p_event: "role.assigned" });
    expect(forged.error).not.toBeNull();
    // ...and the internal writer is not callable at all.
    const internal = await team.sales.db.rpc("audit", { p_workspace: team.workspaceId, p_event: "role.assigned" });
    expect(internal.error).not.toBeNull();
    const still = await listAudit(team.owner, team.workspaceId, { event: "workspace.created" });
    expect(still).toHaveLength(1);
  });
});

describe.skipIf(!dbTestsEnabled)("invites", () => {
  let team: Team;
  beforeAll(async () => {
    team = await createTeam();
  });
  afterAll(cleanup);

  it("accepting an invite gives membership with no role and no access", async () => {
    const newcomer = await createUser("newcomer");
    const { token } = await createInvite(team.owner, team.workspaceId, { email: newcomer.email });
    expect(await previewInvite(newcomer, token)).toMatchObject({ email: newcomer.email, usable: true });
    expect(await acceptInvite(newcomer, token)).toBe(team.workspaceId);
    const access = await getAccess(newcomer, team.workspaceId);
    expect(access.member).toBe(true);
    expect(access.roleId).toBeNull();
    expect(Object.values(access.levels).every((l) => l === "none")).toBe(true);
    await expectDenied(listTasks(newcomer, team.workspaceId));
  });

  it("an invite works only for the invited email address", async () => {
    const invited = await createUser("invited");
    const thief = await createUser("thief");
    const { token } = await createInvite(team.owner, team.workspaceId, { email: invited.email });
    await expectDenied(acceptInvite(thief, token));
    expect((await getAccess(thief, team.workspaceId)).member).toBe(false);
  });

  it("an invite cannot be used twice, after being cancelled, or after it expires", async () => {
    const one = await createUser("one");
    const used = await createInvite(team.owner, team.workspaceId, { email: one.email });
    await acceptInvite(one, used.token);
    await expectCode(acceptInvite(one, used.token), "invalid");

    const two = await createUser("two");
    const cancelled = await createInvite(team.owner, team.workspaceId, { email: two.email });
    const row = (await listInvites(team.owner, team.workspaceId)).find((i) => i.email === two.email)!;
    await revokeInvite(team.owner, team.workspaceId, row.id);
    await expectCode(acceptInvite(two, cancelled.token), "invalid");

    const three = await createUser("three");
    const expired = await createInvite(team.owner, team.workspaceId, { email: three.email });
    const sql = await pgClient();
    await sql.query("update public.invites set expires_at = now() - interval '1 minute' where email = $1", [three.email]);
    await sql.end();
    await expectCode(acceptInvite(three, expired.token), "invalid");
    expect((await previewInvite(three, expired.token))?.usable).toBe(false);
  });

  it("a guessed token reveals nothing", async () => {
    const stranger = await createUser("stranger");
    expect(await previewInvite(stranger, "not-a-real-token")).toBeNull();
    await expectCode(acceptInvite(stranger, "not-a-real-token"), "invalid");
  });

  it("only the token hash is stored", async () => {
    const someone = await createUser("someone");
    const { token } = await createInvite(team.owner, team.workspaceId, { email: someone.email });
    const { data } = await team.owner.db.from("invites").select("token_hash").eq("email", someone.email).single();
    expect(data!.token_hash).not.toContain(token);
    expect(data!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a user cannot change the email on their profile to match someone else's invite", async () => {
    const victim = await createUser("victim");
    const attacker = await createUser("attacker");
    const { token } = await createInvite(team.owner, team.workspaceId, { email: victim.email });
    const spoof = await attacker.db.from("profiles").update({ email: victim.email }).eq("id", attacker.userId).select();
    expect(spoof.error).not.toBeNull();
    await expectDenied(acceptInvite(attacker, token));
    // Renaming yourself is still allowed.
    const rename = await attacker.db.from("profiles").update({ display_name: "New name" }).eq("id", attacker.userId).select();
    expect(rename.error).toBeNull();
    expect(rename.data).toHaveLength(1);
  });

  it("Full Access can invite; other roles cannot", async () => {
    await expect(createInvite(team.full, team.workspaceId, { email: "a@test.bizzy.local" })).resolves.toBeDefined();
    await expectDenied(createInvite(team.sales, team.workspaceId, { email: "b@test.bizzy.local" }));
    await expectDenied(listInvites(team.sales, team.workspaceId));
  });
});
