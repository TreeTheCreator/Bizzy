-- Phase 2: API keys (REST API), webhooks and rate limiting.
--
-- API keys follow the same idea as AI connections. The REST endpoint turns a
-- key into a short-lived token for the member who created it, carrying an
-- "api_key_id" claim. That claim makes it a DELEGATED token: everything that
-- already refuses AI connections (roles, members, settings, the audit log,
-- creating workspaces or connections) refuses it too, and the key's own
-- limits are applied here, in the access functions RLS reads:
--
--   * the key reaches only the workspace it was created in,
--   * a "read" key is capped at view, a "write" key at the member's own role,
--   * a revoked key (or a member who left) stops working on the next call.

-- ---------------------------------------------------------------------------
-- Delegated tokens
-- ---------------------------------------------------------------------------

create function public.api_key_id() returns uuid
language plpgsql stable
set search_path = ''
as $$
begin
  return nullif(auth.jwt() ->> 'api_key_id', '')::uuid;
exception when others then
  return null;
end
$$;

-- True for any delegated token: an AI connection (OAuth client) or an API key.
-- The name is kept because every existing policy and guard already calls it.
create or replace function public.is_oauth_client() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'client_id', '') <> '' or coalesce(auth.jwt() ->> 'api_key_id', '') <> ''
$$;

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The member the key acts as. Leaving the workspace deletes the key.
  user_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- First characters of the key, to tell keys apart. The key itself is never stored.
  prefix text not null,
  key_hash text not null unique,
  scope text not null default 'read' check (scope in ('read', 'write')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  foreign key (workspace_id, user_id) references public.memberships (workspace_id, user_id) on delete cascade
);
create index api_keys_workspace_idx on public.api_keys (workspace_id);
create trigger guard_ws_api_keys before update on public.api_keys
  for each row execute function public.guard_workspace_id();

-- The cap a delegated token puts on the caller's access. Web sessions are not capped.
create or replace function public.mcp_cap(p_workspace uuid) returns public.level
language sql stable security definer
set search_path = ''
as $$
  select case
    when not public.is_oauth_client() then 'manage'::public.level
    when coalesce(auth.jwt() ->> 'api_key_id', '') <> '' then coalesce((
      select case k.scope when 'write' then 'manage' else 'view' end::public.level
      from public.api_keys k
      where k.id = public.api_key_id()
        and k.workspace_id = p_workspace
        and k.user_id = auth.uid()
        and k.revoked_at is null
    ), 'none'::public.level)
    else coalesce((
      select case w.mcp_policy
               when 'read_write' then 'manage'
               when 'read_only' then 'view'
               else 'none'
             end::public.level
      from public.workspaces w
      join public.mcp_connections c on c.workspace_id = w.id
      where w.id = p_workspace
        and c.user_id = auth.uid()
        and c.client_id = auth.jwt() ->> 'client_id'
        and c.revoked_at is null
    ), 'none'::public.level)
  end
$$;

-- Audit rows written by triggers take their channel from the token.
create or replace function public.audit(
  p_workspace uuid, p_event text, p_target text default null,
  p_summary jsonb default '{}'::jsonb, p_outcome text default 'ok', p_channel text default null
) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.workspaces where id = p_workspace) then
    return;
  end if;
  insert into public.audit_log (workspace_id, actor_id, channel, event, target, summary, outcome)
  values (
    p_workspace, auth.uid(),
    coalesce(p_channel, case
      when public.api_key_id() is not null then 'api'
      when public.is_oauth_client() then 'mcp'
      else 'web' end),
    p_event, p_target, coalesce(p_summary, '{}'::jsonb), p_outcome
  );
end
$$;

-- log_event(): also accepts "api.call" (one row per changing REST request).
create or replace function public.log_event(
  p_workspace uuid, p_event text, p_target text default null,
  p_summary jsonb default '{}'::jsonb, p_outcome text default 'ok', p_channel text default 'web'
) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_event not in ('authz.denied', 'data.export', 'mcp.call', 'api.call') then
    raise exception 'event not allowed: %', p_event using errcode = '22023';
  end if;
  if p_channel not in ('web', 'api', 'mcp') or p_outcome not in ('ok', 'denied', 'error') then
    raise exception 'bad channel or outcome' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace and m.user_id = auth.uid()
  ) then
    return;
  end if;
  perform public.audit(p_workspace, p_event, left(p_target, 200), p_summary, p_outcome, p_channel);
end
$$;

