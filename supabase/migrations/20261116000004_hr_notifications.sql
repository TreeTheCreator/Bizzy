-- HR notifications: tell the people who can decide when time off is requested,
-- and tell the person and whoever asked when it is decided.
--
-- Like every notification, these are written only by triggers. A title never
-- says what kind of leave it is (sick leave is personal).
--
-- Kinds:
--   hr.leave_requested  to everyone who can decide (HR manage), except the asker
--   hr.leave_decided    to whoever filed the request, if it was not for themselves
--   me.leave_decided    to the person the time off is for, if they are a member
--
-- "hr.%" titles carry someone else's name and dates, so reading them needs HR
-- view at read time (see the policy below). "me.%" is about the reader's own
-- time off and needs only membership.

create function public.leave_dates(p_start date, p_end date) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_start = p_end then to_char(p_start, 'FMDD Mon YYYY')
    else to_char(p_start, 'FMDD Mon YYYY') || ' to ' || to_char(p_end, 'FMDD Mon YYYY')
  end
$$;

create function public.notify_leave() returns trigger
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
      and public.access_level_for(m.user_id, new.workspace_id, 'hr') >= 'manage';
    return null;
  end if;

  if new.status = old.status or new.status = 'pending' then
    return null;
  end if;

  -- The person themselves. They may have no HR access at all: the title is
  -- about their own time off, and the link is only added if they can open HR.
  if v_person.user_id is not null and v_person.user_id is distinct from v_actor then
    insert into public.notifications (workspace_id, user_id, kind, title, link)
    values (new.workspace_id, v_person.user_id, 'me.leave_decided',
            'Your time off (' || v_dates || ') was ' || new.status,
            case when public.access_level_for(v_person.user_id, new.workspace_id, 'hr') >= 'view' then v_link end);
  end if;

  -- Whoever filed it, when that is someone else.
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
create trigger notify_leave after insert or update on public.leave_requests
  for each row execute function public.notify_leave();

-- Reading: as before, plus HR view for "hr.%" (covers someone whose role was
-- reduced after the notification was written).
drop policy notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (
    user_id = auth.uid() and public.is_member(workspace_id)
    and (kind not like 'task.%' or public.access_level(workspace_id, 'tasks') >= 'view')
    and (kind not like 'hr.%' or public.access_level(workspace_id, 'hr') >= 'view')
  );

revoke all on all functions in schema public from public, anon;
revoke execute on function public.notify_leave(), public.leave_dates(date, date) from authenticated;
