import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { listInvites, listMembers } from "@/server/modules/members/service";
import { listRoles } from "@/server/modules/roles/service";
import { getWorkspace } from "@/server/modules/workspaces/service";
import {
  createInviteAction,
  removeMemberAction,
  revokeInviteAction,
  setMemberRoleAction,
} from "../actions";
import { SettingsNav } from "../subnav";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const [members, roles, { access }] = await Promise.all([
      listMembers(ctx, workspaceId),
      listRoles(ctx, workspaceId),
      getWorkspace(ctx, workspaceId),
    ]);
    const invites = atLeast(access.levels.settings, "manage") ? await listInvites(ctx, workspaceId) : null;
    return { members, roles, access, invites };
  });
  if (loaded.denied) return <NoAccess what="Settings" />;
  const { members, roles, access, invites } = loaded.data;
  const roleName = (roleId: string | null) => roles.find((r) => r.id === roleId)?.name ?? "No role";
  const pending = invites?.filter((i) => !i.accepted_at && !i.revoked_at && new Date(i.expires_at) > new Date());

  return (
    <div className="max-w-4xl">
      <h1 className="h1 mb-4">Members</h1>
      <SettingsNav workspaceId={workspaceId} isOwner={access.isOwner} />

      {!access.isOwner && (
        <p className="muted mb-4">Only the workspace owner can assign, change or remove roles and members.</p>
      )}

      <div className="card mb-6 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              {access.isOwner && <th>Change role</th>}
              {access.isOwner && <th />}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>
                  <div className="font-medium">{m.display_name}</div>
                  <div className="text-muted">{m.email}</div>
                </td>
                <td>
                  {m.is_owner ? <span className="badge">Owner</span> : roleName(m.role_id)}
                  {m.expires_at && (
                    <div className="text-muted">
                      {new Date(m.expires_at) <= new Date() ? "Expired" : "Until"} {m.expires_at.slice(0, 10)}
                    </div>
                  )}
                </td>
                {access.isOwner && (
                  <td>
                    {!m.is_owner && (
                      <ActionForm action={setMemberRoleAction.bind(null, workspaceId)} className="flex flex-wrap items-end gap-2" successMessage="Saved.">
                        <input type="hidden" name="userId" value={m.user_id} />
                        <select className="input w-40" name="roleId" defaultValue={m.role_id ?? ""} aria-label={`Role for ${m.display_name}`}>
                          <option value="">No role (no access)</option>
                          {roles.map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                        <input
                          className="input w-40"
                          type="date"
                          name="expiresOn"
                          defaultValue={m.expires_at?.slice(0, 10) ?? ""}
                          aria-label={`Access end date for ${m.display_name} (optional)`}
                          title="Optional end date"
                        />
                        <button className="btn btn-sm" type="submit">Save</button>
                      </ActionForm>
                    )}
                  </td>
                )}
                {access.isOwner && (
                  <td>
                    {!m.is_owner && (
                      <ActionForm action={removeMemberAction.bind(null, workspaceId)}>
                        <input type="hidden" name="userId" value={m.user_id} />
                        <button className="btn btn-sm btn-danger" type="submit">Remove</button>
                      </ActionForm>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {invites && (
        <section className="card">
          <h2 className="h2 mb-1">Invite someone</h2>
          <p className="muted mb-3">
            An invite only lets them join. They see nothing until the owner gives them a role. The link works
            for 14 days and only for the email address you enter.
          </p>
          <ActionForm action={createInviteAction.bind(null, workspaceId)} className="flex flex-wrap gap-2">
            <input className="input max-w-xs" type="email" name="email" placeholder="name@example.com" aria-label="Email to invite" required />
            <button className="btn btn-primary" type="submit">Create invite link</button>
          </ActionForm>

          {pending && pending.length > 0 && (
            <>
              <h3 className="mt-5 mb-2 text-sm font-medium">Pending invites</h3>
              <ul className="space-y-2 text-sm">
                {pending.map((invite) => (
                  <li key={invite.id} className="flex items-center justify-between gap-3">
                    <span>
                      {invite.email} <span className="text-muted">· expires {invite.expires_at.slice(0, 10)}</span>
                    </span>
                    <ActionForm action={revokeInviteAction.bind(null, workspaceId)}>
                      <input type="hidden" name="inviteId" value={invite.id} />
                      <button className="btn btn-sm" type="submit">Cancel</button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
