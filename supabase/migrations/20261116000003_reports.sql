-- Phase 3: saved reports.
--
-- A report is a fixed question about one page's data ("spending by category").
-- Running one needs view on that page; the numbers are read under row-level
-- security like everything else. Saving one stores only its name, kind and
-- period, never any numbers.

-- Which page a kind of report draws on. Must match REPORTS in
-- src/server/modules/reports/service.ts. NULL (so: denied) for unknown kinds.
create function public.report_page(p_kind text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_kind
    when 'cash_flow' then 'finance'
    when 'spending_by_category' then 'finance'
    when 'deals_by_stage' then 'crm'
    when 'tasks_by_person' then 'tasks'
    when 'time_off_by_person' then 'hr'
  end
$$;

create table public.saved_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  kind text not null check (public.report_page(kind) is not null),
  period text not null check (period in ('this_month', 'last_month', 'this_year', 'last_12_months')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);
create index saved_reports_workspace_idx on public.saved_reports (workspace_id, name);

create trigger guard_ws_saved_reports before update on public.saved_reports
  for each row execute function public.guard_workspace_id();
alter table public.saved_reports enable row level security;

-- See a saved report: view on its page. Save one: edit on its page.
-- Remove one: manage on its page, or the person who saved it (while they can still edit).
create policy saved_reports_select on public.saved_reports for select to authenticated
  using (public.access_level(workspace_id, public.report_page(kind)) >= 'view');
create policy saved_reports_insert on public.saved_reports for insert to authenticated
  with check (public.access_level(workspace_id, public.report_page(kind)) >= 'edit' and created_by = auth.uid());
create policy saved_reports_delete on public.saved_reports for delete to authenticated
  using (
    public.access_level(workspace_id, public.report_page(kind)) >= 'manage'
    or (created_by = auth.uid() and public.access_level(workspace_id, public.report_page(kind)) >= 'edit')
  );

grant select, insert, delete on public.saved_reports to authenticated;

revoke all on all functions in schema public from public, anon;
grant execute on function public.report_page(text) to authenticated;
