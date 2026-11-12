-- Phase 1 modules: Tasks and projects, Docs and files, notifications.
-- Every table carries workspace_id and uses the same four-line policy shape:
--   select = view, insert/update = edit, delete = manage, on the table's page.

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '',
  archived boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create index projects_workspace_idx on public.projects (workspace_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  description text not null default '',
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  assignee_id uuid,
  due_date date,
  recurrence text not null default 'none' check (recurrence in ('none', 'daily', 'weekly', 'monthly')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (id, workspace_id),
  -- Project and assignee must belong to the same workspace as the task.
  foreign key (project_id, workspace_id) references public.projects (id, workspace_id)
    on delete set null (project_id),
  foreign key (workspace_id, assignee_id) references public.memberships (workspace_id, user_id)
    on delete set null (assignee_id)
);
create index tasks_workspace_idx on public.tasks (workspace_id, status);
create index tasks_assignee_idx on public.tasks (workspace_id, assignee_id);

create table public.task_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  task_id uuid not null,
  author_id uuid references public.profiles (id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 10000),
  created_at timestamptz not null default now(),
  foreign key (task_id, workspace_id) references public.tasks (id, workspace_id) on delete cascade
);
create index task_comments_task_idx on public.task_comments (workspace_id, task_id);

create table public.task_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  -- [{ "title": "...", "description": "...", "due_in_days": 3 }]
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index task_templates_workspace_idx on public.task_templates (workspace_id);

-- ---------------------------------------------------------------------------
-- Docs and files
-- ---------------------------------------------------------------------------

create table public.docs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  parent_id uuid,
  kind text not null default 'doc' check (kind in ('doc', 'wiki', 'sop')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  content text not null default '',
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  check (parent_id is null or parent_id <> id),
  foreign key (parent_id, workspace_id) references public.docs (id, workspace_id)
    on delete set null (parent_id)
);
create index docs_workspace_idx on public.docs (workspace_id, parent_id);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  doc_id uuid,
  name text not null check (char_length(name) between 1 and 255),
  -- "<workspace_id>/<file_id>/<name>" inside the private workspace-files bucket.
  storage_path text not null unique,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  mime_type text not null default 'application/octet-stream',
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (storage_path like workspace_id::text || '/%'),
  foreign key (doc_id, workspace_id) references public.docs (id, workspace_id)
    on delete set null (doc_id)
);
create index files_workspace_idx on public.files (workspace_id, doc_id);

-- ---------------------------------------------------------------------------
-- Notifications (written only by triggers)
-- ---------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  title text not null,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, read_at, created_at desc);

-- ---------------------------------------------------------------------------
-- Housekeeping triggers
-- ---------------------------------------------------------------------------

create function public.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
create trigger touch_tasks before update on public.tasks
  for each row execute function public.touch_updated_at();
create trigger touch_docs before update on public.docs
  for each row execute function public.touch_updated_at();

-- workspace_id never changes on a module row (blocks "moving" data across tenants).
create function public.guard_workspace_id() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id <> old.workspace_id then
    raise exception 'workspace_id is immutable' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger guard_ws_projects before update on public.projects
  for each row execute function public.guard_workspace_id();
create trigger guard_ws_tasks before update on public.tasks
  for each row execute function public.guard_workspace_id();
create trigger guard_ws_task_comments before update on public.task_comments
  for each row execute function public.guard_workspace_id();
create trigger guard_ws_task_templates before update on public.task_templates
  for each row execute function public.guard_workspace_id();
create trigger guard_ws_docs before update on public.docs
  for each row execute function public.guard_workspace_id();
create trigger guard_ws_files before update on public.files
  for each row execute function public.guard_workspace_id();
create trigger guard_ws_notifications before update on public.notifications
  for each row execute function public.guard_workspace_id();

-- ---------------------------------------------------------------------------
-- Notification triggers
-- ---------------------------------------------------------------------------

create function public.notify_task_assigned() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- Only notify someone who may see tasks: the title must not leak to a member
  -- whose role does not include the Tasks page.
  if new.assignee_id is not null
     and new.assignee_id is distinct from auth.uid()
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and public.access_level_for(new.assignee_id, new.workspace_id, 'tasks') >= 'view' then
    insert into public.notifications (workspace_id, user_id, kind, title, link)
    values (new.workspace_id, new.assignee_id, 'task.assigned',
            'You were assigned: ' || left(new.title, 120),
            '/w/' || new.workspace_id || '/tasks/' || new.id);
  end if;
  return null;
end
$$;
create trigger notify_task_assigned after insert or update on public.tasks
  for each row execute function public.notify_task_assigned();

create function public.notify_task_comment() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype;
begin
  select * into v_task from public.tasks where id = new.task_id;
  insert into public.notifications (workspace_id, user_id, kind, title, link)
  select new.workspace_id, u, 'task.comment',
         'New comment on: ' || left(v_task.title, 120),
         '/w/' || new.workspace_id || '/tasks/' || new.task_id
  from (select distinct u from unnest(array[v_task.assignee_id, v_task.created_by]) as u) s
  where u is not null and u is distinct from new.author_id
    and public.access_level_for(u, new.workspace_id, 'tasks') >= 'view';
  return null;
end
$$;
create trigger notify_task_comment after insert on public.task_comments
  for each row execute function public.notify_task_comment();

create function public.notify_role_change() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.role_id is distinct from old.role_id and new.user_id is distinct from auth.uid() then
    insert into public.notifications (workspace_id, user_id, kind, title, link)
    values (new.workspace_id, new.user_id, 'role.changed',
            case when new.role_id is null then 'Your access to this workspace was removed'
                 else 'Your role in this workspace changed' end,
            '/w/' || new.workspace_id);
  end if;
  return null;
