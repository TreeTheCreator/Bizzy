import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
import { authorize } from "@/server/authz/authorize";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { listPeople } from "@/server/modules/members/service";
import { getTask, listProjects } from "@/server/modules/tasks/service";
import { addCommentAction, deleteCommentAction, deleteTaskAction, updateTaskAction } from "../actions";
import { STATUS_LABELS, TaskFields } from "../task-fields";

export const metadata: Metadata = { title: "Task" };

export default async function TaskPage({
  params,
}: {
  params: Promise<{ workspaceId: string; taskId: string }>;
}) {
  const { workspaceId, taskId } = await params;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const access = await authorize(ctx, workspaceId, "tasks", "view");
    const [{ task, comments }, projects, people] = await Promise.all([
      getTask(ctx, workspaceId, taskId),
      listProjects(ctx, workspaceId),
      listPeople(ctx, workspaceId),
    ]);
    return { access, task, comments, projects, people };
  });
  if (loaded.denied) return <NoAccess what="Tasks" />;
  const { access, task, comments, projects, people } = loaded.data;
  const canEdit = atLeast(access.levels.tasks, "edit");
  const canManage = atLeast(access.levels.tasks, "manage");
  const personName = (userId: string | null) => people.find((p) => p.user_id === userId)?.display_name ?? "Former member";

  return (
    <div className="max-w-3xl">
      <p className="mb-3 text-sm">
        <Link className="text-accent underline" href={`/w/${workspaceId}/tasks`}>← Tasks</Link>
      </p>

      {canEdit ? (
        <section className="card mb-6">
          <ActionForm action={updateTaskAction.bind(null, workspaceId, taskId)} successMessage="Saved.">
            <TaskFields task={task} projects={projects} people={people} />
            <button className="btn btn-primary mt-3" type="submit">Save changes</button>
          </ActionForm>
          {task.recurrence !== "none" && (
            <p className="muted mt-2">Marking this done creates the next {task.recurrence} occurrence.</p>
          )}
        </section>
      ) : (
        <section className="card mb-6">
          <h1 className="h1 mb-2">{task.title}</h1>
          <p className="muted mb-3">
            {[STATUS_LABELS[task.status], task.assignee_id && personName(task.assignee_id), task.due_date && `due ${task.due_date}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="whitespace-pre-wrap text-sm">{task.description || "No description."}</p>
        </section>
      )}

      <section className="card mb-6">
        <h2 className="h2 mb-3">Comments</h2>
        {comments.length === 0 && <p className="muted">No comments yet.</p>}
        <ul className="space-y-3">
          {comments.map((comment) => (
            <li key={comment.id} className="border-b border-border pb-3 last:border-b-0">
              <div className="flex items-center justify-between gap-2 text-xs text-muted">
                <span>
                  {personName(comment.author_id)} · {comment.created_at.slice(0, 16).replace("T", " ")} UTC
                </span>
                {(canManage || (canEdit && comment.author_id === ctx.userId)) && (
                  <ActionForm action={deleteCommentAction.bind(null, workspaceId)}>
                    <input type="hidden" name="commentId" value={comment.id} />
                    <button className="btn btn-sm" type="submit">Delete</button>
                  </ActionForm>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm">{comment.body}</p>
            </li>
          ))}
        </ul>
        {canEdit && (
          <ActionForm action={addCommentAction.bind(null, workspaceId, taskId)} className="mt-4">
            <textarea className="input min-h-20" name="body" aria-label="Add a comment" placeholder="Add a comment" required maxLength={10000} />
            <button className="btn mt-2" type="submit">Comment</button>
          </ActionForm>
        )}
      </section>

      {canManage && (
        <ActionForm action={deleteTaskAction.bind(null, workspaceId, taskId)}>
          <button className="btn btn-danger" type="submit">Delete task</button>
        </ActionForm>
      )}
    </div>
  );
}
