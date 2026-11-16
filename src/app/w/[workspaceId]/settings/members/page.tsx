import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { AutoSelect, ConfirmButton, ModalButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
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

export const metadata: Metadata = { title: "People" };

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
      <PageHeader title="Settings" />
      <SettingsNav workspaceId={workspaceId} isOwner={access.isOwner} />

      {!access.isOwner && (
        <p className="muted mb-4">Only the owner can change roles or remove people.</p>
      )}

      <div className="card mb-6 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              {access.isOwner && <th><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>
                  <div className="font-medium">{m.display_name}</div>
                  <div className="muted">{m.email}</div>
                </td>
                <td>
                  {m.is_owner ? (
                    <span className="pill pill-info">Owner</span>
                  ) : access.isOwner ? (
                    <ActionForm action={setMemberRoleAction.bind(null, workspaceId)}>
                      <input type="hidden" name="userId" value={m.user_id} />
                      <input type="hidden" name="expiresOn" value={m.expires_at?.slice(0, 10) ?? ""} />
                      <AutoSelect className="input w-52" name="roleId" defaultValue={m.role_id ?? ""} aria-label={`Role for ${m.display_name}`}>
                        <option value="">No role (sees nothing)</option>
                        {roles.map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </AutoSelect>
                    </ActionForm>
                  ) : (
                    roleName(m.role_id)
                  )}
                  {m.expires_at && (
                    <div className={new Date(m.expires_at) <= new Date() ? "mt-1 text-[15px] text-danger" : "muted mt-1"}>
                      {new Date(m.expires_at) <= new Date() ? "Access ended" : "Access ends"} {formatDate(m.expires_at)}
                    </div>
                  )}
                </td>
                {access.isOwner && (
                  <td className="text-right">
                    {!m.is_owner && (
                      <div className="flex flex-wrap justify-end gap-2">
                        <ModalButton label="Set end date" title={`When should ${m.display_name}'s access end?`} className="btn btn-sm">
                          <ActionForm action={setMemberRoleAction.bind(null, workspaceId)} className="space-y-4 text-left">
                            <input type="hidden" name="userId" value={m.user_id} />
                            <input type="hidden" name="roleId" value={m.role_id ?? ""} />
                            <label className="block">
                              <span className="label">Last day of access</span>
                              <input className="input" type="date" name="expiresOn" defaultValue={m.expires_at?.slice(0, 10) ?? ""} />
                              <span className="muted mt-1 block">Useful for temporary helpers. Leave empty for no end date.</span>
                            </label>
                            <button className="btn btn-primary" type="submit">Save</button>
                          </ActionForm>
                        </ModalButton>
                        <ActionForm action={removeMemberAction.bind(null, workspaceId)}>
                          <input type="hidden" name="userId" value={m.user_id} />
                          <ConfirmButton
                            className="btn btn-sm btn-danger"
                            title={`Remove ${m.display_name}?`}
                            message="They stop seeing this workspace right away. To come back, they need a new invite."
                            confirmLabel="Remove person"
                          >
                            Remove
                          </ConfirmButton>
                        </ActionForm>
                      </div>
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
            Enter their email to get a link you can send them. After they join, the owner chooses their role;
            until then they see nothing. The link works for 14 days, and only for that email address.
          </p>
          <ActionForm action={createInviteAction.bind(null, workspaceId)} className="flex flex-wrap gap-2">
            <input className="input max-w-xs" type="email" name="email" placeholder="name@example.com" aria-label="Email to invite" required />
            <button className="btn btn-primary" type="submit">Get invite link</button>
          </ActionForm>

          {pending && pending.length > 0 && (
            <>
              <h3 className="mt-6 mb-2 font-semibold">Invites not used yet</h3>
              <ul>
                {pending.map((invite) => (
                  <li key={invite.id} className="row">
                    <span className="min-w-0 flex-1">
                      {invite.email} <span className="text-muted">· works until {formatDate(invite.expires_at)}</span>
                    </span>
                    <ActionForm action={revokeInviteAction.bind(null, workspaceId)}>
                      <input type="hidden" name="inviteId" value={invite.id} />
                      <button className="btn btn-sm" type="submit">Cancel invite</button>
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
