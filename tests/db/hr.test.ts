import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAudit } from "@/server/modules/audit/service";
import {
  createEmployee,
  decideLeave,
  deleteEmployee,
  deleteLeave,
  listEmployees,
  listLeave,
  requestLeave,
  setPay,
  updateEmployee,
} from "@/server/modules/hr/service";
import { setMemberRole } from "@/server/modules/members/service";
import { createRole } from "@/server/modules/roles/service";
import { type Team, type TestUser, cleanup, createTeam, expectCode, expectDenied } from "../helpers";
import { dbTestsEnabled } from "../setup";

// Phase 3: HR. In this team:
//   viewer  (team.guest)  HR view
//   clerk   (team.sales)  HR edit, WITHOUT private details
//   payroll (team.writer) HR edit, WITH private details
//   full    (team.full)   built-in Full Access
//   norole  (team.norole) nothing

describe.skipIf(!dbTestsEnabled)("HR", () => {
  let team: Team;
  let other: Team;
  let ws: string;
  let viewer: TestUser;
  let clerk: TestUser;
  let payroll: TestUser;
  let ada: string;
  let ben: string;

  beforeAll(async () => {
    [team, other] = await Promise.all([createTeam("HR"), createTeam("HROther")]);
    ws = team.workspaceId;
    const { owner } = team;
    viewer = team.guest;
    clerk = team.sales;
    payroll = team.writer;
    const role = async (name: string, level: "view" | "edit", sensitive: boolean) =>
      createRole(owner, ws, { name, kind: "custom", permissions: { hr: { level, sensitive } } });
    await setMemberRole(owner, ws, { userId: viewer.userId, roleId: await role("HR viewer", "view", false) });
    await setMemberRole(owner, ws, { userId: clerk.userId, roleId: await role("HR clerk", "edit", false) });
    await setMemberRole(owner, ws, { userId: payroll.userId, roleId: await role("Payroll", "edit", true) });
    ada = await createEmployee(owner, ws, { fullName: "Ada Baker", jobTitle: "Head baker", startDate: "2025-03-01" });
    ben = await createEmployee(owner, ws, { fullName: "Ben Counter" });
    await setPay(owner, ws, ada, { amount: 52000, period: "year" });
  });
  afterAll(cleanup);

  describe("people follow the role", () => {
    it("nobody without HR access can read or write", async () => {
      for (const outsider of [team.norole, other.owner]) {
        await expectDenied(listEmployees(outsider, ws));
        await expectDenied(createEmployee(outsider, ws, { fullName: "Nope" }));
        await expectDenied(listLeave(outsider, ws));
        expect((await outsider.db.from("employees").select("id").eq("workspace_id", ws)).data).toEqual([]);
        expect((await outsider.db.from("leave_requests").select("id").eq("workspace_id", ws)).data).toEqual([]);
        expect((await outsider.db.from("employee_compensation").select("employee_id").eq("workspace_id", ws)).data).toEqual([]);
      }
    });

    it("view reads, edit adds and changes, only manage deletes", async () => {
      expect((await listEmployees(viewer, ws)).employees.map((e) => e.full_name)).toEqual(["Ada Baker", "Ben Counter"]);
      await expectDenied(createEmployee(viewer, ws, { fullName: "Nope" }));
      await expectDenied(updateEmployee(viewer, ws, ben, { jobTitle: "Nope" }));

      const cy = await createEmployee(clerk, ws, { fullName: "Cy Driver", email: "cy@example.com" });
      await updateEmployee(clerk, ws, cy, { jobTitle: "Driver" });
      const found = (await listEmployees(clerk, ws)).employees.find((e) => e.id === cy)!;
      expect(found).toMatchObject({ job_title: "Driver", email: "cy@example.com", status: "active" });
      await expectCode(createEmployee(clerk, ws, { fullName: "  " }), "invalid");
      await expectCode(createEmployee(clerk, ws, { fullName: "X", email: "not an email" }), "invalid");

      await expectDenied(deleteEmployee(clerk, ws, cy));
      await expectDenied(deleteEmployee(payroll, ws, cy));
      await deleteEmployee(team.owner, ws, cy);
      await expectCode(deleteEmployee(team.owner, ws, cy), "not_found");
    });

    it("a person cannot be reached or linked across workspaces", async () => {
      await expectCode(updateEmployee(other.owner, other.workspaceId, ada, { jobTitle: "Stolen" }), "not_found");
      await expectCode(setPay(other.owner, other.workspaceId, ada, { amount: 1 }), "not_found");
      const foreign = await createEmployee(other.owner, other.workspaceId, { fullName: "Other Person" });
      const leave = requestLeave(team.owner, ws, { employeeId: foreign, startDate: "2027-01-04", endDate: "2027-01-05" });
      await expect(leave).rejects.toThrow();
      // A person can only be tied to a member of the same workspace.
      await expect(updateEmployee(team.owner, ws, ben, { userId: other.owner.userId })).rejects.toThrow();
      await updateEmployee(team.owner, ws, ben, { userId: clerk.userId });
    });
  });

  describe("pay needs the role's private details as well", () => {
    it("the owner, Full Access and a role with private details see pay", async () => {
      for (const who of [team.owner, team.full, payroll]) {
        const { employees, canSeePay } = await listEmployees(who, ws);
        expect(canSeePay).toBe(true);
        expect(employees.find((e) => e.id === ada)!.pay).toEqual({ amount: 52000, period: "year" });
        expect(employees.find((e) => e.id === ben)!.pay).toBeNull();
      }
    });

    it("HR access without private details shows no pay, through the service or the raw API", async () => {
      for (const who of [viewer, clerk]) {
        const { employees, canSeePay } = await listEmployees(who, ws);
        expect(canSeePay).toBe(false);
        expect(employees.every((e) => e.pay === null)).toBe(true);
        expect((await who.db.from("employee_compensation").select("*").eq("workspace_id", ws)).data).toEqual([]);
      }
    });

    it("only edit with private details can set pay", async () => {
      await expectDenied(setPay(viewer, ws, ben, { amount: 10 }));
      await expectDenied(setPay(clerk, ws, ben, { amount: 10 }));
      // Straight at the database, skipping the app: the clerk can neither add, change nor remove pay.
      const insert = await clerk.db.from("employee_compensation").insert({ employee_id: ben, workspace_id: ws, pay_amount: 10 });
      expect(insert.error).not.toBeNull();
      const update = await clerk.db.from("employee_compensation").update({ pay_amount: 1 }).eq("employee_id", ada).select();
      expect(update.data ?? []).toEqual([]);
      const remove = await clerk.db.from("employee_compensation").delete().eq("employee_id", ada).select();
      expect(remove.data ?? []).toEqual([]);

      await setPay(payroll, ws, ben, { amount: 18.5, period: "hour" });
      await setPay(payroll, ws, ben, { amount: 19.25, period: "hour" });
      const pay = async () => (await listEmployees(team.owner, ws)).employees.find((e) => e.id === ben)!.pay;
      expect(await pay()).toEqual({ amount: 19.25, period: "hour" });
      expect((await listEmployees(team.owner, ws)).employees.find((e) => e.id === ada)!.pay).toEqual({ amount: 52000, period: "year" });
      await expectCode(setPay(payroll, ws, ben, { amount: -1 }), "invalid");
      await setPay(payroll, ws, ben, null);
      expect(await pay()).toBeNull();
    });

    it("pay changes are in the activity log, without the amount", async () => {
      const log = await listAudit(team.owner, ws, { event: "hr." });
      expect(log.map((e) => e.event)).toEqual(expect.arrayContaining(["hr.pay_changed", "hr.pay_removed"]));
      expect(log.filter((e) => e.target === ben).map((e) => e.actor_id)).toContain(payroll.userId);
      expect(JSON.stringify(log)).not.toMatch(/52000|19\.25|18\.5/);
    });

    it("taking private details away hides pay on the very next call", async () => {
      expect((await listEmployees(payroll, ws)).canSeePay).toBe(true);
      const plain = await createRole(team.owner, ws, { name: "Payroll no more", kind: "custom", permissions: { hr: { level: "edit" } } });
      await setMemberRole(team.owner, ws, { userId: payroll.userId, roleId: plain });
      const after = await listEmployees(payroll, ws);
      expect(after.canSeePay).toBe(false);
      expect(after.employees.every((e) => e.pay === null)).toBe(true);
      await expectDenied(setPay(payroll, ws, ada, { amount: 1 }));
    });
  });

  describe("time off", () => {
    let request: string;

    it("edit can ask; the request always starts as pending", async () => {
      await expectDenied(requestLeave(viewer, ws, { employeeId: ada, startDate: "2027-02-01", endDate: "2027-02-05" }));
      request = await requestLeave(clerk, ws, { employeeId: ada, kind: "holiday", startDate: "2027-02-01", endDate: "2027-02-05", note: "Skiing" });
      await expectCode(requestLeave(clerk, ws, { employeeId: ada, startDate: "2027-02-05", endDate: "2027-02-01" }), "invalid");

      // A raw insert cannot arrive already approved.
      const sneaky = await clerk.db
        .from("leave_requests")
        .insert({ workspace_id: ws, employee_id: ada, start_date: "2027-03-01", end_date: "2027-03-02", status: "approved", decided_by: clerk.userId, created_by: clerk.userId })
        .select("status, decided_by")
        .single();
      expect(sneaky.data).toEqual({ status: "pending", decided_by: null });

      const listed = await listLeave(viewer, ws);
      expect(listed.find((r) => r.id === request)).toMatchObject({ employee_name: "Ada Baker", status: "pending", note: "Skiing", decided_at: null });
      expect((await listLeave(viewer, ws, { status: "approved" })).length).toBe(0);
    });

    it("only manage can decide, and the decision is stamped", async () => {
      await expectDenied(decideLeave(clerk, ws, request, { status: "approved" }));
      const raw = await clerk.db.from("leave_requests").update({ status: "approved" }).eq("id", request).select();
      expect(raw.data ?? []).toEqual([]);

      await decideLeave(team.full, ws, request, { status: "approved" });
      const row = await team.owner.db.from("leave_requests").select("status, decided_by, decided_at").eq("id", request).single();
      expect(row.data!.status).toBe("approved");
      expect(row.data!.decided_by).toBe(team.full.userId);
      expect(row.data!.decided_at).not.toBeNull();
      expect((await listLeave(viewer, ws, { status: "approved" })).map((r) => r.id)).toEqual([request]);
    });

    it("a request cannot be rewritten after the fact, even by the owner", async () => {
      const edit = await team.owner.db.from("leave_requests").update({ end_date: "2027-02-20" }).eq("id", request).select();
      expect(edit.error).not.toBeNull();
      const forge = await team.owner.db.from("leave_requests").update({ decided_by: clerk.userId }).eq("id", request).select("decided_by").single();
      expect(forge.data!.decided_by).toBe(team.full.userId);
    });

    it("only manage deletes; deleting a person removes their requests", async () => {
      await expectDenied(deleteLeave(clerk, ws, request));
      await deleteLeave(team.owner, ws, request);
      const temp = await createEmployee(team.owner, ws, { fullName: "Temp" });
      await requestLeave(team.owner, ws, { employeeId: temp, startDate: "2027-05-01", endDate: "2027-05-01" });
      await setPay(team.owner, ws, temp, { amount: 100 });
      await deleteEmployee(team.owner, ws, temp);
      expect((await listLeave(team.owner, ws)).some((r) => r.employee_id === temp)).toBe(false);
      const pay = await team.owner.db.from("employee_compensation").select("employee_id").eq("employee_id", temp);
      expect(pay.data).toEqual([]);
    });
  });
});
