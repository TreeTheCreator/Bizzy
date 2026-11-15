-- Phase 2 modules: CRM (companies, contacts, deals) and Finance (quotes,
-- invoices, expenses, budgets). Same policy shape as every other module:
--   select = view, insert/update = edit, delete = manage, on the table's page.

-- ---------------------------------------------------------------------------
-- CRM
-- ---------------------------------------------------------------------------

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  website text not null default '' check (char_length(website) <= 300),
  notes text not null default '' check (char_length(notes) <= 10000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create index companies_workspace_idx on public.companies (workspace_id);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  company_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  email text not null default '' check (char_length(email) <= 320),
  phone text not null default '' check (char_length(phone) <= 60),
  title text not null default '' check (char_length(title) <= 200),
  notes text not null default '' check (char_length(notes) <= 10000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id)
    on delete set null (company_id)
);
create index contacts_workspace_idx on public.contacts (workspace_id, company_id);

-- The columns of the deal board. Every workspace starts with the same five.
create table public.deal_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  position integer not null default 0,
  kind text not null default 'open' check (kind in ('open', 'won', 'lost')),
  unique (id, workspace_id),
  unique (workspace_id, name)
);
create index deal_stages_workspace_idx on public.deal_stages (workspace_id, position);

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  stage_id uuid not null,
  company_id uuid,
  contact_id uuid,
  owner_id uuid,
  expected_close date,
  notes text not null default '' check (char_length(notes) <= 10000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (id, workspace_id),
  foreign key (stage_id, workspace_id) references public.deal_stages (id, workspace_id),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id)
    on delete set null (company_id),
  foreign key (contact_id, workspace_id) references public.contacts (id, workspace_id)
    on delete set null (contact_id),
  foreign key (workspace_id, owner_id) references public.memberships (workspace_id, user_id)
    on delete set null (owner_id)
);
create index deals_workspace_idx on public.deals (workspace_id, stage_id);

create function public.seed_deal_stages() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.deal_stages (workspace_id, name, position, kind) values
    (new.id, 'Lead', 1, 'open'), (new.id, 'Qualified', 2, 'open'), (new.id, 'Proposal', 3, 'open'),
    (new.id, 'Won', 4, 'won'), (new.id, 'Lost', 5, 'lost')
  on conflict do nothing;
  return null;
end
$$;
create trigger seed_deal_stages after insert on public.workspaces
  for each row execute function public.seed_deal_stages();

insert into public.deal_stages (workspace_id, name, position, kind)
select w.id, s.name, s.position, s.kind
from public.workspaces w
cross join (values ('Lead', 1, 'open'), ('Qualified', 2, 'open'), ('Proposal', 3, 'open'),
                   ('Won', 4, 'won'), ('Lost', 5, 'lost')) as s(name, position, kind)
on conflict do nothing;

-- closed_at follows the stage: set when a deal lands in a won/lost stage, cleared when it reopens.
create function public.deal_before_write() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  select kind into v_kind from public.deal_stages where id = new.stage_id and workspace_id = new.workspace_id;
  if v_kind is null or v_kind = 'open' then
    new.closed_at := null;
  elsif tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id or old.closed_at is null then
    new.closed_at := now();
  else
    new.closed_at := old.closed_at;
  end if;
  return new;
end
$$;
create trigger deal_before_write before insert or update on public.deals
  for each row execute function public.deal_before_write();
create trigger touch_deals before update on public.deals
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Finance
-- ---------------------------------------------------------------------------

-- customer_name is kept on the quote/invoice itself: someone with Finance but
-- not CRM access must still be able to read who it is for.
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  number integer not null default 0,
  customer_name text not null check (char_length(btrim(customer_name)) between 1 and 200),
  company_id uuid,
  deal_id uuid,
  title text not null default '' check (char_length(title) <= 200),
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined')),
  valid_until date,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, number),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id)
    on delete set null (company_id),
  foreign key (deal_id, workspace_id) references public.deals (id, workspace_id)
    on delete set null (deal_id)
);
create index quotes_workspace_idx on public.quotes (workspace_id);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  number integer not null default 0,
  customer_name text not null check (char_length(btrim(customer_name)) between 1 and 200),
  company_id uuid,
  deal_id uuid,
  status text not null default 'draft' check (status in ('draft', 'sent', 'paid', 'void')),
  issue_date date not null default current_date,
  due_date date,
  total numeric(14, 2) not null default 0,
  notes text not null default '' check (char_length(notes) <= 10000),
  sent_at timestamptz,
  paid_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, number),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id)
    on delete set null (company_id),
  foreign key (deal_id, workspace_id) references public.deals (id, workspace_id)
    on delete set null (deal_id)
);
create index invoices_workspace_idx on public.invoices (workspace_id, status);

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  invoice_id uuid not null,
  description text not null check (char_length(btrim(description)) between 1 and 500),
  quantity numeric(12, 2) not null default 1 check (quantity > 0),
  unit_price numeric(14, 2) not null default 0 check (unit_price >= 0),
  created_at timestamptz not null default now(),
  foreign key (invoice_id, workspace_id) references public.invoices (id, workspace_id) on delete cascade
);
create index invoice_lines_invoice_idx on public.invoice_lines (workspace_id, invoice_id);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  spent_on date not null default current_date,
  category text not null default 'General' check (char_length(btrim(category)) between 1 and 80),
  vendor text not null default '' check (char_length(vendor) <= 200),
  amount numeric(14, 2) not null check (amount >= 0),
  notes text not null default '' check (char_length(notes) <= 2000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index expenses_workspace_idx on public.expenses (workspace_id, spent_on desc);

-- A spending limit for one category in one month (month = its first day).
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  category text not null check (char_length(btrim(category)) between 1 and 80),
  month date not null check (extract(day from month) = 1),
  amount numeric(14, 2) not null check (amount >= 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, category, month)
);
create index budgets_workspace_idx on public.budgets (workspace_id, month);

