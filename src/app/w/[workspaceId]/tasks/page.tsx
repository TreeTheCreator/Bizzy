import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
import { authorize } from "@/server/authz/authorize";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { listPeople } from "@/server/modules/members/service";
import { type Task, TASK_STATUSES, listProjects, listTasks, listTemplates } from "@/server/modules/tasks/service";
import {
  applyTemplateAction,
  archiveProjectAction,
  createProjectAction,
  createTaskAction,
  createTemplateAction,
  deleteProjectAction,
  deleteTemplateAction,
  setTaskStatusAction,
} from "./actions";
import { STATUS_LABELS, TaskFields } from "./task-fields";

export const metadata: Metadata = { title: "Tasks" };

export default async function TasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ view?: string; project?: string; assignee?: string; done?: string }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const ctx = await getWebCtx();
  const board = query.view === "board";
  const showDone = query.done === "1" || board;

  const loaded = await tryLoad(async () => {
    const access = await authorize(ctx, workspaceId, "tasks", "view");
    const [tasks, projects, templates, people] = await Promise.all([
      listTasks(ctx, workspaceId, {
        projectId: query.project || null,
        assigneeId: query.assignee === "me" ? ctx.userId : null,
        openOnly: !showDone,
      }),
      listProjects(ctx, workspaceId),
      listTemplates(ctx, workspaceId),
      listPeople(ctx, workspaceId),
    ]);
    return { access, tasks, projects, templates, people };
  });
  if (loaded.denied) return <NoAccess what="Tasks" />;
  const { access, tasks, projects, templates, people } = loaded.data;
  const canEdit = atLeast(access.levels.tasks, "edit");
  const canManage = atLeast(access.levels.tasks, "manage");
  const base = `/w/${workspaceId}/tasks`;
  const personName = (userId: string | null) => people.find((p) => p.user_id === userId)?.display_name ?? "";
  const projectName = (projectId: string | null) => projects.find((p) => p.id === projectId)?.name ?? "";

  const link = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, ...changes })) if (v) next.set(k, v);
    const qs = next.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const TaskRow = ({ task }: { task: Task }) => (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0">
        <Link className={`font-medium hover:underline ${task.status === "done" ? "text-muted line-through" : ""}`} href={`${base}/${task.id}`}>
          {task.title}
        </Link>
        <div className="text-xs text-muted">
          {[projectName(task.project_id), personName(task.assignee_id), task.due_date && `due ${task.due_date}`, task.priority !== "normal" && `${task.priority} priority`, task.recurrence !== "none" && `repeats ${task.recurrence}`]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      {canEdit && (
        <ActionForm action={setTaskStatusAction.bind(null, workspaceId)} className="flex items-center gap-1">
          <input type="hidden" name="taskId" value={task.id} />
          <select className="input w-32 py-1 text-xs" name="status" defaultValue={task.status} aria-label={`Status of ${task.title}`}>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
          <button className="btn btn-sm" type="submit">Set</button>
        </ActionForm>
      )}
    </li>
  );

  return (
    <div className="max-w-5xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">Tasks</h1>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link className={`btn btn-sm ${!board ? "btn-primary" : ""}`} href={link({ view: undefined })}>List</Link>
          <Link className={`btn btn-sm ${board ? "btn-primary" : ""}`} href={link({ view: "board" })}>Board</Link>
          <Link className={`btn btn-sm ${query.assignee === "me" ? "btn-primary" : ""}`} href={link({ assignee: query.assignee === "me" ? undefined : "me" })}>
            Mine
          </Link>
          {!board && (
            <Link className={`btn btn-sm ${showDone ? "btn-primary" : ""}`} href={link({ done: showDone ? undefined : "1" })}>
              Show done
            </Link>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <Link className={`badge ${!query.project ? "border-accent text-accent" : ""}`} href={link({ project: undefined })}>All projects</Link>
        {projects.filter((p) => !p.archived).map((p) => (
          <Link key={p.id} className={`badge ${query.project === p.id ? "border-accent text-accent" : ""}`} href={link({ project: p.id })}>
            {p.name}
          </Link>
        ))}
      </div>

      {canEdit && (
        <details className="card mb-4">
          <summary className="cursor-pointer font-medium">New task</summary>
          <ActionForm action={createTaskAction.bind(null, workspaceId)} className="mt-3" successMessage="Task created.">
            <TaskFields projects={projects} people={people} defaultProjectId={query.project} />
            <button className="btn btn-primary mt-3" type="submit">Create task</button>
          </ActionForm>
        </details>
      )}

      {board ? (
        <div className="grid gap-4 md:grid-cols-3">
          {TASK_STATUSES.map((status) => {
            const column = tasks.filter((t) => t.status === status);
            return (
              <section key={status} className="card" aria-label={STATUS_LABELS[status]}>
                <h2 className="h2 mb-2">
                  {STATUS_LABELS[status]} <span className="text-muted">({column.length})</span>
                </h2>
                <ul>{column.map((task) => <TaskRow key={task.id} task={task} />)}</ul>
              </section>
            );
          })}
        </div>
      ) : (
        <section className="card">
          {tasks.length === 0 ? (
            <p className="muted">No tasks here{canEdit ? ". Create the first one above." : "."}</p>
          ) : (
            <ul>{tasks.map((task) => <TaskRow key={task.id} task={task} />)}</ul>
          )}
        </section>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <details className="card">
          <summary className="cursor-pointer font-medium">Projects ({projects.length})</summary>
          <ul className="mt-3 space-y-2 text-sm">
            {projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className={p.archived ? "text-muted" : ""}>{p.name}{p.archived && " (archived)"}</span>
                <span className="flex gap-1">
                  {canEdit && (
                    <ActionForm action={archiveProjectAction.bind(null, workspaceId)}>
                      <input type="hidden" name="projectId" value={p.id} />
                      <input type="hidden" name="archived" value={String(!p.archived)} />
                      <button className="btn btn-sm" type="submit">{p.archived ? "Restore" : "Archive"}</button>
                    </ActionForm>
                  )}
                  {canManage && (
                    <ActionForm action={deleteProjectAction.bind(null, workspaceId)}>
                      <input type="hidden" name="projectId" value={p.id} />
                      <button className="btn btn-sm btn-danger" type="submit">Delete</button>
                    </ActionForm>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {canEdit && (
            <ActionForm action={createProjectAction.bind(null, workspaceId)} className="mt-3 flex gap-2">
              <input className="input" name="name" placeholder="New project name" aria-label="New project name" required maxLength={120} />
              <button className="btn" type="submit">Add</button>
            </ActionForm>
          )}
        </details>

        <details className="card">
          <summary className="cursor-pointer font-medium">Templates ({templates.length})</summary>
          <ul className="mt-3 space-y-3 text-sm">
            {templates.map((t) => (
              <li key={t.id}>
                <div className="font-medium">{t.name} <span className="text-muted">· {t.items.length} tasks</span></div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {canEdit && (
                    <ActionForm action={applyTemplateAction.bind(null, workspaceId)}>
                      <input type="hidden" name="templateId" value={t.id} />
                      <input type="hidden" name="projectId" value={query.project ?? ""} />
                      <button className="btn btn-sm" type="submit">Use template</button>
                    </ActionForm>
                  )}
                  {canManage && (
                    <ActionForm action={deleteTemplateAction.bind(null, workspaceId)}>
                      <input type="hidden" name="templateId" value={t.id} />
                      <button className="btn btn-sm btn-danger" type="submit">Delete</button>
                    </ActionForm>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {canEdit && (
            <ActionForm action={createTemplateAction.bind(null, workspaceId)} className="mt-3 space-y-2" successMessage="Template saved.">
              <input className="input" name="name" placeholder="Template name" aria-label="Template name" required maxLength={120} />
              <textarea className="input min-h-24" name="items" aria-label="Template tasks" placeholder={"One task per line.\nAdd \"| 3\" for due in 3 days:\nSend welcome email | 1"} required />
              <button className="btn" type="submit">Save template</button>
            </ActionForm>
          )}
        </details>
      </div>
    </div>
  );
}
