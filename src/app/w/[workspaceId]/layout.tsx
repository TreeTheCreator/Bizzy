import Link from "next/link";
import { notFound } from "next/navigation";
import { signOut } from "@/app/(auth)/actions";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { Icon, type IconName } from "@/components/icons";
import { ConfirmButton } from "@/components/modal";
import { NavLink, SidebarShell } from "@/components/nav";
import { LIVE_PAGES, PAGES_OUTSIDE_WORKSPACE, PAGE_LABELS, type Page } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { getMyPerson } from "@/server/modules/hr/service";
import { countUnread } from "@/server/modules/notifications/service";
import { getWorkspace, listMyWorkspaces } from "@/server/modules/workspaces/service";
import { leaveWorkspaceAction } from "./settings/actions";

const PAGE_ICONS: Partial<Record<Page, IconName>> = {
  tasks: "tasks",
  docs: "docs",
  crm: "customers",
  finance: "money",
  hr: "customers",
  settings: "settings",
};

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
  const hasAnyAccess = Object.values(access.levels).some((level) => level !== "none");
  const [workspaces, unread, myPerson] = await Promise.all([
    listMyWorkspaces(ctx),
    countUnread(ctx, workspaceId),
    hasAnyAccess ? getMyPerson(ctx, workspaceId) : null,
  ]);
  const base = `/w/${workspaceId}`;
  const visiblePages = LIVE_PAGES.filter((page) => access.levels[page] !== "none");
  const mainPages = visiblePages.filter((page) => page !== "settings" && !PAGES_OUTSIDE_WORKSPACE.includes(page));
  // Reports draw on these pages; the link shows when the role includes at least one.
  const hasReports = (["tasks", "crm", "finance", "hr"] as const).some((page) => access.levels[page] !== "none");
  const otherWorkspaces = workspaces.filter((w) => w.id !== workspaceId);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <SidebarShell title={workspace.name}>
        <details className="group mb-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 text-lg font-semibold hover:bg-bg [&::-webkit-details-marker]:hidden">
            <span className="truncate">{workspace.name}</span>
            <Icon name="chevron" size={18} className="text-muted transition-transform group-open:rotate-180" />
          </summary>
          <ul className="mt-1 space-y-1 border-b border-border pb-3">
            {otherWorkspaces.map((w) => (
              <li key={w.id}>
                <Link className="nav-link" href={`/w/${w.id}`}>
                  <Icon name="swap" />
                  <span className="truncate">{w.name}</span>
                </Link>
              </li>
            ))}
            {access.levels.dashboard !== "none" && (
              <li>
                <Link className="nav-link" href="/overview">
                  <Icon name="home" />
                  All businesses at a glance
                </Link>
              </li>
            )}
            <li>
              <Link className="nav-link" href="/workspaces">
                <Icon name="plus" />
                {otherWorkspaces.length > 0 ? "All businesses" : "Add another business"}
              </Link>
            </li>
          </ul>
        </details>

        {hasAnyAccess && (
          <>
            <form action={`${base}/search`} className="relative mb-3" role="search">
              <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input className="input pl-10" type="search" name="q" placeholder="Search" aria-label="Search this workspace" />
            </form>
            <nav aria-label="Main menu" className="space-y-1">
              <NavLink href={base} icon="home" exact>Home</NavLink>
              {mainPages.map((page) => (
                <NavLink key={page} href={`${base}/${page}`} icon={PAGE_ICONS[page] ?? "docs"}>
                  {PAGE_LABELS[page]}
                </NavLink>
              ))}
              {hasReports && <NavLink href={`${base}/reports`} icon="docs">Reports</NavLink>}
              {myPerson && <NavLink href={`${base}/time-off`} icon="tasks">My time off</NavLink>}
              <NavLink href={`${base}/notifications`} icon="bell">
                Alerts
                {unread > 0 && (
                  <span className="pill pill-danger ml-auto" aria-label={`${unread} unread`}>{unread}</span>
                )}
              </NavLink>
              {visiblePages.includes("settings") && (
                <div className="pt-3">
                  <NavLink href={`${base}/settings`} icon="settings">Settings</NavLink>
                </div>
              )}
            </nav>
          </>
        )}

        <div className="mt-6 border-t border-border px-3 pt-4">
          <p className="truncate text-[15px]" title={ctx.email}>{ctx.email}</p>
          <p className="muted">{access.isOwner ? "Owner" : (access.roleName ?? "No role yet")}</p>
          <form action={signOut} className="mt-3">
            <button className="btn btn-sm" type="submit">Sign out</button>
          </form>
        </div>
      </SidebarShell>

      <main className="min-w-0 flex-1 p-4 md:p-8">
        {hasAnyAccess ? (
          children
        ) : (
          <div className="card max-w-lg">
            <h1 className="h1 mb-2">You&apos;re in, but can&apos;t see anything yet</h1>
            <p className="muted mb-4">
              You have joined {workspace.name}. The owner still needs to choose what you can see (or your access
              has ended). As soon as they do, your pages will appear here.
            </p>
            <ActionForm action={leaveWorkspaceAction.bind(null, workspaceId)}>
              <ConfirmButton
                className="btn"
                title={`Leave ${workspace.name}?`}
                message="You will need a new invite to come back."
                confirmLabel="Leave"
              >
                Leave this workspace
              </ConfirmButton>
            </ActionForm>
          </div>
        )}
      </main>
    </div>
  );
}
