import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { dueLabel, formatDate, pillClass, todayIso } from "@/lib/format";
import { PAGE_LABELS, type Page, atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { listDocs } from "@/server/modules/docs/service";
import { listTasks } from "@/server/modules/tasks/service";
import { getWorkspace } from "@/server/modules/workspaces/service";

const SHORTCUTS: { page: Page; icon: IconName; hint: string }[] = [
  { page: "tasks", icon: "tasks", hint: "What needs doing, and who is doing it" },
  { page: "docs", icon: "docs", hint: "Notes, guides and files" },
  { page: "crm", icon: "customers", hint: "Contacts, companies and deals" },
  { page: "finance", icon: "money", hint: "Invoices, quotes and spending" },
];

export default async function WorkspaceHome({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getWebCtx();
  const { workspace, access } = await getWorkspace(ctx, workspaceId);
  const base = `/w/${workspaceId}`;
  const today = todayIso();

  // Each block is loaded only if the caller's role includes that page.
  const myTasks = atLeast(access.levels.tasks, "view")
    ? await listTasks(ctx, workspaceId, { assigneeId: ctx.userId, openOnly: true })
    : null;
  const docs = atLeast(access.levels.docs, "view") ? await listDocs(ctx, workspaceId) : null;
  const recentDocs = docs
    ? [...docs].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5)
    : null;
  const shortcuts = SHORTCUTS.filter((s) => atLeast(access.levels[s.page], "view"));

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="h1">{workspace.name}</h1>
        <p className="muted mt-1">Here is what is going on today.</p>
      </div>

      {shortcuts.length > 0 && (
        <nav aria-label="Go to" className="grid gap-3 sm:grid-cols-2">
          {shortcuts.map((s) => (
            <Link key={s.page} href={`${base}/${s.page}`} className="card flex items-center gap-4 hover:border-accent">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent-bg text-accent">
                <Icon name={s.icon} size={22} />
              </span>
              <span>
                <span className="block font-semibold">{PAGE_LABELS[s.page]}</span>
                <span className="muted block">{s.hint}</span>
              </span>
            </Link>
          ))}
        </nav>
      )}

      {myTasks && (
        <section className="card">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="h2">Your tasks</h2>
            <Link className="link text-[15px]" href={`${base}/tasks`}>See all tasks</Link>
          </div>
          {myTasks.length === 0 ? (
            <p className="muted">You have nothing to do right now.</p>
          ) : (
            <ul>
              {myTasks.slice(0, 8).map((task) => {
                const due = dueLabel(task.due_date, today);
                return (
                  <li key={task.id} className="row">
                    <Link className="min-w-0 flex-1 truncate font-medium hover:underline" href={`${base}/tasks/${task.id}`}>
                      {task.title}
                    </Link>
                    {due && <span className={pillClass(due.tone)}>{due.label}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {recentDocs && (
        <section className="card">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="h2">Recently changed docs</h2>
            <Link className="link text-[15px]" href={`${base}/docs`}>See all docs</Link>
          </div>
          {recentDocs.length === 0 ? (
            <p className="muted">No docs have been written yet.</p>
          ) : (
            <ul>
              {recentDocs.map((doc) => (
                <li key={doc.id} className="row">
                  <Link className="min-w-0 flex-1 truncate font-medium hover:underline" href={`${base}/docs/${doc.id}`}>
                    {doc.title}
                  </Link>
                  <span className="muted">{formatDate(doc.updated_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!myTasks && !recentDocs && shortcuts.length === 0 && (
        <p className="muted">The pages your role includes are not available in this version yet.</p>
      )}
    </div>
  );
}
