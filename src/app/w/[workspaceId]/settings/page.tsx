import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
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
      <h1 className="h1 mb-4">Settings</h1>
      <SettingsNav workspaceId={workspaceId} isOwner={access.isOwner} />

      <section className="card mb-6">
        <h2 className="h2 mb-3">Workspace name</h2>
        {canManage ? (
          <ActionForm action={renameWorkspaceAction.bind(null, workspaceId)} className="flex flex-wrap gap-2" successMessage="Saved.">
            <input className="input max-w-xs" name="name" defaultValue={workspace.name} aria-label="Workspace name" required maxLength={80} />
            <button className="btn btn-primary" type="submit">Save</button>
          </ActionForm>
        ) : (
          <p>{workspace.name}</p>
        )}
      </section>

      {access.isOwner ? (
        <>
          <section className="card mb-6">
            <h2 className="h2 mb-1">Transfer ownership</h2>
            <p className="muted mb-3">
              The new owner gets every owner power, including roles and deleting the workspace. You stay a
              member with no role until they give you one. This is logged.
            </p>
            {others.length === 0 ? (
              <p className="muted">Invite someone first; ownership can only go to a current member.</p>
            ) : (
              <ActionForm action={transferOwnershipAction.bind(null, workspaceId)} className="space-y-3">
                <div>
                  <label className="label" htmlFor="newOwnerId">New owner</label>
                  <select className="input max-w-xs" id="newOwnerId" name="newOwnerId" required defaultValue="">
                    <option value="" disabled>Choose a member</option>
                    {others.map((m) => (
                      <option key={m.user_id} value={m.user_id}>{m.display_name} ({m.email})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="transferConfirm">Type the workspace name to confirm</label>
                  <input className="input max-w-xs" id="transferConfirm" name="confirmName" required autoComplete="off" />
                </div>
                <button className="btn btn-danger" type="submit">Transfer ownership</button>
              </ActionForm>
            )}
          </section>

          <section className="card border-danger">
            <h2 className="h2 mb-1">Delete workspace</h2>
            <p className="muted mb-3">
              Permanently deletes {workspace.name} and everything in it: tasks, docs, files, members and
              the audit log. This cannot be undone.
            </p>
            <ActionForm action={deleteWorkspaceAction.bind(null, workspaceId)} className="space-y-3">
              <div>
                <label className="label" htmlFor="deleteConfirm">Type the workspace name to confirm</label>
                <input className="input max-w-xs" id="deleteConfirm" name="confirmName" required autoComplete="off" />
              </div>
              <button className="btn btn-danger" type="submit">Delete workspace permanently</button>
            </ActionForm>
          </section>
        </>
      ) : (
        <section className="card">
          <h2 className="h2 mb-1">Leave workspace</h2>
          <p className="muted mb-3">You lose access immediately. You need a new invite to come back.</p>
          <ActionForm action={leaveWorkspaceAction.bind(null, workspaceId)}>
            <button className="btn btn-danger" type="submit">Leave {workspace.name}</button>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