-- Create a key. Needs Settings manage, from the web app. The key is returned
-- once and only its SHA-256 hash is stored.
create function public.api_key_create(p_workspace uuid, p_name text, p_scope text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_key text := 'bz_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_id uuid;
begin
  if public.is_oauth_client() or public.access_level(p_workspace, 'settings') < 'manage' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_scope not in ('read', 'write') then
    raise exception 'scope must be read or write' using errcode = '22023';
  end if;
  insert into public.api_keys (workspace_id, user_id, name, prefix, key_hash, scope)
  values (p_workspace, auth.uid(), btrim(p_name), left(v_key, 11), public.hash_invite_token(v_key), p_scope)
  returning id into v_id;
  perform public.audit(p_workspace, 'api_key.created', v_id::text, jsonb_build_object('name', btrim(p_name), 'scope', p_scope));
  return jsonb_build_object('id', v_id, 'key', v_key);
end
$$;

-- Revoke a key: your own, or anyone's with Settings manage. Never over a delegated token.
create function public.api_key_revoke(p_workspace uuid, p_key uuid) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null or public.is_oauth_client() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.api_keys k set revoked_at = now()
  where k.id = p_key and k.workspace_id = p_workspace and k.revoked_at is null
    and (k.user_id = auth.uid() or public.access_level(p_workspace, 'settings') >= 'manage');
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform public.audit(p_workspace, 'api_key.revoked', p_key::text);
  end if;
  return v_count;
end
$$;

-- Step one of an API request. The endpoint sends a token that carries only the
-- key's hash (no user); this returns who the key acts as and stamps it as used.
create function public.api_key_resolve()
returns table (key_id uuid, user_id uuid, workspace_id uuid, email text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_hash text := coalesce(auth.jwt() ->> 'api_key_hash', '');
begin
  if v_hash = '' then
    return;
  end if;
  return query
    update public.api_keys k set last_used_at = now()
    from public.profiles p
    where k.key_hash = v_hash and k.revoked_at is null and p.id = k.user_id
    returning k.id, k.user_id, k.workspace_id, p.email;
end
$$;

-- ---------------------------------------------------------------------------
-- Rate limiting: fixed one-minute windows per caller. The limits live here so
-- a caller cannot choose their own.
-- ---------------------------------------------------------------------------

-- Not tenant data: counters only, keyed by user. No client can read or write
-- the table; only rate_limit_hit() touches it.
create table public.rate_limits (
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Which key or AI connection ('' for neither): each has its own allowance.
  subject text not null default '',
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (user_id, subject, bucket, window_start)
);

-- Count one request. Returns true while the caller is within the limit.
create function public.rate_limit_hit(p_bucket text) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit integer := case p_bucket
    when 'mcp' then 120 when 'mcp.destructive' then 10
    when 'api' then 120 when 'api.write' then 60 end;
  v_subject text := coalesce(nullif(auth.jwt() ->> 'api_key_id', ''), nullif(auth.jwt() ->> 'client_id', ''), '');
  v_count integer;
begin
  if auth.uid() is null then
    return false;
  end if;
  if v_limit is null then
    raise exception 'unknown bucket' using errcode = '22023';
  end if;
  insert into public.rate_limits as r (user_id, subject, bucket, window_start, count)
  values (auth.uid(), v_subject, p_bucket, date_trunc('minute', now()), 1)
  on conflict (user_id, subject, bucket, window_start) do update set count = r.count + 1
  returning r.count into v_count;
  if v_count = 1 then
    delete from public.rate_limits where user_id = auth.uid() and window_start < now() - interval '10 minutes';
  end if;
  return v_count <= v_limit;
end
$$;

-- ---------------------------------------------------------------------------
-- Webhooks
-- ---------------------------------------------------------------------------

-- The events a webhook can subscribe to, and the page whose data each carries.
create function public.webhook_event_page(p_event text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_event
    when 'task.created' then 'tasks' when 'task.completed' then 'tasks'
    when 'deal.created' then 'crm' when 'deal.stage_changed' then 'crm' when 'deal.won' then 'crm'
    when 'invoice.sent' then 'finance' when 'invoice.paid' then 'finance'
  end
$$;

create table public.webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  url text not null check (url ~ '^https://[^\s]+$' and char_length(url) <= 2000),
  events text[] not null check (cardinality(events) between 1 and 20),
  -- Signs each delivery. Shown once on creation; clients cannot select it.
  secret text not null,
  active boolean not null default true,
  -- A webhook only carries what its creator may see; if they leave, it goes too.
  created_by uuid not null,
  created_at timestamptz not null default now(),
  failure_count integer not null default 0,
  last_delivery_at timestamptz,
  last_status integer,
  foreign key (workspace_id, created_by) references public.memberships (workspace_id, user_id) on delete cascade
);
create index webhooks_workspace_idx on public.webhooks (workspace_id);

create table public.webhook_deliveries (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  webhook_id uuid not null references public.webhooks (id) on delete cascade,
  event text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  response_status integer,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index webhook_deliveries_due_idx on public.webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_webhook_idx on public.webhook_deliveries (webhook_id, id desc);

create trigger guard_ws_webhooks before update on public.webhooks
  for each row execute function public.guard_workspace_id();
create trigger guard_ws_webhook_deliveries before update on public.webhook_deliveries
  for each row execute function public.guard_workspace_id();

-- Create a webhook. Needs Settings manage, from the web app, and view access
-- to the page behind every chosen event. Returns the signing secret once.
create function public.webhook_create(p_workspace uuid, p_url text, p_events text[]) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_secret text := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_event text;
  v_id uuid;
begin
  if public.is_oauth_client() or public.access_level(p_workspace, 'settings') < 'manage' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_events), 0) = 0 then
    raise exception 'Choose at least one event.' using errcode = 'P0001';
  end if;
  foreach v_event in array p_events loop
    if public.webhook_event_page(v_event) is null then
      raise exception 'unknown event: %', v_event using errcode = '22023';
    end if;
    if public.access_level(p_workspace, public.webhook_event_page(v_event)) < 'view' then
      raise exception 'Your role cannot see the data behind "%", so you cannot send it to a webhook.', v_event
        using errcode = 'P0001';
    end if;
  end loop;
  if (select count(*) from public.webhooks where workspace_id = p_workspace) >= 20 then
    raise exception 'A workspace can have at most 20 webhooks.' using errcode = 'P0001';
  end if;
  insert into public.webhooks (workspace_id, url, events, secret, created_by)
  values (p_workspace, btrim(p_url), (select array_agg(distinct e) from unnest(p_events) as e), v_secret, auth.uid())
  returning id into v_id;
  perform public.audit(p_workspace, 'webhook.created', v_id::text, jsonb_build_object('url', btrim(p_url), 'events', p_events));
  return jsonb_build_object('id', v_id, 'secret', v_secret);
end
$$;

-- Queue an event for every active webhook subscribed to it, as long as the
-- webhook's creator can still see that page. Internal: called by triggers.
create function public.webhook_enqueue(p_workspace uuid, p_event text, p_data jsonb) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.webhook_deliveries (workspace_id, webhook_id, event, payload)
  select w.workspace_id, w.id, p_event,
         jsonb_build_object('event', p_event, 'workspace_id', p_workspace, 'occurred_at', now(), 'data', p_data)
  from public.webhooks w
  where w.workspace_id = p_workspace and w.active and p_event = any (w.events)
    and public.access_level_for(w.created_by, p_workspace, public.webhook_event_page(p_event)) >= 'view';
end
$$;

create function public.webhook_on_task() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_data jsonb := jsonb_build_object('id', new.id, 'title', new.title, 'status', new.status,
    'assignee_id', new.assignee_id, 'due_date', new.due_date);
begin
  if tg_op = 'INSERT' then
    perform public.webhook_enqueue(new.workspace_id, 'task.created', v_data);
  elsif new.status = 'done' and old.status <> 'done' then
    perform public.webhook_enqueue(new.workspace_id, 'task.completed', v_data);
  end if;
  return null;
end
$$;
create trigger webhook_on_task after insert or update on public.tasks
  for each row execute function public.webhook_on_task();

create function public.webhook_on_deal() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_stage public.deal_stages%rowtype;
  v_data jsonb;
begin
  select * into v_stage from public.deal_stages where id = new.stage_id;
  v_data := jsonb_build_object('id', new.id, 'title', new.title, 'amount', new.amount,
    'stage', v_stage.name, 'stage_kind', v_stage.kind, 'company_id', new.company_id);
  if tg_op = 'INSERT' then
    perform public.webhook_enqueue(new.workspace_id, 'deal.created', v_data);
  elsif new.stage_id is distinct from old.stage_id then
    perform public.webhook_enqueue(new.workspace_id, 'deal.stage_changed', v_data);
  else
    return null;
  end if;
  if v_stage.kind = 'won' then
    perform public.webhook_enqueue(new.workspace_id, 'deal.won', v_data);
  end if;
  return null;
end
$$;
create trigger webhook_on_deal after insert or update on public.deals
  for each row execute function public.webhook_on_deal();

create function public.webhook_on_invoice() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_data jsonb := jsonb_build_object('id', new.id, 'number', new.number, 'customer_name', new.customer_name,
    'total', new.total, 'status', new.status, 'due_date', new.due_date);
begin
  if new.status = 'sent' and old.status = 'draft' then
    perform public.webhook_enqueue(new.workspace_id, 'invoice.sent', v_data);
  elsif new.status = 'paid' and old.status <> 'paid' then
    perform public.webhook_enqueue(new.workspace_id, 'invoice.paid', v_data);
  end if;
  return null;
end
$$;
create trigger webhook_on_invoice after update on public.invoices
  for each row execute function public.webhook_on_invoice();

-- The delivery worker (service role only). Claims due deliveries and pushes
-- their next attempt into the future, so a crashed worker retries on its own.
create function public.webhook_claim(p_limit integer default 20)
returns table (delivery_id bigint, url text, secret text, event text, payload jsonb, attempts integer)
language sql security definer
set search_path = ''
as $$
  with due as (
    select d.id from public.webhook_deliveries d
    join public.webhooks w on w.id = d.webhook_id and w.active
    where d.status = 'pending' and d.next_attempt_at <= now()
    order by d.next_attempt_at
    limit least(greatest(p_limit, 1), 100)
    for update of d skip locked
  )
  update public.webhook_deliveries d
  set attempts = d.attempts + 1,
      -- 1 min, 5 min, 25 min, about 2 h, about 10 h
      next_attempt_at = now() + make_interval(mins => (power(5, d.attempts))::integer)
  from due, public.webhooks w
  where d.id = due.id and w.id = d.webhook_id
  returning d.id, w.url, w.secret, d.event, d.payload, d.attempts
$$;

-- Record the outcome of one attempt. After 6 failed attempts a delivery is
-- given up; after 20 failures in a row the webhook is paused.
create function public.webhook_report(p_delivery bigint, p_status integer) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ok boolean := coalesce(p_status between 200 and 299, false);
  v_webhook uuid;
begin
  update public.webhook_deliveries d
  set status = case when v_ok then 'delivered' when d.attempts >= 6 then 'failed' else 'pending' end,
      response_status = p_status,
      delivered_at = case when v_ok then now() end
  where d.id = p_delivery and d.status = 'pending'
  returning d.webhook_id into v_webhook;
  if v_webhook is null then
    return;
  end if;
  update public.webhooks w
  set last_delivery_at = now(),
      last_status = p_status,
      failure_count = case when v_ok then 0 else w.failure_count + 1 end,
      active = w.active and (v_ok or w.failure_count + 1 < 20)
  where w.id = v_webhook;
end
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

alter table public.api_keys enable row level security;
alter table public.rate_limits enable row level security;
alter table public.webhooks enable row level security;
alter table public.webhook_deliveries enable row level security;

-- Keys: you see your own; Settings managers see the workspace's. Never over a
-- delegated token. The hash is not selectable (column grants below).
create policy api_keys_select on public.api_keys for select to authenticated
  using (
    not public.is_oauth_client()
    and (user_id = auth.uid() or public.access_level(workspace_id, 'settings') >= 'manage')
  );

-- Webhooks: Settings managers, from the web app. Pausing is the only direct update.
create policy webhooks_select on public.webhooks for select to authenticated
  using (not public.is_oauth_client() and public.access_level(workspace_id, 'settings') >= 'manage');
create policy webhooks_update on public.webhooks for update to authenticated
  using (not public.is_oauth_client() and public.access_level(workspace_id, 'settings') >= 'manage')
  with check (not public.is_oauth_client() and public.access_level(workspace_id, 'settings') >= 'manage');
create policy webhooks_delete on public.webhooks for delete to authenticated
  using (not public.is_oauth_client() and public.access_level(workspace_id, 'settings') >= 'manage');
create policy webhook_deliveries_select on public.webhook_deliveries for select to authenticated
  using (not public.is_oauth_client() and public.access_level(workspace_id, 'settings') >= 'manage');

grant select (id, workspace_id, user_id, name, prefix, scope, created_at, last_used_at, revoked_at)
  on public.api_keys to authenticated;
grant select (id, workspace_id, url, events, active, created_by, created_at, failure_count, last_delivery_at, last_status)
  on public.webhooks to authenticated;
grant update (active), delete on public.webhooks to authenticated;
-- The payload is left out: it can hold data from pages a Settings manager may not see.
grant select (id, workspace_id, webhook_id, event, status, attempts, response_status, created_at, delivered_at)
  on public.webhook_deliveries to authenticated;

revoke all on all functions in schema public from public, anon;
revoke execute on function
  public.webhook_enqueue(uuid, text, jsonb), public.webhook_on_task(), public.webhook_on_deal(),
  public.webhook_on_invoice(), public.webhook_claim(integer), public.webhook_report(bigint, integer)
from authenticated;
grant execute on function
  public.api_key_id(), public.api_key_create(uuid, text, text), public.api_key_revoke(uuid, uuid),
  public.api_key_resolve(), public.rate_limit_hit(text), public.webhook_event_page(text),
  public.webhook_create(uuid, text, text[])
to authenticated;
grant execute on function public.webhook_claim(integer), public.webhook_report(bigint, integer) to service_role;
