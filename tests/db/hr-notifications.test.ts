import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmployee, decideLeave, requestLeave } from "@/server/modules/hr/service";
import { setMemberRole } from "@/server/modules/members/service";
import { type Notification, listNotifications } from "@/server/modules/notifications/service";
import { createRole } from "@/server/modules/roles/service";
import { type Team, type TestUser, cleanup, createTeam } from "../helpers";
import { dbTestsEnabled } from "../setup";

// HR notifications. In this team:
//   owner, full            can decide time off (HR manage)
//   clerk  (team.sales)    HR edit: files requests
//   viewer (team.guest)    HR view
//   ada    (team.writer)   no HR access at all, but is the person "Ada Baker"
//   norole (team.norole)   nothing

describe.skipIf(!dbTestsEnabled)("HR notifications", () => {
  let team: Team;
  let other: Team;
  let ws: string;
  let clerk: TestUser;
  let viewer: TestUser;
  let adaUser: TestUser;
  let ada: string;
  let ben: string;
  let request: string;

  const hrAlerts = async (who: TestUser): Promise<Notification[]> =>
    (await listNotifications(who, ws)).filter((n) => n.kind.startsWith("hr.") || n.kind.startsWith("me."));

  beforeAll(async () => {
    [team, other] = await Promise.all([createTeam("HRNotify"), createTeam("HRNotifyOther")]);
    ws = team.workspaceId;
    const { owner } = team;
    clerk = team.sales;
    viewer = team.guest;
    adaUser = team.writer;
    const role = async (name: string, level: "view" | "edit") =>
      createRole(owner, ws, { name, kind: "custom", permissions: { hr: { level } } });
    await setMemberRole(owner, ws, { userId: clerk.userId, roleId: await role("HR clerk", "edit") });
    await setMemberRole(owner, ws, { userId: viewer.userId, roleId: await role("HR viewer", "view") });
    ada = await createEmployee(owner, ws, { fullName: "Ada Baker", userId: adaUser.userId });
    ben = await createEmployee(owner, ws, { fullName: "Ben Counter", userId: clerk.userId });
  });
  afterAll(cleanup);

  it("a request alerts everyone who can decide, and nobody else", async () => {
    request = await requestLeave(clerk, ws, { employeeId: ada, kind: "sick", startDate: "2027-02-01", endDate: "2027-02-05", note: "Flu" });

    for (const decider of [team.owner, team.full]) {
      const alerts = await hrAlerts(decider);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        kind: "hr.leave_requested",
        title: "Time off requested for Ada Baker (1 Feb 2027 to 5 Feb 2027)",
        link: `/w/${ws}/hr?view=leave`,
        read_at: null,
      });
    }
    // Not the asker, not someone who can only look, not the person, not outsiders.
    for (const who of [clerk, viewer, adaUser, team.norole]) expect(await hrAlerts(who)).toEqual([]);
    const outside = await other.owner.db.from("notifications").select("id").eq("workspace_id", ws);
    expect(outside.data).toEqual([]);
  });

  it("an alert never says what kind of leave it is, or repeats the note", async () => {
    const all = await team.owner.db.from("notifications").select("title").eq("workspace_id", ws);
    expect(JSON.stringify(all.data)).not.toMatch(/sick|flu/i);
  });

  it("someone who can decide is not alerted about their own request", async () => {
    await requestLeave(team.owner, ws, { employeeId: ada, startDate: "2027-05-01", endDate: "2027-05-01" });
    expect((await hrAlerts(team.owner)).filter((n) => n.kind === "hr.leave_requested")).toHaveLength(1);
    const forFull = (await hrAlerts(team.full)).map((n) => n.title);
    expect(forFull).toContain("Time off requested for Ada Baker (1 May 2027)");
  });

  it("a decision alerts the person and whoever asked, not the one who decided", async () => {
    await decideLeave(team.full, ws, request, { status: "approved" });

    // The person has no HR access: they are told about their own time off, with no link into HR.
    expect(await hrAlerts(adaUser)).toEqual([
      expect.objectContaining({ kind: "me.leave_decided", title: "Your time off (1 Feb 2027 to 5 Feb 2027) was approved", link: null }),
    ]);
    expect(await hrAlerts(clerk)).toEqual([
      expect.objectContaining({
        kind: "hr.leave_decided",
        title: "Time off for Ada Baker (1 Feb 2027 to 5 Feb 2027) was approved",
        link: `/w/${ws}/hr?view=leave`,
      }),
    ]);
    for (const who of [team.owner, team.full, viewer]) {
      expect((await hrAlerts(who)).some((n) => n.kind.endsWith("leave_decided"))).toBe(false);
    }
  });

  it("someone who asked for their own time off is told once, with a link they can open", async () => {
    const own = await requestLeave(clerk, ws, { employeeId: ben, startDate: "2027-03-10", endDate: "2027-03-11" });
    await decideLeave(team.owner, ws, own, { status: "declined" });
    const mine = (await hrAlerts(clerk)).filter((n) => n.title.includes("10 Mar 2027"));
    expect(mine).toEqual([
      expect.objectContaining({ kind: "me.leave_decided", title: "Your time off (10 Mar 2027 to 11 Mar 2027) was declined", link: `/w/${ws}/hr?view=leave` }),
    ]);
  });

  it("alerts about other people disappear when HR access is removed; your own stay", async () => {
    expect((await hrAlerts(clerk)).map((n) => n.kind).sort()).toEqual(["hr.leave_decided", "me.leave_decided"]);
    await setMemberRole(team.owner, ws, { userId: clerk.userId, roleId: team.roles.sales });
    expect((await hrAlerts(clerk)).map((n) => n.kind)).toEqual(["me.leave_decided"]);
    const raw = await clerk.db.from("notifications").select("title").eq("workspace_id", ws).like("kind", "hr.%");
    expect(raw.data).toEqual([]);
  });

  it("a request filed by someone who has since lost HR access alerts only the person", async () => {
    // The clerk no longer has HR access; the earlier request for Ada (1 May) is still pending.
    const pending = await team.owner.db
      .from("leave_requests")
      .select("id")
      .eq("workspace_id", ws)
      .eq("status", "pending")
      .eq("start_date", "2027-05-01")
      .single();
    await decideLeave(team.full, ws, pending.data!.id, { status: "declined" });
    expect((await hrAlerts(adaUser)).map((n) => n.title)).toContain("Your time off (1 May 2027) was declined");
    // The owner filed it and can still see HR, so they are told.
    expect((await hrAlerts(team.owner)).map((n) => n.title)).toContain("Time off for Ada Baker (1 May 2027) was declined");
  });
});
