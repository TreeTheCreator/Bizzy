import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { NotFound, PermissionDenied, unwrap } from "@/server/errors";
import { id, isoDate, parse } from "@/server/validate";

export const EMPLOYEE_STATUSES = ["active", "left"] as const;
export const PAY_PERIODS = ["hour", "month", "year"] as const;
export const LEAVE_KINDS = ["holiday", "sick", "other"] as const;
export const LEAVE_STATUSES = ["pending", "approved", "declined"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export interface Pay {
  amount: number;
  period: (typeof PAY_PERIODS)[number];
}

export interface Employee {
  id: string;
  user_id: string | null;
  full_name: string;
  job_title: string;
  email: string;
  phone: string;
  start_date: string | null;
  status: (typeof EMPLOYEE_STATUSES)[number];
  notes: string;
  created_at: string;
  /** Null when no pay has been entered, or when the caller may not see pay. */
  pay: Pay | null;
}

export interface LeaveRequest {
  id: string;
  employee_id: string;
  employee_name: string;
  kind: (typeof LEAVE_KINDS)[number];
  start_date: string;
  end_date: string;
  note: string;
  status: LeaveStatus;
  created_at: string;
  decided_at: string | null;
}

const EMPLOYEE_COLUMNS = "id, user_id, full_name, job_title, email, phone, start_date, status, notes, created_at";
const LEAVE_COLUMNS = "id, employee_id, kind, start_date, end_date, note, status, created_at, decided_at";

const employeeRules = z.object({
  fullName: z.string().trim().min(1, "is required").max(200),
  jobTitle: z.string().trim().max(200),
  email: z.union([z.literal(""), z.email("must be an email address")]),
  phone: z.string().trim().max(60),
  startDate: isoDate.nullable(),
  status: z.enum(EMPLOYEE_STATUSES),
  notes: z.string().max(10000),
  userId: id.nullable(),
});
const employeeFields = employeeRules.extend({
  jobTitle: employeeRules.shape.jobTitle.default(""),
  email: employeeRules.shape.email.default(""),
  phone: employeeRules.shape.phone.default(""),
  startDate: employeeRules.shape.startDate.default(null),
  status: employeeRules.shape.status.default("active"),
  notes: employeeRules.shape.notes.default(""),
  userId: employeeRules.shape.userId.default(null),
});
export type EmployeeInput = z.input<typeof employeeFields>;

const payFields = z.object({
  amount: z.coerce.number().min(0, "can't be negative").max(999_999_999_999).multipleOf(0.01, "at most 2 decimal places"),
  period: z.enum(PAY_PERIODS).default("year"),
});
export type PayInput = z.input<typeof payFields>;

const leaveFields = z
  .object({
    employeeId: id,
    kind: z.enum(LEAVE_KINDS).default("holiday"),
    startDate: isoDate,
    endDate: isoDate,
    note: z.string().trim().max(2000).default(""),
  })
  .refine((v) => v.endDate >= v.startDate, { message: "the last day can't be before the first day", path: ["endDate"] });
export type LeaveInput = z.input<typeof leaveFields>;

function employeeRow(data: Partial<z.infer<typeof employeeRules>>) {
  const row: Record<string, unknown> = {};
  if (data.fullName !== undefined) row.full_name = data.fullName;
  if (data.jobTitle !== undefined) row.job_title = data.jobTitle;
  if (data.email !== undefined) row.email = data.email;
  if (data.phone !== undefined) row.phone = data.phone;
  if (data.startDate !== undefined) row.start_date = data.startDate;
  if (data.status !== undefined) row.status = data.status;
  if (data.notes !== undefined) row.notes = data.notes;
  if (data.userId !== undefined) row.user_id = data.userId;
  return row;
}

// --- People -----------------------------------------------------------------

/**
 * The people in the workspace. `canSeePay` says whether the caller's role
 * includes HR's private details; without it every `pay` is null (the database
 * returns no pay rows at all).
 */
export async function listEmployees(
  ctx: Ctx,
  workspaceId: string,
): Promise<{ employees: Employee[]; canSeePay: boolean }> {
  const access = await authorize(ctx, parse(id, workspaceId), "hr", "view");
  const [people, pay] = await Promise.all([
    ctx.db.from("employees").select(EMPLOYEE_COLUMNS).eq("workspace_id", workspaceId).order("full_name").limit(5000),
    ctx.db.from("employee_compensation").select("employee_id, pay_amount, pay_period").eq("workspace_id", workspaceId).limit(5000),
  ]);
  const payOf = new Map(
    unwrap<{ employee_id: string; pay_amount: number; pay_period: Pay["period"] }[]>(pay).map((p) => [
      p.employee_id,
      { amount: Number(p.pay_amount), period: p.pay_period },
    ]),
  );
  return {
    employees: unwrap<Omit<Employee, "pay">[]>(people).map((e) => ({ ...e, pay: payOf.get(e.id) ?? null })),
    canSeePay: access.sensitive.hr,
  };
}

/** Add a person. Returns their id. */
export async function createEmployee(ctx: Ctx, workspaceId: string, input: EmployeeInput): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "hr", "edit");
  const data = parse(employeeFields, input);
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("employees")
      .insert({ workspace_id: workspaceId, ...employeeRow(data), created_by: ctx.userId })
      .select("id")
      .single(),
  );
  return row.id;
}

