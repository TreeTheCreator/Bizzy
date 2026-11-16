-- Phase 3: HR. People, their pay, and time off.
--
-- Pay is the first "sensitive" data in Bizzy. Row-level security works on
-- rows, not columns, so pay lives in its own table whose every policy also
-- requires can_see_sensitive(workspace, 'hr'): the "Private details" tick on
-- the role. A role can then open HR without seeing what anyone earns.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The Bizzy member this person is, if they have an account here. Optional.
  user_id uuid,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 200),
  job_title text not null default '' check (char_length(job_title) <= 200),
  email text not null default '' check (char_length(email) <= 320),
  phone text not null default '' check (char_length(phone) <= 60),
  start_date date,
  status text not null default 'active' check (status in ('active', 'left')),
  notes text not null default '' check (char_length(notes) <= 10000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, user_id),
  foreign key (workspace_id, user_id) references public.memberships (workspace_id, user_id)
    on delete set null (user_id)
);
create index employees_workspace_idx on public.employees (workspace_id, status, full_name);

-- One row per person, only for those whose pay has been entered.
create table public.employee_compensation (
  employee_id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  pay_amount numeric(14, 2) not null check (pay_amount >= 0),
  pay_period text not null default 'year' check (pay_period in ('hour', 'month', 'year')),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  foreign key (employee_id, workspace_id) references public.employees (id, workspace_id) on delete cascade
);
create index employee_compensation_workspace_idx on public.employee_compensation (workspace_id);

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  employee_id uuid not null,
  kind text not null default 'holiday' check (kind in ('holiday', 'sick', 'other')),
  start_date date not null,
  end_date date not null,
  note text not null default '' check (char_length(note) <= 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_by uuid references public.profiles (id) on delete set null,
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (end_date - start_date <= 366),
  foreign key (employee_id, workspace_id) references public.employees (id, workspace_id) on delete cascade
);
create index leave_requests_workspace_idx on public.leave_requests (workspace_id, status, start_date);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger touch_employees before update on public.employees
  for each row execute function public.touch_updated_at();

-- Pay: stamp who changed it and when, and record the change (never the amount)
-- in the audit log.
create function public.compensation_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end
$$;
create trigger compensation_before_write before insert or update on public.employee_compensation
  for each row execute function public.compensation_before_write();

create function public.compensation_audit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.employee_compensation := coalesce(new, old);
begin
  perform public.audit(v_row.workspace_id,
    case tg_op when 'DELETE' then 'hr.pay_removed' else 'hr.pay_changed' end,
    v_row.employee_id::text);
  return null;
end
$$;
create trigger compensation_audit after insert or update or delete on public.employee_compensation
  for each row execute function public.compensation_audit();

-- Time off: a request always starts as pending with no decision, whoever
-- writes it. Only the decision fields may change afterwards, and a decision is
-- stamped with who made it.
create function public.leave_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.decided_by := null;
    new.decided_at := null;
    return new;
  end if;
  if new.employee_id <> old.employee_id or new.kind <> old.kind or new.start_date <> old.start_date
     or new.end_date <> old.end_date or new.note <> old.note
     or new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
    raise exception 'a time-off request cannot be changed, only decided' using errcode = '42501';
  end if;
  if new.status <> old.status then
    new.decided_by := case when new.status = 'pending' then null else auth.uid() end;
    new.decided_at := case when new.status = 'pending' then null else now() end;
  else
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  end if;
  return new;
end
$$;
create trigger leave_before_write before insert or update on public.leave_requests
  for each row execute function public.leave_before_write();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['employees', 'employee_compensation', 'leave_requests'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.guard_workspace_id()',
      'guard_ws_' || t, t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;

-- People: view to read, edit to add and change, manage to delete.
create policy employees_select on public.employees for select to authenticated
  using (public.access_level(workspace_id, 'hr') >= 'view');
create policy employees_insert on public.employees for insert to authenticated
  with check (public.access_level(workspace_id, 'hr') >= 'edit' and created_by = auth.uid());
create policy employees_update on public.employees for update to authenticated
  using (public.access_level(workspace_id, 'hr') >= 'edit')
  with check (public.access_level(workspace_id, 'hr') >= 'edit');
create policy employees_delete on public.employees for delete to authenticated
  using (public.access_level(workspace_id, 'hr') >= 'manage');

-- Pay: the same levels, and always the "private details" flag as well.
create policy compensation_select on public.employee_compensation for select to authenticated
  using (public.access_level(workspace_id, 'hr') >= 'view' and public.can_see_sensitive(workspace_id, 'hr'));
create policy compensation_insert on public.employee_compensation for insert to authenticated
  with check (public.access_level(workspace_id, 'hr') >= 'edit' and public.can_see_sensitive(workspace_id, 'hr'));
create policy compensation_update on public.employee_compensation for update to authenticated
  using (public.access_level(workspace_id, 'hr') >= 'edit' and public.can_see_sensitive(workspace_id, 'hr'))
  with check (public.access_level(workspace_id, 'hr') >= 'edit' and public.can_see_sensitive(workspace_id, 'hr'));
create policy compensation_delete on public.employee_compensation for delete to authenticated
  using (public.access_level(workspace_id, 'hr') >= 'edit' and public.can_see_sensitive(workspace_id, 'hr'));

-- Time off: view to read, edit to ask, manage to decide or delete.
create policy leave_select on public.leave_requests for select to authenticated
  using (public.access_level(workspace_id, 'hr') >= 'view');
create policy leave_insert on public.leave_requests for insert to authenticated
  with check (public.access_level(workspace_id, 'hr') >= 'edit' and created_by = auth.uid());
create policy leave_update on public.leave_requests for update to authenticated
  using (public.access_level(workspace_id, 'hr') >= 'manage')
  with check (public.access_level(workspace_id, 'hr') >= 'manage');
create policy leave_delete on public.leave_requests for delete to authenticated
  using (public.access_level(workspace_id, 'hr') >= 'manage');

grant select, insert, update, delete on public.employees, public.employee_compensation, public.leave_requests
  to authenticated;

revoke all on all functions in schema public from public, anon;
revoke execute on function
  public.compensation_before_write(), public.compensation_audit(), public.leave_before_write()
from authenticated;
