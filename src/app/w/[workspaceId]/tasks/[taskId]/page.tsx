import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { ConfirmButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { BackLink } from "@/components/ui";
import { formatDate } from "@/lib/format";
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
      <BackLink href={`/w/${workspaceId}/tasks`}>Back to tasks</BackLink>

      {canEdit ? (
        <section className="card mb-6">
          <h1 className="h1 mb-4">Task</h1>
          <ActionForm action={updateTaskAction.bind(null, workspaceId, taskId)} successMessage="Saved.">
            <TaskFields task={task} projects={projects} people={people} />
            <button className="btn btn-primary mt-5" type="submit">Save changes</button>
          </ActionForm>
          {task.recurrence !== "none" && (
            <p className="muted mt-3">This task repeats. When you mark it done, the next one is created for you.</p>
          )}
        </section>
      ) : (
        <section className="card mb-6">
          <h1 className="h1 mb-2">{task.title}</h1>
          <p className="muted mb-3">
            {[STATUS_LABELS[task.status], task.assignee_id && personName(task.assignee_id), task.due_date && `Due ${formatDate(task.due_date)}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="whitespace-pre-wrap">{task.description || "No details were added."}</p>
        </section>
      )}

      <section className="card mb-6">
        <h2 className="h2 mb-3">Comments</h2>
        {comments.length === 0 && <p className="muted">No comments yet.</p>}
        <ul>
          {comments.map((comment) => (
            <li key={comment.id} className="row items-start">
              <div className="min-w-0 flex-1">
                <div className="muted">
                  <span className="font-medium text-text">{personName(comment.author_id)}</span> · <LocalTime iso={comment.created_at} />
                </div>
                <p className="mt-1 whitespace-pre-wrap">{comment.body}</p>
              </div>
              {(canManage || (canEdit && comment.author_id === ctx.userId)) && (
                <ActionForm action={deleteCommentAction.bind(null, workspaceId)}>
                  <input type="hidden" name="commentId" value={comment.id} />
                  <ConfirmButton
                    className="btn btn-sm btn-ghost"
                    title="Delete this comment?"
                    message="The comment is removed for good. You can't undo this."
                    confirmLabel="Delete comment"
                  >
                    Delete
                  </ConfirmButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <ActionForm action={addCommentAction.bind(null, workspaceId, taskId)} className="mt-4">
            <label className="label" htmlFor="new-comment">Add a comment</label>
            <textarea className="input min-h-20" id="new-comment" name="body" required maxLength={10000} />
            <button className="btn mt-3" type="submit">Post comment</button>
          </ActionForm>
        )}
      </section>

      {canManage && (
        <ActionForm action={deleteTaskAction.bind(null, workspaceId, taskId)}>
          <ConfirmButton
            title="Delete this task?"
            message={`"${task.title}" and its comments will be removed for good. You can't undo this.`}
            confirmLabel="Delete task"
          >
            Delete task
          </ConfirmButton>
        </ActionForm>
      )}
    </div>
  );
}
