import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { AutoSelect, ConfirmButton, ModalButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { EmptyState, PageHeader, Tabs } from "@/components/ui";
import { dueLabel, humanize, pillClass, todayIso } from "@/lib/format";
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
  const today = todayIso();
  const mine = query.assignee === "me";
  const filtered = Boolean(query.project || mine);
  const openProjects = projects.filter((p) => !p.archived);

  const link = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, ...changes })) if (v) next.set(k, v);
    const qs = next.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const newTask = (label: string) => (
    <ModalButton label={label} title="New task" icon="plus">
      <ActionForm action={createTaskAction.bind(null, workspaceId)}>
        <TaskFields projects={projects} people={people} defaultProjectId={query.project} />
        <button className="btn btn-primary mt-5 w-full sm:w-auto" type="submit">Add task</button>
      </ActionForm>
    </ModalButton>
  );

  const taskRow = (task: Task, withStatus: boolean) => {
    const done = task.status === "done";
    const due = done ? null : dueLabel(task.due_date, today);
    const details = [
      personName(task.assignee_id),
      projectName(task.project_id),
      !withStatus && task.status === "in_progress" && "In progress",
      task.priority !== "normal" && `${humanize(task.priority)} priority`,
      task.recurrence !== "none" && `Repeats ${task.recurrence}`,
    ].filter(Boolean);
    return (
      <li key={task.id} className="row">
        {canEdit && (
          <ActionForm action={setTaskStatusAction.bind(null, workspaceId)}>
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="status" value={done ? "todo" : "done"} />
            <button
              type="submit"
              className="-m-2 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full"
              aria-label={done ? `Mark "${task.title}" as not done` : `Mark "${task.title}" as done`}
              title={done ? "Mark as not done" : "Mark as done"}
            >
              <span className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${done ? "border-ok bg-ok text-surface" : "border-muted hover:border-accent"}`}>
                {done && <Icon name="check" size={14} />}
              </span>
            </button>
          </ActionForm>
        )}
        <div className="min-w-0 flex-1">
          <Link className={`font-medium hover:underline ${done ? "text-muted line-through" : ""}`} href={`${base}/${task.id}`}>
            {task.title}
          </Link>
          {details.length > 0 && <div className="muted">{details.join(" · ")}</div>}
        </div>
        {due && <span className={pillClass(due.tone)}>{due.label}</span>}
        {withStatus && canEdit && (
          <ActionForm action={setTaskStatusAction.bind(null, workspaceId)} className="w-full">
            <input type="hidden" name="taskId" value={task.id} />
            <AutoSelect className="input min-h-9 py-1 text-[15px]" name="status" defaultValue={task.status} aria-label={`Move "${task.title}" to`}>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </AutoSelect>
          </ActionForm>
        )}
      </li>
    );
  };

  const projectChip = (active: boolean) =>
    `pill min-h-9 px-3 ${active ? "pill-info font-medium" : "border border-border bg-surface"}`;

  return (
    <div className="max-w-5xl">
      <PageHeader title="Tasks">{canEdit && newTask("New task")}</PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs
          label="Layout"
          items={[
            { href: link({ view: undefined }), label: "List", active: !board },
            { href: link({ view: "board" }), label: "Board", active: board },
          ]}
        />
        <Tabs
          label="Whose tasks"
          items={[
            { href: link({ assignee: undefined }), label: "Everyone's", active: !mine },
            { href: link({ assignee: "me" }), label: "Mine", active: mine },
          ]}
        />
      </div>

      {openProjects.length > 0 && (
        <nav aria-label="Project" className="mb-4 flex flex-wrap items-center gap-2">
          <span className="muted">Project:</span>
          <Link className={projectChip(!query.project)} href={link({ project: undefined })}>All</Link>
          {openProjects.map((p) => (
            <Link key={p.id} className={projectChip(query.project === p.id)} href={link({ project: p.id })}>
              {p.name}
            </Link>
          ))}
        </nav>
      )}

      {board ? (
        <div className="grid items-start gap-4 md:grid-cols-3">
          {TASK_STATUSES.map((status) => {
            const column = tasks.filter((t) => t.status === status);
            return (
              <section key={status} className="card" aria-label={STATUS_LABELS[status]}>
                <h2 className="h2 mb-3">
                  {STATUS_LABELS[status]} <span className="font-normal text-muted">{column.length}</span>
                </h2>
                {column.length === 0 ? <p className="muted">Nothing here.</p> : <ul>{column.map((task) => taskRow(task, true))}</ul>}
              </section>
            );
          })}
        </div>
      ) : tasks.length === 0 ? (
        filtered || showDone ? (
          <div className="card">
            <p className="muted">No tasks match what you picked above.</p>
          </div>
        ) : (
          <EmptyState
            icon="tasks"
            title={canEdit ? "Add your first task" : "No tasks to do"}
            body="Write down what needs doing, who will do it and by when. Tick it off when it's done."
          >
            {canEdit && newTask("Add a task")}
          </EmptyState>
        )
      ) : (
        <section className="card">
          <ul>{tasks.map((task) => taskRow(task, false))}</ul>
        </section>
      )}

      {!board && (
        <p className="mt-3">
          <Link className="link text-[15px]" href={link({ done: showDone ? undefined : "1" })}>
            {showDone ? "Hide finished tasks" : "Show finished tasks too"}
          </Link>
        </p>
      )}

      <div className="mt-8 grid items-start gap-4 md:grid-cols-2">
        <details className="card">
          <summary className="cursor-pointer font-semibold">Projects ({projects.length})</summary>
          <p className="muted mt-2">A project groups tasks that belong together, like &ldquo;Shop opening&rdquo;.</p>
          <ul className="mt-3">
            {projects.map((p) => (
              <li key={p.id} className="row">
                <span className={`min-w-0 flex-1 ${p.archived ? "text-muted" : ""}`}>{p.name}{p.archived && " (put away)"}</span>
                <span className="flex gap-2">
                  {canEdit && (
                    <ActionForm action={archiveProjectAction.bind(null, workspaceId)}>
                      <input type="hidden" name="projectId" value={p.id} />
                      <input type="hidden" name="archived" value={String(!p.archived)} />
                      <button className="btn btn-sm" type="submit">{p.archived ? "Bring back" : "Put away"}</button>
                    </ActionForm>
                  )}
                  {canManage && (
                    <ActionForm action={deleteProjectAction.bind(null, workspaceId)}>
                      <input type="hidden" name="projectId" value={p.id} />
                      <ConfirmButton
                        className="btn btn-sm btn-danger"
                        title={`Delete the project "${p.name}"?`}
                        message="The project is removed for good. You can't undo this."
                        confirmLabel="Delete project"
                      >
                        Delete
                      </ConfirmButton>
                    </ActionForm>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {canEdit && (
            <ActionForm action={createProjectAction.bind(null, workspaceId)} className="mt-4 flex flex-wrap gap-2">
              <input className="input min-w-40 flex-1" name="name" placeholder="New project name" aria-label="New project name" required maxLength={120} />
              <button className="btn" type="submit">Add project</button>
            </ActionForm>
          )}
        </details>

        <details className="card">
          <summary className="cursor-pointer font-semibold">Ready-made task lists ({templates.length})</summary>
          <p className="muted mt-2">Save a list of tasks you repeat often, then add them all in one click.</p>
          <ul className="mt-3">
            {templates.map((t) => (
              <li key={t.id} className="row">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{t.name}</div>
                  <div className="muted">{t.items.length} {t.items.length === 1 ? "task" : "tasks"}</div>
                </div>
                <span className="flex gap-2">
                  {canEdit && (
                    <ActionForm action={applyTemplateAction.bind(null, workspaceId)}>
                      <input type="hidden" name="templateId" value={t.id} />
                      <input type="hidden" name="projectId" value={query.project ?? ""} />
                      <button className="btn btn-sm" type="submit">Add these tasks</button>
                    </ActionForm>
                  )}
                  {canManage && (
                    <ActionForm action={deleteTemplateAction.bind(null, workspaceId)}>
                      <input type="hidden" name="templateId" value={t.id} />
                      <ConfirmButton
                        className="btn btn-sm btn-danger"
                        title={`Delete the list "${t.name}"?`}
                        message="Tasks already added from it stay. The saved list is removed for good."
                        confirmLabel="Delete list"
                      >
                        Delete
                      </ConfirmButton>
                    </ActionForm>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {canEdit && (
            <ActionForm action={createTemplateAction.bind(null, workspaceId)} className="mt-4 space-y-3" successMessage="List saved.">
              <div>
                <label className="label" htmlFor="template-name">Name of the list</label>
                <input className="input" id="template-name" name="name" placeholder="New customer welcome" required maxLength={120} />
              </div>
              <div>
                <label className="label" htmlFor="template-items">Tasks, one per line</label>
                <textarea className="input min-h-24" id="template-items" name="items" placeholder={"Send welcome email\nBook first call | 3"} required />
                <p className="muted mt-1">To set a due date, end the line with | and a number of days, like &ldquo;Book first call | 3&rdquo;.</p>
              </div>
              <button className="btn" type="submit">Save list</button>
            </ActionForm>
          )}
        </details>
      </div>
    </div>
  );
}
