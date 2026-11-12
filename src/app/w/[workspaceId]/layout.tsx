import Link from "next/link";
import { notFound } from "next/navigation";
import { signOut } from "@/app/(auth)/actions";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { LIVE_PAGES, PAGE_LABELS } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { countUnread } from "@/server/modules/notifications/service";
import { getWorkspace, listMyWorkspaces } from "@/server/modules/workspaces/service";
import { leaveWorkspaceAction } from "./settings/actions";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const ctx = await getWebCtx(`/w/${workspaceId}`);
  const loaded = await tryLoad(() => getWorkspace(ctx, workspaceId));
  // Not a member: do not reveal whether the workspace exists.
  if (loaded.denied) notFound();
  const { workspace, access } = loaded.data;
  const [workspaces, unread] = await Promise.all([listMyWorkspaces(ctx), countUnread(ctx, workspaceId)]);
  const base = `/w/${workspaceId}`;
  const visiblePages = LIVE_PAGES.filter((page) => access.levels[page] !== "none");
  const hasAnyAccess = Object.values(access.levels).some((level) => level !== "none");

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-border bg-surface p-4 md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <details className="mb-4">
          <summary className="cursor-pointer text-base font-semibold">{workspace.name}</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {workspaces
              .filter((w) => w.id !== workspaceId)
              .map((w) => (
                <li key={w.id}>
                  <Link className="block rounded px-2 py-1 hover:bg-bg" href={`/w/${w.id}`}>
                    {w.name}
                  </Link>
                </li>
              ))}
            <li>
              <Link className="block rounded px-2 py-1 text-accent hover:bg-bg" href="/workspaces">
                All workspaces / new
              </Link>
            </li>
          </ul>
        </details>

        {hasAnyAccess && (
          <>
            <form action={`${base}/search`} className="mb-3">
              <input className="input" type="search" name="q" placeholder="Search" aria-label="Search this workspace" />
            </form>
            <nav aria-label="Workspace" className="space-y-1 text-sm">
              <Link className="block rounded px-2 py-1 hover:bg-bg" href={base}>Home</Link>
              {visiblePages.map((page) => (
                <Link key={page} className="block rounded px-2 py-1 hover:bg-bg" href={`${base}/${page}`}>
                  {PAGE_LABELS[page]}
                </Link>
              ))}
              <Link className="block rounded px-2 py-1 hover:bg-bg" href={`${base}/notifications`}>
                Notifications{unread > 0 && <span className="badge ml-2">{unread}</span>}
              </Link>
            </nav>
          </>
        )}

        <div className="mt-6 border-t border-border pt-3 text-sm">
          <p className="truncate text-muted" title={ctx.email}>{ctx.email}</p>
          <p className="muted">
            {access.isOwner ? "Owner" : (access.roleName ?? "No role")}
          </p>
          <form action={signOut} className="mt-2">
            <button className="btn btn-sm" type="submit">Sign out</button>
          </form>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 md:p-8">
        {hasAnyAccess ? (
          children
        ) : (
          <div className="card max-w-lg">
            <h1 className="h1 mb-2">No access yet</h1>
            <p className="muted mb-4">
              You are a member of {workspace.name}, but the owner has not given you a role yet (or your access
              has ended). Once they assign one, your pages will appear here.
            </p>
            <ActionForm action={leaveWorkspaceAction.bind(null, workspaceId)}>
              <button className="btn btn-sm" type="submit">Leave this workspace</button>
            </ActionForm>
          </div>
        )}
      </main>
    </div>
  );
}
