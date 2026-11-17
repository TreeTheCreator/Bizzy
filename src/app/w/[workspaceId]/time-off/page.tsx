import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton, ModalButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { EmptyState, PageHeader } from "@/components/ui";
import { type Tone, formatDate, pillClass } from "@/lib/format";
import { getWebCtx } from "@/server/db/web";
import { type LeaveRequest, getMyTimeOff } from "@/server/modules/hr/service";
import { cancelMyLeaveAction, requestMyLeaveAction } from "./actions";

export const metadata: Metadata = { title: "My time off" };

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

export default async function MyTimeOffPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(() => getMyTimeOff(ctx, workspaceId));
  if (loaded.denied) return <NoAccess what="time off" />;
  const { person, requests } = loaded.data;

  if (!person) {
    return (
      <div className="max-w-2xl">
        <PageHeader title="My time off" />
        <EmptyState
          icon="tasks"
          title="You are not listed in HR here"
          body="Ask someone who looks after HR to link your account to your person record. Then you can ask for time off here."
        />
      </div>
    );
  }

  const newRequest = (label = "Ask for time off") => (
    <ModalButton label={label} title="Ask for time off" icon="plus">
      <ActionForm action={requestMyLeaveAction.bind(null, workspaceId)}>
        <div className="space-y-4">
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
        <p className="muted mt-3">Whoever looks after HR will be told, and you will get an alert with the answer.</p>
        <button className="btn btn-primary mt-5 w-full sm:w-auto" type="submit">Send request</button>
      </ActionForm>
    </ModalButton>
  );

  return (
    <div className="max-w-3xl">
      <PageHeader title="My time off">{requests.length > 0 && newRequest()}</PageHeader>
      {requests.length === 0 ? (
        <EmptyState icon="tasks" title="You haven't asked for any time off" body={`Requests for ${person.full_name} show up here, with their answer.`}>
          {newRequest()}
        </EmptyState>
      ) : (
        <section className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Answer</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const when = r.start_date === r.end_date ? formatDate(r.start_date) : `${formatDate(r.start_date)} to ${formatDate(r.end_date)}`;
                return (
                  <tr key={r.id}>
                    <td>
                      {when}
                      <div className="muted">{days(r)}{r.note && ` · ${r.note}`}</div>
                    </td>
                    <td>{KIND_LABELS[r.kind]}</td>
                    <td><span className={pillClass(STATUS_LABELS[r.status].tone)}>{STATUS_LABELS[r.status].label}</span></td>
                    <td className="text-right">
                      {r.status === "pending" && (
                        <ActionForm action={cancelMyLeaveAction.bind(null, workspaceId)}>
                          <input type="hidden" name="leaveId" value={r.id} />
                          <ConfirmButton
                            className="btn btn-sm"
                            title="Cancel this request?"
                            message={`Your request for ${when} will be withdrawn.`}
                            confirmLabel="Cancel request"
                          >
                            Cancel
                          </ConfirmButton>
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
