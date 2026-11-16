-- Phase 3: the cross-workspace overview.
--
-- One call returns a headline summary of every workspace the caller may see a
-- dashboard for. Access is decided here, per workspace and per page, by the
-- same access_level() that row-level security uses:
--
--   * a workspace is listed only if the caller's level on "dashboard" is at
--     least view;
--   * inside it, a page's numbers are present only if the caller's level on
--     that page is at least view. Otherwise the key is null.
--
-- The function is SECURITY INVOKER, so row-level security still applies to
-- every table it reads: a mistake in the conditions below could hide numbers
-- but never reveal them. Tokens of AI apps and API keys get the same answer
-- their member would, narrowed by the connection and the workspace's AI policy,
-- because access_level() already applies both.

create function public.my_overview() returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(v.entry order by lower(v.name), v.id), '[]'::jsonb)
  from (
    select
      w.id,
      w.name,
      jsonb_build_object(
        'id', w.id,
        'name', w.name,
        'is_owner', w.owner_id = auth.uid(),
        'tasks', case when public.access_level(w.id, 'tasks') >= 'view' then (
          select jsonb_build_object(
            'open', count(*) filter (where t.status <> 'done'),
            'overdue', count(*) filter (where t.status <> 'done' and t.due_date < current_date),
            'mine', count(*) filter (where t.status <> 'done' and t.assignee_id = auth.uid())
          )
          from public.tasks t
          where t.workspace_id = w.id
        ) end,
        'crm', case when public.access_level(w.id, 'crm') >= 'view' then (
          select jsonb_build_object(
            'open_deals', count(*) filter (where s.kind = 'open'),
            'open_value', coalesce(sum(d.amount) filter (where s.kind = 'open'), 0),
            'won_this_month', coalesce(sum(d.amount) filter (
              where s.kind = 'won' and d.closed_at >= date_trunc('month', now())), 0)
          )
          from public.deals d
          join public.deal_stages s on s.id = d.stage_id and s.workspace_id = d.workspace_id
          where d.workspace_id = w.id
        ) end,
        'finance', case when public.access_level(w.id, 'finance') >= 'view' then jsonb_build_object(
          'unpaid', (
            select coalesce(sum(i.total), 0) from public.invoices i
            where i.workspace_id = w.id and i.status = 'sent'),
          'overdue', (
            select coalesce(sum(i.total), 0) from public.invoices i
            where i.workspace_id = w.id and i.status = 'sent' and i.due_date < current_date),
          'paid_this_month', (
            select coalesce(sum(i.total), 0) from public.invoices i
            where i.workspace_id = w.id and i.status = 'paid' and i.paid_at >= date_trunc('month', now())),
          'spent_this_month', (
            select coalesce(sum(e.amount), 0) from public.expenses e
            where e.workspace_id = w.id and e.spent_on >= date_trunc('month', now())::date)
        ) end
      ) as entry
    from public.workspaces w
    where public.access_level(w.id, 'dashboard') >= 'view'
  ) v
$$;

revoke all on all functions in schema public from public, anon;
grant execute on function public.my_overview() to authenticated;
