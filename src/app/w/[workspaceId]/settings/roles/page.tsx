import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
import { LEVELS, LIVE_PAGES, PAGES, PAGE_LABELS } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { type Role, listRoles } from "@/server/modules/roles/service";
import { getWorkspace } from "@/server/modules/workspaces/service";
import { deleteRoleAction, saveRoleAction } from "../actions";
import { SettingsNav } from "../subnav";

export const metadata: Metadata = { title: "Roles" };

/** The permission matrix for one role (or a blank one for "new role"). */
function RoleForm({ workspaceId, role, editable }: { workspaceId: string; role?: Role; editable: boolean }) {
  const isGuest = role?.kind === "guest";
  return (
    <ActionForm action={saveRoleAction.bind(null, workspaceId)} successMessage="Saved.">
      {role && <input type="hidden" name="roleId" value={role.id} />}
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor={`name-${role?.id ?? "new"}`}>Role name</label>
          <input className="input w-56" id={`name-${role?.id ?? "new"}`} name="name" defaultValue={role?.name ?? ""} required maxLength={60} disabled={!editable} />
        </div>
        <div>
          <label className="label" htmlFor={`kind-${role?.id ?? "new"}`}>Type</label>
          <select className="input w-56" id={`kind-${role?.id ?? "new"}`} name="kind" defaultValue={role?.kind ?? "custom"} disabled={!editable}>
            <option value="custom">Team role</option>
            <option value="guest">Guest (view or edit only, no Settings)</option>
          </select>
        </div>
      </div>
      <table className="table mb-3">
        <thead>
          <tr>
            <th>Page</th>
            <th>Access</th>
            <th>Sensitive fields</th>
          </tr>
        </thead>
        <tbody>
          {PAGES.map((page) => {
            const current = role?.permissions[page];
            return (
              <tr key={page}>
                <td>
                  {PAGE_LABELS[page]}
                  {!LIVE_PAGES.includes(page) && <span className="ml-2 text-xs text-muted">(coming later)</span>}
                </td>
                <td>
                  <select className="input w-32" name={`level_${page}`} defaultValue={current?.level ?? "none"} aria-label={`${PAGE_LABELS[page]} access`} disabled={!editable}>
                    {LEVELS.filter((level) => !(isGuest && level === "manage")).map((level) => (
                      <option key={level} value={level}>{level}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input type="checkbox" name={`sensitive_${page}`} defaultChecked={current?.sensitive ?? false} aria-label={`${PAGE_LABELS[page]} sensitive fields`} disabled={!editable} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editable && (
        <button className="btn btn-primary" type="submit">{role ? "Save role" : "Create role"}</button>
      )}
    </ActionForm>
  );
}

export default async function RolesPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const [roles, { access }] = await Promise.all([listRoles(ctx, workspaceId), getWorkspace(ctx, workspaceId)]);
    return { roles, access };
  });
  if (loaded.denied) return <NoAccess what="Settings" />;
  const { roles, access } = loaded.data;
  const editable = access.isOwner;

  return (
    <div className="max-w-3xl">
      <h1 className="h1 mb-4">Roles</h1>
      <SettingsNav workspaceId={workspaceId} isOwner={access.isOwner} />
      <p className="muted mb-4">
        A role says which pages a member can open and how much they can do there: <b>view</b> (read),{" "}
        <b>edit</b> (create and change) or <b>manage</b> (also delete). Anything not listed is no access.
        {!editable && " Only the workspace owner can create or change roles."}
      </p>

      <div className="space-y-4">
        {roles.map((role) =>
          role.kind === "full_access" ? (
            <section key={role.id} className="card">
              <h2 className="h2">{role.name} <span className="badge ml-1">Built in</span></h2>
              <p className="muted mt-1">
                Manage on every page, including pages added in the future. Cannot grant or change roles,
                transfer ownership or delete the workspace. This role cannot be edited.
              </p>
            </section>
          ) : (
            <details key={role.id} className="card">
              <summary className="cursor-pointer font-semibold">
                {role.name} {role.kind === "guest" && <span className="badge ml-1">Guest</span>}
              </summary>
              <div className="mt-4">
                <RoleForm workspaceId={workspaceId} role={role} editable={editable} />
                {editable && (
                  <ActionForm action={deleteRoleAction.bind(null, workspaceId)} className="mt-3">
                    <input type="hidden" name="roleId" value={role.id} />
                    <button className="btn btn-sm btn-danger" type="submit">Delete role</button>
                    <span className="muted ml-2">Members with this role drop to no access.</span>
                  </ActionForm>
                )}
              </div>
            </details>
          ),
        )}
      </div>

      {editable && (
        <section className="card mt-6">
          <h2 className="h2 mb-3">New role</h2>
          <RoleForm workspaceId={workspaceId} editable />
        </section>
      )}
    </div>
  );
}