export async function updateEmployee(
  ctx: Ctx,
  workspaceId: string,
  employeeId: string,
  input: Partial<EmployeeInput>,
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "hr", "edit");
  const row = employeeRow(parse(employeeRules.partial(), input));
  if (Object.keys(row).length === 0) return;
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("employees").update(row).eq("workspace_id", workspaceId).eq("id", parse(id, employeeId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Person");
}

/** Remove a person, with their pay and time-off history. */
export async function deleteEmployee(ctx: Ctx, workspaceId: string, employeeId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "hr", "manage");
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("employees").delete().eq("workspace_id", workspaceId).eq("id", parse(id, employeeId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Person");
}

/**
 * Set or clear what a person is paid. Needs HR edit AND the role's "private
 * details" for HR; the database enforces both again.
 */
export async function setPay(
  ctx: Ctx,
  workspaceId: string,
  employeeId: string,
  input: PayInput | null,
): Promise<void> {
  const access = await authorize(ctx, parse(id, workspaceId), "hr", "edit");
  if (!access.sensitive.hr) throw new PermissionDenied("Your role does not include pay details.");
  const employee = parse(id, employeeId);
  const exists = unwrap<{ id: string } | null>(
    await ctx.db.from("employees").select("id").eq("workspace_id", workspaceId).eq("id", employee).maybeSingle(),
  );
  if (!exists) throw new NotFound("Person");
  if (input === null) {
    unwrap(await ctx.db.from("employee_compensation").delete().eq("workspace_id", workspaceId).eq("employee_id", employee));
    return;
  }
  const data = parse(payFields, input);
  unwrap(
    await ctx.db
      .from("employee_compensation")
      .upsert({ employee_id: employee, workspace_id: workspaceId, pay_amount: data.amount, pay_period: data.period }),
  );
}

// --- Time off ---------------------------------------------------------------

/** Time-off requests, newest first. */
export async function listLeave(
  ctx: Ctx,
  workspaceId: string,
  filter: { status?: LeaveStatus } = {},
): Promise<LeaveRequest[]> {
  await authorize(ctx, parse(id, workspaceId), "hr", "view");
  const status = parse(z.enum(LEAVE_STATUSES).optional(), filter.status);
  let query = ctx.db.from("leave_requests").select(LEAVE_COLUMNS).eq("workspace_id", workspaceId);
  if (status) query = query.eq("status", status);
  const [requests, people] = await Promise.all([
    query.order("start_date", { ascending: false }).limit(1000),
    ctx.db.from("employees").select("id, full_name").eq("workspace_id", workspaceId).limit(5000),
  ]);
  const nameOf = new Map(unwrap<{ id: string; full_name: string }[]>(people).map((p) => [p.id, p.full_name]));
  return unwrap<Omit<LeaveRequest, "employee_name">[]>(requests).map((row) => ({
    ...row,
    employee_name: nameOf.get(row.employee_id) ?? "",
  }));
}

/** Ask for time off for a person. It starts as pending. */
export async function requestLeave(ctx: Ctx, workspaceId: string, input: LeaveInput): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "hr", "edit");
  const data = parse(leaveFields, input);
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("leave_requests")
      .insert({
        workspace_id: workspaceId,
        employee_id: data.employeeId,
        kind: data.kind,
        start_date: data.startDate,
        end_date: data.endDate,
        note: data.note,
        created_by: ctx.userId,
      })
      .select("id")
      .single(),
  );
  return row.id;
}

/** Approve or decline a request, or put it back to pending. */
export async function decideLeave(
  ctx: Ctx,
  workspaceId: string,
  leaveId: string,
  input: { status: LeaveStatus },
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "hr", "manage");
  const { status } = parse(z.object({ status: z.enum(LEAVE_STATUSES) }), input);
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("leave_requests").update({ status }).eq("workspace_id", workspaceId).eq("id", parse(id, leaveId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Request");
}

export async function deleteLeave(ctx: Ctx, workspaceId: string, leaveId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "hr", "manage");
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("leave_requests").delete().eq("workspace_id", workspaceId).eq("id", parse(id, leaveId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Request");
}
