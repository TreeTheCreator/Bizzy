import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/ui";
import { LEVELS, LIVE_PAGES, type Level, PAGES, PAGE_LABELS } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { type Role, listRoles } from "@/server/modules/roles/service";
import { getWorkspace } from "@/server/modules/workspaces/service";
import { deleteRoleAction, saveRoleAction } from "../actions";
import { SettingsNav } from "../subnav";

export const metadata: Metadata = { title: "Roles" };

const LEVEL_LABELS: Record<Level, string> = {
  none: "Can't open it",
  view: "Can look",
  edit: "Can add and change",
  manage: "Can also delete",
};

/** The permission matrix for one role (or a blank one for "new role"). */
function RoleForm({ workspaceId, role, editable }: { workspaceId: string; role?: Role; editable: boolean }) {
  const isGuest = role?.kind === "guest";
  return (
    <ActionForm action={saveRoleAction.bind(null, workspaceId)} successMessage="Saved.">
      {role && <input type="hidden" name="roleId" value={role.id} />}
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="label" htmlFor={`name-${role?.id ?? "new"}`}>Role name</label>
          <input className="input w-64" placeholder="Shop assistant" id={`name-${role?.id ?? "new"}`} name="name" defaultValue={role?.name ?? ""} required maxLength={60} disabled={!editable} />
        </div>
        <div>
          <label className="label" htmlFor={`kind-${role?.id ?? "new"}`}>Who is it for?</label>
          <select className="input w-64" id={`kind-${role?.id ?? "new"}`} name="kind" defaultValue={role?.kind ?? "custom"} disabled={!editable}>
            <option value="custom">Someone on the team</option>
            <option value="guest">An outside guest (can never delete)</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
      <table className="table mb-4">
        <thead>
          <tr>
            <th>Page</th>
            <th>What they can do</th>
            <th>Private details</th>
          </tr>
        </thead>
        <tbody>
          {PAGES.map((page) => {
            const current = role?.permissions[page];
            return (
              <tr key={page}>
                <td>
                  {PAGE_LABELS[page]}
                  {!LIVE_PAGES.includes(page) && <span className="ml-2 text-sm text-muted">(coming later)</span>}
                </td>
                <td>
                  <select className="input w-52" name={`level_${page}`} defaultValue={current?.level ?? "none"} aria-label={`${PAGE_LABELS[page]} access`} disabled={!editable}>
                    {LEVELS.filter((level) => !(isGuest && level === "manage")).map((level) => (
                      <option key={level} value={level}>{LEVEL_LABELS[level]}</option>
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
      </div>
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
      <PageHeader title="Settings" />
      <SettingsNav workspaceId={workspaceId} isOwner={access.isOwner} />
      <p className="muted mb-4">
        A role decides which pages a person can open and what they can do there. Make one role for each
        kind of job, such as &ldquo;Shop assistant&rdquo; or &ldquo;Bookkeeper&rdquo;, then give it to people on the
        People tab. Tick &ldquo;Private details&rdquo; to let the role see the sensitive information on that page.
        {!editable && " Only the owner can add or change roles."}
      </p>

      <div className="space-y-4">
        {roles.map((role) =>
          role.kind === "full_access" ? (
            <section key={role.id} className="card">
              <h2 className="h2">{role.name} <span className="pill ml-1 font-normal">Comes with Bizzy</span></h2>
              <p className="muted mt-1">
                Can do everything on every page, including pages added later. Can&apos;t change roles, hand over
                ownership or delete the workspace. This role can&apos;t be changed.
              </p>
            </section>
          ) : (
            <details key={role.id} className="card">
              <summary className="cursor-pointer font-semibold">
                {role.name} {role.kind === "guest" && <span className="pill ml-1 font-normal">Guest</span>}
              </summary>
              <div className="mt-4">
                <RoleForm workspaceId={workspaceId} role={role} editable={editable} />
                {editable && (
                  <ActionForm action={deleteRoleAction.bind(null, workspaceId)} className="mt-4 border-t border-border pt-4">
                    <input type="hidden" name="roleId" value={role.id} />
                    <ConfirmButton
                      title={`Delete the role "${role.name}"?`}
                      message="Everyone who has this role will see nothing until you give them another one."
                      confirmLabel="Delete role"
                    >
                      Delete role
                    </ConfirmButton>
                  </ActionForm>
                )}
              </div>
            </details>
          ),
        )}
      </div>

      {editable && (
        <section className="card mt-6">
          <h2 className="h2 mb-3">Add a role</h2>
          <RoleForm workspaceId={workspaceId} editable />
        </section>
      )}
    </div>
  );
}