-- Quote and invoice numbers count up per workspace and are chosen by the
-- database, never by the client, and never change.
create function public.assign_doc_number() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.number := old.number;
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(tg_table_name || new.workspace_id::text, 0));
  execute format('select coalesce(max(number), 0) + 1 from public.%I where workspace_id = $1', tg_table_name)
    into new.number using new.workspace_id;
  return new;
end
$$;
create trigger assign_number_quotes before insert or update on public.quotes
  for each row execute function public.assign_doc_number();
create trigger assign_number_invoices before insert or update on public.invoices
  for each row execute function public.assign_doc_number();

-- The invoice total is always the sum of its lines, and the sent/paid
-- timestamps follow the status. Neither can be set by the client.
create function public.invoice_before_write() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.total := coalesce((
    select sum(round(l.quantity * l.unit_price, 2)) from public.invoice_lines l
    where l.invoice_id = new.id and l.workspace_id = new.workspace_id
  ), 0);
  if tg_op = 'INSERT' then
    new.sent_at := case when new.status in ('sent', 'paid') then now() end;
    new.paid_at := case when new.status = 'paid' then now() end;
    return new;
  end if;
  new.updated_at := now();
  new.sent_at := case
    when new.status in ('sent', 'paid') then coalesce(old.sent_at, now())
    when new.status = 'draft' then null
    else old.sent_at end;
  new.paid_at := case when new.status = 'paid' then coalesce(old.paid_at, now()) end;
  return new;
end
$$;
create trigger invoice_before_write before insert or update on public.invoices
  for each row execute function public.invoice_before_write();

-- Lines can only change while the invoice is a draft; any change refreshes the total.
create function public.invoice_line_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
  v_status text;
begin
  select status into v_status from public.invoices where id = v_invoice;
  -- v_status is null while the invoice itself is being deleted (cascade).
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Only a draft invoice can be changed. Set it back to draft first.' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
create trigger invoice_line_guard before insert or update or delete on public.invoice_lines
  for each row execute function public.invoice_line_guard();

create function public.invoice_line_total() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.invoices set updated_at = now() where id = coalesce(new.invoice_id, old.invoice_id);
  return null;
end
$$;
create trigger invoice_line_total after insert or update or delete on public.invoice_lines
  for each row execute function public.invoice_line_total();

-- ---------------------------------------------------------------------------
-- Guards, RLS and grants
-- ---------------------------------------------------------------------------

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('companies', 'crm', true, 'edit'), ('contacts', 'crm', true, 'edit'),
      ('deals', 'crm', true, 'edit'), ('deal_stages', 'crm', false, 'manage'),
      ('quotes', 'finance', true, 'edit'), ('invoices', 'finance', true, 'edit'),
      ('invoice_lines', 'finance', false, 'edit'), ('expenses', 'finance', true, 'edit'),
      ('budgets', 'finance', true, 'edit')
    ) as x(tbl, page, has_creator, write_level)
  loop
    execute format('create trigger %I before update on public.%I for each row execute function public.guard_workspace_id()',
      'guard_ws_' || t.tbl, t.tbl);
    execute format('alter table public.%I enable row level security', t.tbl);
    execute format('create policy %I on public.%I for select to authenticated using (public.access_level(workspace_id, %L) >= ''view'')',
      t.tbl || '_select', t.tbl, t.page);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.access_level(workspace_id, %L) >= %L%s)',
      t.tbl || '_insert', t.tbl, t.page, t.write_level,
      case when t.has_creator then ' and created_by = auth.uid()' else '' end);
    execute format('create policy %I on public.%I for update to authenticated using (public.access_level(workspace_id, %L) >= %L) with check (public.access_level(workspace_id, %L) >= %L)',
      t.tbl || '_update', t.tbl, t.page, t.write_level, t.page, t.write_level);
    -- Invoice lines are part of editing an invoice, so removing one needs edit, not manage.
    execute format('create policy %I on public.%I for delete to authenticated using (public.access_level(workspace_id, %L) >= %L)',
      t.tbl || '_delete', t.tbl, t.page, case when t.tbl = 'invoice_lines' then 'edit' else 'manage' end);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t.tbl);
  end loop;
end
$$;

revoke all on all functions in schema public from public, anon;
revoke execute on function
  public.seed_deal_stages(), public.deal_before_write(), public.assign_doc_number(),
  public.invoice_before_write(), public.invoice_line_guard(), public.invoice_line_total()
from authenticated;
