import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton, ModalButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { EmptyState, PageHeader, Tabs } from "@/components/ui";
import { type Tone, formatDate, formatMoney, pillClass } from "@/lib/format";
import { atLeast } from "@/server/authz/pages";
import { authorize } from "@/server/authz/authorize";
import { getWebCtx } from "@/server/db/web";
import { type Employee, type LeaveRequest, listEmployees, listLeave } from "@/server/modules/hr/service";
import {
  createEmployeeAction,
  decideLeaveAction,
  deleteEmployeeAction,
  deleteLeaveAction,
  requestLeaveAction,
  setPayAction,
  updateEmployeeAction,
} from "./actions";

export const metadata: Metadata = { title: "HR" };

const VIEWS = ["people", "leave"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABELS: Record<View, string> = { people: "People", leave: "Time off" };

const PERIOD_LABELS = { hour: "an hour", month: "a month", year: "a year" } as const;
const KIND_LABELS = { holiday: "Holiday", sick: "Sick leave", other: "Other" } as const;
const STATUS_LABELS: Record<LeaveRequest["status"], { label: string; tone: Tone }> = {
  pending: { label: "Waiting for an answer", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  declined: { label: "Declined", tone: "danger" },
};

function days(request: LeaveRequest): string {
  const count = Math.round((Date.parse(request.end_date) - Date.parse(request.start_date)) / 86_400_000) + 1;
  return count === 1 ? "1 day" : `${count} days`;
}

export default async function HrPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const view: View = VIEWS.find((v) => v === query.view) ?? "people";
  const ctx = await getWebCtx();

  const loaded = await tryLoad(async () => {
    const access = await authorize(ctx, workspaceId, "hr", "view");
    const [people, leave] = await Promise.all([listEmployees(ctx, workspaceId), listLeave(ctx, workspaceId)]);
    return { access, ...people, leave };
  });
  if (loaded.denied) return <NoAccess what="HR" />;
  const { access, employees, canSeePay, leave } = loaded.data;
  const canEdit = atLeast(access.levels.hr, "edit");
  const canManage = atLeast(access.levels.hr, "manage");
  const base = `/w/${workspaceId}/hr`;
  const active = employees.filter((e) => e.status === "active");

  const personFields = (e?: Employee) => (
    <div className="space-y-4">
      <label className="block">
        <span className="label">Full name</span>
        <input className="input" name="fullName" defaultValue={e?.full_name} required maxLength={200} />
      </label>
      <label className="block">
        <span className="label">Job (optional)</span>
        <input className="input" name="jobTitle" defaultValue={e?.job_title} placeholder="Barista" maxLength={200} />
      </label>
      <label className="block">
        <span className="label">Email (optional)</span>
        <input className="input" type="email" name="email" defaultValue={e?.email} placeholder="name@example.com" maxLength={320} />
      </label>
      <label className="block">
        <span className="label">Phone (optional)</span>
        <input className="input" type="tel" name="phone" defaultValue={e?.phone} maxLength={60} />
      </label>
      <label className="block">
        <span className="label">First day at work (optional)</span>
        <input className="input" type="date" name="startDate" defaultValue={e?.start_date ?? ""} />
      </label>
      {e && (
        <label className="block">
          <span className="label">Still works here?</span>
          <select className="input" name="status" defaultValue={e.status}>
            <option value="active">Yes</option>
            <option value="left">No, they have left</option>
          </select>
        </label>
      )}
    </div>
  );

  const newPerson = (label = "New person") => (
    <ModalButton label={label} title="New person" icon="plus">
      <ActionForm action={createEmployeeAction.bind(null, workspaceId)}>
        {personFields()}
        <button className="btn btn-primary mt-5 w-full sm:w-auto" type="submit">Add person</button>
      </ActionForm>
    </ModalButton>
  );

  const newLeave = (label = "Ask for time off") => (
    <ModalButton label={label} title="Ask for time off" icon="plus">
      <ActionForm action={requestLeaveAction.bind(null, workspaceId)}>
        <div className="space-y-4">
          <label className="block">
            <span className="label">Who is it for?</span>
            <select className="input" name="employeeId" required defaultValue="">
              <option value="" disabled>Choose a person</option>
              {active.map((e) => (
                <option key={e.id} value={e.id}>{e.full_name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">What kind?</span>
            <select className="input" name="kind" defaultValue="holiday">
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">First day off</span>
            <input className="input" type="date" name="startDate" required />
          </label>
          <label className="block">
            <span className="label">Last day off</span>
            <input className="input" type="date" name="endDate" />
            <span className="muted mt-1 block">Leave empty for a single day.</span>
          </label>
          <label className="block">
            <span className="label">Note (optional)</span>
            <input className="input" name="note" maxLength={2000} />
          </label>
        </div>
        <button className="btn btn-primary mt-5 w-full sm:w-auto" type="submit">Send request</button>
      </ActionForm>
    </ModalButton>
  );

  return (
    <div className="max-w-5xl">
      <PageHeader title="HR">
        {canEdit && (view === "people" ? newPerson() : active.length > 0 && newLeave())}
      </PageHeader>

      <div className="mb-5">
        <Tabs
          label="Show"
          items={VIEWS.map((v) => ({ href: v === "people" ? base : `${base}?view=${v}`, label: VIEW_LABELS[v], active: v === view }))}
        />
      </div>

      {view === "people" &&
        (employees.length === 0 ? (
          <EmptyState
            icon="customers"
            title={canEdit ? "Add your first person" : "Nobody has been added yet"}
            body="Keep the people who work here in one place: what they do, when they started, and their time off."
          >
            {canEdit && newPerson("Add a person")}
          </EmptyState>
        ) : (
          <>
            {!canSeePay && (
              <p className="muted mb-3">Your role does not include pay, so pay is not shown here.</p>
            )}
            <section className="card overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Job</th>
                    <th>Started</th>
                    {canSeePay && <th>Pay</th>}
                    {canEdit && <th><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {employees.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <div className="font-medium">{e.full_name}</div>
                        {e.email && <div className="muted">{e.email}</div>}
                        {e.status === "left" && <span className="pill mt-1">Has left</span>}
                      </td>
                      <td>{e.job_title}</td>
                      <td>{formatDate(e.start_date)}</td>
                      {canSeePay && (
                        <td>{e.pay ? `${formatMoney(e.pay.amount)} ${PERIOD_LABELS[e.pay.period]}` : <span className="muted">Not entered</span>}</td>
                      )}
                      {canEdit && (
                        <td className="text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            {canSeePay && (
                              <ModalButton label="Pay" title={`Pay for ${e.full_name}`} className="btn btn-sm">
                                <ActionForm action={setPayAction.bind(null, workspaceId)}>
                                  <input type="hidden" name="employeeId" value={e.id} />
                                  <div className="space-y-4">
                                    <label className="block">
                                      <span className="label">Amount</span>
                                      <input className="input" type="number" name="amount" min="0" step="0.01" defaultValue={e.pay?.amount ?? ""} placeholder="0.00" />
                                      <span className="muted mt-1 block">Leave empty to remove the pay.</span>
                                    </label>
                                    <label className="block">
                                      <span className="label">Paid</span>
                                      <select className="input" name="period" defaultValue={e.pay?.period ?? "year"}>
                                        {Object.entries(PERIOD_LABELS).map(([value, label]) => (
                                          <option key={value} value={value}>{label}</option>
                                        ))}
                                      </select>
                                    </label>
                                  </div>
                                  <p className="muted mt-3">Only people whose role includes HR private details can see this.</p>
                                  <button className="btn btn-primary mt-5" type="submit">Save pay</button>
                                </ActionForm>
                              </ModalButton>
                            )}
                            <ModalButton label="Edit" title={`Edit ${e.full_name}`} className="btn btn-sm">
                              <ActionForm action={updateEmployeeAction.bind(null, workspaceId)}>
                                <input type="hidden" name="employeeId" value={e.id} />
                                {personFields(e)}
                                <button className="btn btn-primary mt-5" type="submit">Save changes</button>
                              </ActionForm>
                              {canManage && (
                                <ActionForm action={deleteEmployeeAction.bind(null, workspaceId)} className="mt-4 border-t border-border pt-4">
                                  <input type="hidden" name="employeeId" value={e.id} />
                                  <ConfirmButton
                                    title={`Delete ${e.full_name}?`}
                                    message="This person, their pay and their time-off history will be removed for good. You can't undo this."
                                    confirmLabel="Delete person"
                                  >
                                    Delete person
                                  </ConfirmButton>
                                </ActionForm>
                              )}
                            </ModalButton>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        ))}

      {view === "leave" &&
        (leave.length === 0 ? (
          <EmptyState
            icon="tasks"
            title="No time off has been asked for"
            body={active.length === 0 ? "Add people first, then you can record their time off." : "Requests for holidays and sick leave show up here."}
          >
            {canEdit && active.length > 0 && newLeave("Ask for time off")}
          </EmptyState>
        ) : (
          <section className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Answer</th>
                  {canManage && <th><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {leave.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium">{r.employee_name}</td>
                    <td>
                      {r.start_date === r.end_date ? formatDate(r.start_date) : `${formatDate(r.start_date)} to ${formatDate(r.end_date)}`}
                      <div className="muted">{days(r)}{r.note && ` · ${r.note}`}</div>
                    </td>
                    <td>{KIND_LABELS[r.kind]}</td>
                    <td><span className={pillClass(STATUS_LABELS[r.status].tone)}>{STATUS_LABELS[r.status].label}</span></td>
                    {canManage && (
                      <td className="text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          {r.status !== "approved" && (
                            <ActionForm action={decideLeaveAction.bind(null, workspaceId)}>
                              <input type="hidden" name="leaveId" value={r.id} />
                              <input type="hidden" name="status" value="approved" />
                              <button className="btn btn-sm" type="submit" aria-label={`Approve time off for ${r.employee_name}`}>Approve</button>
                            </ActionForm>
                          )}
                          {r.status !== "declined" && (
                            <ActionForm action={decideLeaveAction.bind(null, workspaceId)}>
                              <input type="hidden" name="leaveId" value={r.id} />
                              <input type="hidden" name="status" value="declined" />
                              <button className="btn btn-sm" type="submit" aria-label={`Decline time off for ${r.employee_name}`}>Decline</button>
                            </ActionForm>
                          )}
                          <ActionForm action={deleteLeaveAction.bind(null, workspaceId)}>
                            <input type="hidden" name="leaveId" value={r.id} />
                            <ConfirmButton
                              className="btn btn-sm btn-danger"
                              title="Delete this request?"
                              message="It will be removed for good. You can't undo this."
                              confirmLabel="Delete request"
                            >
                              Delete
                            </ConfirmButton>
                          </ActionForm>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
    </div>
  );
}
