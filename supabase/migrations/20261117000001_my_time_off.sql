-- Self-service time off (plan step 3).
--
-- A member whose HR person record is linked to their account can see their
-- own time off, ask for more, and cancel a request that has not been answered
-- yet, without any HR access. They see only their own requests and only the
-- person's id and name, never the rest of the record (notes, contact details)
-- or anyone's pay.
--
-- Nobody can decide their own request, except the owner (who has no one to ask).

-- The caller's own person record in a workspace: only while they are a member
-- with a role (a member with no role sees nothing), never for an AI app's token
-- (those go through the AI tools and the workspace's AI policy), and only for
-- someone who still works there.
create function public.my_employee_id(p_workspace uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select e.id
  from public.employees e
  join public.memberships m on m.workspace_id = e.workspace_id and m.user_id = e.user_id
  where e.workspace_id = p_workspace
    and e.user_id = auth.uid()
    and e.status = 'active'
    and (m.expires_at is null or m.expires_at > now())
    and (m.role_id is not null or exists (
      select 1 from public.workspaces w where w.id = p_workspace and w.owner_id = auth.uid()))
    and not public.is_oauth_client()
$$;

-- What the "My time off" page needs about the caller's person record: id and name.
create function public.my_employee(p_workspace uuid) returns table (id uuid, full_name text)
language sql stable security definer
set search_path = ''
as $$
  select e.id, e.full_name from public.employees e
  where e.id = public.my_employee_id(p_workspace)
$$;

-- Requests: your own, in addition to what HR access already allows.
create policy leave_select_own on public.leave_requests for select to authenticated
  using (employee_id = public.my_employee_id(workspace_id));
create policy leave_insert_own on public.leave_requests for insert to authenticated
  with check (employee_id = public.my_employee_id(workspace_id) and created_by = auth.uid());
-- Cancel your own request, only while it is waiting for an answer.
create policy leave_delete_own on public.leave_requests for delete to authenticated
  using (employee_id = public.my_employee_id(workspace_id) and status = 'pending');

-- No deciding your own request (unless you are the owner). This is in the
-- trigger, not a policy, so it also holds for Full Access and HR manage.
create or replace function public.leave_before_write() returns trigger
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
    if exists (select 1 from public.employees e where e.id = new.employee_id and e.user_id = auth.uid())
       and not exists (select 1 from public.workspaces w where w.id = new.workspace_id and w.owner_id = auth.uid()) then
      raise exception 'you cannot decide your own time off' using errcode = '42501';
    end if;
    new.decided_by := case when new.status = 'pending' then null else auth.uid() end;
    new.decided_at := case when new.status = 'pending' then null else now() end;
  else
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  end if;
  return new;
end
$$;

-- Alerts: the answer to your own request now links to "My time off".
create or replace function public.notify_leave() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_person public.employees%rowtype;
  v_dates text := public.leave_dates(new.start_date, new.end_date);
  v_link text := '/w/' || new.workspace_id || '/hr?view=leave';
  v_actor uuid := auth.uid();
begin
  select * into v_person from public.employees where id = new.employee_id;

  if tg_op = 'INSERT' then
    insert into public.notifications (workspace_id, user_id, kind, title, link)
    select new.workspace_id, m.user_id, 'hr.leave_requested',
           'Time off requested for ' || left(v_person.full_name, 120) || ' (' || v_dates || ')',
           v_link
    from public.memberships m
    where m.workspace_id = new.workspace_id
      and m.user_id is distinct from v_actor
      and public.access_level_for(m.user_id, new.workspace_id, 'hr') >= 'manage'
      -- Not the person it is for: they cannot decide it (unless they are the owner).
      and (m.user_id is distinct from v_person.user_id
           or m.user_id = (select w.owner_id from public.workspaces w where w.id = new.workspace_id));
    return null;
  end if;

  if new.status = old.status or new.status = 'pending' then
    return null;
  end if;

  if v_person.user_id is not null and v_person.user_id is distinct from v_actor then
    insert into public.notifications (workspace_id, user_id, kind, title, link)
    values (new.workspace_id, v_person.user_id, 'me.leave_decided',
            'Your time off (' || v_dates || ') was ' || new.status,
            '/w/' || new.workspace_id || '/time-off');
  end if;

  if new.created_by is not null
     and new.created_by is distinct from v_actor
     and new.created_by is distinct from v_person.user_id
     and public.access_level_for(new.created_by, new.workspace_id, 'hr') >= 'view' then
    insert into public.notifications (workspace_id, user_id, kind, title, link)
    values (new.workspace_id, new.created_by, 'hr.leave_decided',
            'Time off for ' || left(v_person.full_name, 120) || ' (' || v_dates || ') was ' || new.status,
            v_link);
  end if;
  return null;
end
$$;

revoke all on all functions in schema public from public, anon;
grant execute on function public.my_employee_id(uuid), public.my_employee(uuid) to authenticated;
