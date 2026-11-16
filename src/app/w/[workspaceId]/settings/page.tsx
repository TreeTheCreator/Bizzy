import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/ui";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { listMembers } from "@/server/modules/members/service";
import { getWorkspace } from "@/server/modules/workspaces/service";
import {
  deleteWorkspaceAction,
  leaveWorkspaceAction,
  renameWorkspaceAction,
  transferOwnershipAction,
} from "./actions";
import { SettingsNav } from "./subnav";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const members = await listMembers(ctx, workspaceId); // requires Settings view
    const { workspace, access } = await getWorkspace(ctx, workspaceId);
    return { members, workspace, access };
  });
  if (loaded.denied) return <NoAccess what="Settings" />;
  const { members, workspace, access } = loaded.data;
  const canManage = atLeast(access.levels.settings, "manage");
  const others = members.filter((m) => !m.is_owner);

  return (
    <div className="max-w-2xl">
      <PageHeader title="Settings" />
      <SettingsNav workspaceId={workspaceId} isOwner={access.isOwner} />

      <section className="card mb-6">
        <h2 className="h2 mb-1">Business name</h2>
        <p className="muted mb-3">This is the name everyone sees at the top of the menu.</p>
        {canManage ? (
          <ActionForm action={renameWorkspaceAction.bind(null, workspaceId)} className="flex flex-wrap gap-2" successMessage="Saved.">
            <input className="input max-w-xs" name="name" defaultValue={workspace.name} aria-label="Business name" required maxLength={80} />
            <button className="btn btn-primary" type="submit">Save name</button>
          </ActionForm>
        ) : (
          <p>{workspace.name}</p>
        )}
      </section>

      {access.isOwner ? (
        <>
          <section className="card mb-6">
            <h2 className="h2 mb-1">Hand over to a new owner</h2>
            <p className="muted mb-3">
              The new owner takes full control, including who can see what and deleting the workspace. You
              stay a member but see nothing until they give you a role. This is recorded in the activity log.
            </p>
            {others.length === 0 ? (
              <p className="muted">Invite someone first. Only a person who has already joined can become the owner.</p>
            ) : (
              <ActionForm action={transferOwnershipAction.bind(null, workspaceId)} className="space-y-4">
                <div>
                  <label className="label" htmlFor="newOwnerId">New owner</label>
                  <select className="input max-w-xs" id="newOwnerId" name="newOwnerId" required defaultValue="">
                    <option value="" disabled>Choose a person</option>
                    {others.map((m) => (
                      <option key={m.user_id} value={m.user_id}>{m.display_name} ({m.email})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="transferConfirm">To confirm, type the business name: {workspace.name}</label>
                  <input className="input max-w-xs" id="transferConfirm" name="confirmName" required autoComplete="off" />
                </div>
                <button className="btn btn-danger" type="submit">Hand over ownership</button>
              </ActionForm>
            )}
          </section>

          <section className="card">
            <h2 className="h2 mb-1 text-danger">Delete this workspace</h2>
            <p className="muted mb-3">
              This removes {workspace.name} and everything in it for good: tasks, docs, files, customers,
              invoices, people and the activity log. You can&apos;t undo this.
            </p>
            <ActionForm action={deleteWorkspaceAction.bind(null, workspaceId)} className="space-y-4">
              <div>
                <label className="label" htmlFor="deleteConfirm">To confirm, type the business name: {workspace.name}</label>
                <input className="input max-w-xs" id="deleteConfirm" name="confirmName" required autoComplete="off" />
              </div>
              <button className="btn btn-danger-solid" type="submit">Delete everything for good</button>
            </ActionForm>
          </section>
        </>
      ) : (
        <section className="card">
          <h2 className="h2 mb-1">Leave this workspace</h2>
          <p className="muted mb-3">You stop seeing everything here right away. To come back, you need a new invite.</p>
          <ActionForm action={leaveWorkspaceAction.bind(null, workspaceId)}>
            <ConfirmButton
              title={`Leave ${workspace.name}?`}
              message="You stop seeing everything here right away. To come back, you need a new invite."
              confirmLabel="Leave"
            >
              Leave {workspace.name}
            </ConfirmButton>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
