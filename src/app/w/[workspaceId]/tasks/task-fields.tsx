import type { Person } from "@/server/modules/members/service";
import { type Project, type Task, RECURRENCES, TASK_PRIORITIES, TASK_STATUSES } from "@/server/modules/tasks/service";

export const STATUS_LABELS: Record<(typeof TASK_STATUSES)[number], string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

/** The shared field set for creating and editing a task. */
export function TaskFields({
  task,
  projects,
  people,
  defaultProjectId,
  compact = false,
}: {
  task?: Task;
  projects: Project[];
  people: Person[];
  defaultProjectId?: string;
  compact?: boolean;
}) {
  const key = task?.id ?? "new";
  return (
    <div className="space-y-3">
      <div>
        <label className="label" htmlFor={`title-${key}`}>Title</label>
        <input className="input" id={`title-${key}`} name="title" defaultValue={task?.title ?? ""} required maxLength={300} />
      </div>
      {!compact && (
        <div>
          <label className="label" htmlFor={`description-${key}`}>Description</label>
          <textarea className="input min-h-28" id={`description-${key}`} name="description" defaultValue={task?.description ?? ""} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div>
          <label className="label" htmlFor={`status-${key}`}>Status</label>
          <select className="input" id={`status-${key}`} name="status" defaultValue={task?.status ?? "todo"}>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`priority-${key}`}>Priority</label>
          <select className="input" id={`priority-${key}`} name="priority" defaultValue={task?.priority ?? "normal"}>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`assignee-${key}`}>Assignee</label>
          <select className="input" id={`assignee-${key}`} name="assigneeId" defaultValue={task?.assignee_id ?? ""}>
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p.user_id} value={p.user_id}>{p.display_name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`project-${key}`}>Project</label>
          <select className="input" id={`project-${key}`} name="projectId" defaultValue={task?.project_id ?? defaultProjectId ?? ""}>
            <option value="">No project</option>
            {projects
              .filter((p) => !p.archived || p.id === task?.project_id)
              .map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`due-${key}`}>Due date</label>
          <input className="input" type="date" id={`due-${key}`} name="dueDate" defaultValue={task?.due_date ?? ""} />
        </div>
        <div>
          <label className="label" htmlFor={`recurrence-${key}`}>Repeats</label>
          <select className="input" id={`recurrence-${key}`} name="recurrence" defaultValue={task?.recurrence ?? "none"}>
            {RECURRENCES.map((r) => (
              <option key={r} value={r}>{r === "none" ? "Does not repeat" : r}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
