import Link from "next/link";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { listDocs } from "@/server/modules/docs/service";
import { listTasks } from "@/server/modules/tasks/service";
import { getWorkspace } from "@/server/modules/workspaces/service";

export default async function WorkspaceHome({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getWebCtx();
  const { workspace, access } = await getWorkspace(ctx, workspaceId);
  const base = `/w/${workspaceId}`;

  // Each block is loaded only if the caller's role includes that page.
  const myTasks = atLeast(access.levels.tasks, "view")
    ? await listTasks(ctx, workspaceId, { assigneeId: ctx.userId, openOnly: true })
    : null;
  const docs = atLeast(access.levels.docs, "view") ? await listDocs(ctx, workspaceId) : null;
  const recentDocs = docs
    ? [...docs].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5)
    : null;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="h1">{workspace.name}</h1>

      {myTasks && (
        <section className="card">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="h2">Your open tasks</h2>
            <Link className="text-sm text-accent underline" href={`${base}/tasks`}>All tasks</Link>
          </div>
          {myTasks.length === 0 ? (
            <p className="muted">Nothing assigned to you.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {myTasks.slice(0, 8).map((task) => (
                <li key={task.id} className="flex justify-between gap-3">
                  <Link className="truncate hover:underline" href={`${base}/tasks/${task.id}`}>{task.title}</Link>
                  <span className="shrink-0 text-muted">{task.due_date ?? ""}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {recentDocs && (
        <section className="card">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="h2">Recently updated docs</h2>
            <Link className="text-sm text-accent underline" href={`${base}/docs`}>All docs</Link>
          </div>
          {recentDocs.length === 0 ? (
            <p className="muted">No docs yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {recentDocs.map((doc) => (
                <li key={doc.id}>
                  <Link className="hover:underline" href={`${base}/docs/${doc.id}`}>{doc.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!myTasks && !recentDocs && (
        <p className="muted">The pages your role includes are not available in this version yet.</p>
      )}
    </div>
  );
}
