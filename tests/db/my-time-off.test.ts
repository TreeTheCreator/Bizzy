import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelMyLeave,
  createEmployee,
  decideLeave,
  getMyPerson,
  getMyTimeOff,
  listLeave,
  requestLeave,
  requestMyLeave,
  updateEmployee,
} from "@/server/modules/hr/service";
import { setMemberRole } from "@/server/modules/members/service";
import { listNotifications } from "@/server/modules/notifications/service";
import { type Team, type TestUser, cleanup, createTeam, expectCode, expectDenied, sqlAsClaims } from "../helpers";
import { dbTestsEnabled } from "../setup";

// Self-service time off. In this team:
//   sam    (team.sales)   Tasks and Docs only, no HR; linked to the person "Sam Server"
//   wes    (team.writer)  Docs only, no HR; NOT linked to anyone
//   full   (team.full)    Full Access (can decide time off); linked to "Fran Full"
//   owner                 linked to "Olive Owner"
//   norole (team.norole)  no role; linked to "Nora Norole"

describe.skipIf(!dbTestsEnabled)("My time off", () => {
  let team: Team;
  let other: Team;
  let ws: string;
  let sam: TestUser;
  let wes: TestUser;
  let samPerson: string;
  let franPerson: string;
  let olivePerson: string;
  let colleague: string;
  let colleagueRequest: string;
  let mine: string;

  beforeAll(async () => {
    [team, other] = await Promise.all([createTeam("MyLeave"), createTeam("MyLeaveOther")]);
    ws = team.workspaceId;
    const { owner } = team;
    sam = team.sales;
    wes = team.writer;
    samPerson = await createEmployee(owner, ws, { fullName: "Sam Server", userId: sam.userId, notes: "Private note about Sam" });
    franPerson = await createEmployee(owner, ws, { fullName: "Fran Full", userId: team.full.userId });
    olivePerson = await createEmployee(owner, ws, { fullName: "Olive Owner", userId: owner.userId });
    await createEmployee(owner, ws, { fullName: "Nora Norole", userId: team.norole.userId });
    colleague = await createEmployee(owner, ws, { fullName: "Cole Colleague" });
    colleagueRequest = await requestLeave(owner, ws, { employeeId: colleague, kind: "sick", startDate: "2027-01-11", endDate: "2027-01-12" });
  });
  afterAll(cleanup);

  it("a linked member with no HR access sees their own record and nothing else", async () => {
    expect(await getMyPerson(sam, ws)).toEqual({ id: samPerson, full_name: "Sam Server" });
    expect(await getMyTimeOff(sam, ws)).toEqual({ person: { id: samPerson, full_name: "Sam Server" }, requests: [] });
    // Still no HR: no people list, no other requests, and not even their own full record.
    await expectDenied(listLeave(sam, ws));
    expect((await sam.db.from("employees").select("id, notes").eq("workspace_id", ws)).data).toEqual([]);
    expect((await sam.db.from("leave_requests").select("id").eq("workspace_id", ws)).data).toEqual([]);
  });

  it("they can ask for time off for themselves; it starts pending and alerts whoever decides", async () => {
    mine = await requestMyLeave(sam, ws, { kind: "holiday", startDate: "2027-04-05", endDate: "2027-04-09", note: "Family visit" });
    const { requests } = await getMyTimeOff(sam, ws);
    expect(requests).toEqual([
      expect.objectContaining({ id: mine, employee_id: samPerson, employee_name: "Sam Server", status: "pending", note: "Family visit" }),
    ]);
    await expectCode(requestMyLeave(sam, ws, { startDate: "2027-04-09", endDate: "2027-04-05" }), "invalid");
    for (const decider of [team.owner, team.full]) {
      const titles = (await listNotifications(decider, ws)).map((n) => n.title);
      expect(titles).toContain("Time off requested for Sam Server (5 Apr 2027 to 9 Apr 2027)");
    }
  });

  it("they cannot ask for, see or cancel someone else's time off, even straight at the database", async () => {
    const forColleague = await sam.db
      .from("leave_requests")
      .insert({ workspace_id: ws, employee_id: colleague, start_date: "2027-06-01", end_date: "2027-06-01", created_by: sam.userId });
    expect(forColleague.error).not.toBeNull();
    const peek = await sam.db.from("leave_requests").select("id").eq("id", colleagueRequest);
    expect(peek.data).toEqual([]);
    await expectCode(cancelMyLeave(sam, ws, colleagueRequest), "not_found");
    const raw = await sam.db.from("leave_requests").delete().eq("id", colleagueRequest).select("id");
    expect(raw.data ?? []).toEqual([]);
  });

  it("they cannot decide their own request", async () => {
    await expectDenied(decideLeave(sam, ws, mine, { status: "approved" }));
    const raw = await sam.db.from("leave_requests").update({ status: "approved" }).eq("id", mine).select();
    expect(raw.data ?? []).toEqual([]);
  });

  it("someone who can decide time off still cannot decide their own; the owner can", async () => {
    const fran = await requestMyLeave(team.full, ws, { startDate: "2027-07-01", endDate: "2027-07-02" });
    await expectDenied(decideLeave(team.full, ws, fran, { status: "approved" }));
    await decideLeave(team.owner, ws, fran, { status: "approved" });
    expect((await getMyTimeOff(team.full, ws)).requests[0]).toMatchObject({ id: fran, status: "approved" });
    // Full Access still sees the whole HR list, including their own.
    expect((await listLeave(team.full, ws)).some((r) => r.employee_id === franPerson)).toBe(true);

    const olive = await requestMyLeave(team.owner, ws, { startDate: "2027-08-03", endDate: "2027-08-03" });
    await decideLeave(team.full, ws, olive, { status: "declined" });
    await decideLeave(team.owner, ws, olive, { status: "approved" });
    expect((await getMyTimeOff(team.owner, ws)).person!.id).toBe(olivePerson);
  });

  it("the answer alerts them, with a link to My time off", async () => {
    await decideLeave(team.full, ws, mine, { status: "declined" });
    const alert = (await listNotifications(sam, ws)).find((n) => n.kind === "me.leave_decided");
    expect(alert).toMatchObject({ title: "Your time off (5 Apr 2027 to 9 Apr 2027) was declined", link: `/w/${ws}/time-off` });
  });

  it("they can cancel only while it is waiting for an answer", async () => {
    await expectCode(cancelMyLeave(sam, ws, mine), "not_found"); // already declined
    const another = await requestMyLeave(sam, ws, { startDate: "2027-09-01", endDate: "2027-09-01" });
    await cancelMyLeave(sam, ws, another);
    expect((await getMyTimeOff(sam, ws)).requests.map((r) => r.id)).toEqual([mine]);
  });

  it("a member who is not linked has no person and cannot ask", async () => {
    expect(await getMyPerson(wes, ws)).toBeNull();
    expect(await getMyTimeOff(wes, ws)).toEqual({ person: null, requests: [] });
    await expectDenied(requestMyLeave(wes, ws, { startDate: "2027-04-05", endDate: "2027-04-05" }));
  });

  it("no role, another workspace, or an AI app's token: nothing", async () => {
    await expectDenied(getMyTimeOff(team.norole, ws));
    await expectDenied(requestMyLeave(team.norole, ws, { startDate: "2027-04-05", endDate: "2027-04-05" }));
    expect((await team.norole.db.rpc("my_employee", { p_workspace: ws })).data).toEqual([]);
    await expectDenied(getMyTimeOff(other.owner, ws));
    expect((await other.owner.db.rpc("my_employee", { p_workspace: ws })).data).toEqual([]);

    const claims = { sub: sam.userId, client_id: "some-mcp-client" };
    expect((await sqlAsClaims(claims, "select public.my_employee_id($1) as id", [ws])).rows[0].id).toBeNull();
    const insert = await sqlAsClaims(
      claims,
      "insert into public.leave_requests (workspace_id, employee_id, start_date, end_date, created_by) values ($1, $2, '2027-10-01', '2027-10-01', $3)",
      [ws, samPerson, sam.userId],
    );
    expect(insert.error).toBeDefined();
  });

  it("someone who has left, or whose role is taken away, loses access straight away", async () => {
    await updateEmployee(team.owner, ws, samPerson, { status: "left" });
    expect(await getMyPerson(sam, ws)).toBeNull();
    expect((await sam.db.from("leave_requests").select("id").eq("workspace_id", ws)).data).toEqual([]);
    await updateEmployee(team.owner, ws, samPerson, { status: "active" });
    expect(await getMyPerson(sam, ws)).not.toBeNull();

    await setMemberRole(team.owner, ws, { userId: sam.userId, roleId: null });
    await expectDenied(getMyTimeOff(sam, ws));
    expect((await sam.db.from("leave_requests").select("id").eq("workspace_id", ws)).data).toEqual([]);
  });
});