end
$$;
create trigger notify_role_change after update on public.memberships
  for each row execute function public.notify_role_change();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_comments enable row level security;
alter table public.task_templates enable row level security;
alter table public.docs enable row level security;
alter table public.files enable row level security;
alter table public.notifications enable row level security;

-- projects
create policy projects_select on public.projects for select to authenticated
  using (public.access_level(workspace_id, 'tasks') >= 'view');
create policy projects_insert on public.projects for insert to authenticated
  with check (public.access_level(workspace_id, 'tasks') >= 'edit' and created_by = auth.uid());
create policy projects_update on public.projects for update to authenticated
  using (public.access_level(workspace_id, 'tasks') >= 'edit')
  with check (public.access_level(workspace_id, 'tasks') >= 'edit');
create policy projects_delete on public.projects for delete to authenticated
  using (public.access_level(workspace_id, 'tasks') >= 'manage');

-- tasks
create policy tasks_select on public.tasks for select to authenticated
  using (public.access_level(workspace_id, 'tasks') >= 'view');
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.access_level(workspace_id, 'tasks') >= 'edit' and created_by = auth.uid());
create policy tasks_update on public.tasks for update to authenticated
  using (public.access_level(workspace_id, 'tasks') >= 'edit')
  with check (public.access_level(workspace_id, 'tasks') >= 'edit');
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.access_level(workspace_id, 'tasks') >= 'manage');

-- task comments: append with edit; remove your own with edit, anyone's with manage.
create policy task_comments_select on public.task_comments for select to authenticated
  using (public.access_level(workspace_id, 'tasks') >= 'view');
create policy task_comments_insert on public.task_comments for insert to authenticated
  with check (public.access_level(workspace_id, 'tasks') >= 'edit' and author_id = auth.uid());
create policy task_comments_delete on public.task_comments for delete to authenticated
  using (
    public.access_level(workspace_id, 'tasks') >= 'manage'
    or (public.access_level(workspace_id, 'tasks') >= 'edit' and author_id = auth.uid())
  );

-- task templates
create policy task_templates_select on public.task_templates for select to authenticated
  using (public.access_level(workspace_id, 'tasks') >= 'view');
create policy task_templates_insert on public.task_templates for insert to authenticated
  with check (public.access_level(workspace_id, 'tasks') >= 'edit' and created_by = auth.uid());
create policy task_templates_update on public.task_templates for update to authenticated
  using (public.access_level(workspace_id, 'tasks') >= 'edit')
  with check (public.access_level(workspace_id, 'tasks') >= 'edit');
create policy task_templates_delete on public.task_templates for delete to authenticated
  using (public.access_level(workspace_id, 'tasks') >= 'manage');

-- docs
create policy docs_select on public.docs for select to authenticated
  using (public.access_level(workspace_id, 'docs') >= 'view');
create policy docs_insert on public.docs for insert to authenticated
  with check (public.access_level(workspace_id, 'docs') >= 'edit' and created_by = auth.uid());
create policy docs_update on public.docs for update to authenticated
  using (public.access_level(workspace_id, 'docs') >= 'edit')
  with check (public.access_level(workspace_id, 'docs') >= 'edit');
create policy docs_delete on public.docs for delete to authenticated
  using (public.access_level(workspace_id, 'docs') >= 'manage');

-- files (metadata rows)
create policy files_select on public.files for select to authenticated
  using (public.access_level(workspace_id, 'docs') >= 'view');
create policy files_insert on public.files for insert to authenticated
  with check (public.access_level(workspace_id, 'docs') >= 'edit' and uploaded_by = auth.uid());
create policy files_delete on public.files for delete to authenticated
  using (public.access_level(workspace_id, 'docs') >= 'manage');

-- notifications: strictly your own, and only while you are still a member.
-- Task notifications carry a task title, so they also need Tasks view at read
-- time (covers someone whose role was reduced after the notification was written).
create policy notifications_select on public.notifications for select to authenticated
  using (
    user_id = auth.uid() and public.is_member(workspace_id)
    and (kind not like 'task.%' or public.access_level(workspace_id, 'tasks') >= 'view')
  );
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid() and public.is_member(workspace_id))
  with check (user_id = auth.uid());
create policy notifications_delete on public.notifications for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- File storage: one private bucket, first path segment = workspace id.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('workspace-files', 'workspace-files', false, 26214400)
on conflict (id) do nothing;

-- Workspace id from an object path; NULL (so: denied) if it is not a uuid.
create function public.storage_workspace(p_name text) returns uuid
language plpgsql immutable
set search_path = ''
as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end
$$;

create policy workspace_files_select on storage.objects for select to authenticated
  using (bucket_id = 'workspace-files'
         and public.access_level(public.storage_workspace(name), 'docs') >= 'view');
create policy workspace_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'workspace-files'
              and public.access_level(public.storage_workspace(name), 'docs') >= 'edit');
create policy workspace_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'workspace-files'
         and public.access_level(public.storage_workspace(name), 'docs') >= 'manage');

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on all functions in schema public from public, anon;
revoke execute on function
  public.touch_updated_at(), public.guard_workspace_id(), public.notify_task_assigned(),
  public.notify_task_comment(), public.notify_role_change()
from authenticated;

grant select, insert, update, delete on
  public.projects, public.tasks, public.task_templates, public.docs
to authenticated;
grant select, insert, delete on public.task_comments, public.files to authenticated;
grant select, update, delete on public.notifications to authenticated;
grant execute on function public.storage_workspace(text) to authenticated;
