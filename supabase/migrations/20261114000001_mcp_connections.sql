-- Phase 2: AI connections (MCP).
--
-- Supabase Auth's OAuth 2.1 server issues the tokens. Its consent is per
-- client, not per workspace, and an access token it issued keeps passing the
-- database's JWT check until it expires, even after the grant is revoked. So
-- the workspace scoping and the revocation both live HERE, inside the access
-- functions that every RLS policy and authorize() already read:
--
--   * A token issued to an OAuth client reaches a workspace only while an
--     unrevoked mcp_connections row links that user + client to the workspace.
--   * The workspace's mcp_policy then caps it: off = nothing, read_only = view.
--   * The Settings page (members, roles, invites) is never reachable.
--
-- Because this is in access_level(), it applies to raw database calls with the
-- token as well as to the MCP endpoint, and takes effect on the very next call.

-- One row per (connection, workspace). A "connection" is a user + OAuth client.
create table public.mcp_connections (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- The OAuth client id from the token's "client_id" claim.
  client_id text not null check (char_length(client_id) between 1 and 200),
  client_name text not null default '' check (char_length(client_name) <= 200),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  primary key (workspace_id, user_id, client_id),
  -- Leaving or being removed from the workspace ends the connection to it.
  foreign key (workspace_id, user_id) references public.memberships (workspace_id, user_id)
    on delete cascade
);
create index mcp_connections_user_idx on public.mcp_connections (user_id, client_id);

create trigger guard_ws_mcp_connections before update on public.mcp_connections
  for each row execute function public.guard_workspace_id();

-- ---------------------------------------------------------------------------
-- The cap an AI connection puts on the caller's access to a workspace.
-- Normal web sessions are not capped.
-- ---------------------------------------------------------------------------

create function public.mcp_cap(p_workspace uuid) returns public.level
language sql stable security definer
set search_path = ''
as $$
  select case
    when not public.is_oauth_client() then 'manage'::public.level
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

-- access_level(): the role's level, capped by the connection. Settings is
-- never available over an AI connection.
create or replace function public.access_level(p_workspace uuid, p_page text) returns public.level
language sql stable security definer
set search_path = ''
as $$
  select case
    when public.is_oauth_client() and p_page = 'settings' then 'none'::public.level
    else least(public.access_level_for(auth.uid(), p_workspace, p_page), public.mcp_cap(p_workspace))
  end
$$;

-- Over an AI connection, a workspace outside the connection does not exist.
create or replace function public.is_member(p_workspace uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace
      and m.user_id = auth.uid()
      and (m.expires_at is null or m.expires_at > now())
  ) and public.mcp_cap(p_workspace) > 'none'
$$;

create or replace function public.can_see_sensitive(p_workspace uuid, p_page text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.access_level(p_workspace, p_page) > 'none' and coalesce((
    select case
      when m.user_id is null then false
      when m.expires_at is not null and m.expires_at <= now() then false
      when w.owner_id = auth.uid() then true
      when r.kind = 'full_access' then true
      else coalesce(rp.sensitive and rp.level <> 'none', false)
    end
    from public.workspaces w
    left join public.memberships m on m.workspace_id = w.id and m.user_id = auth.uid()
    left join public.roles r on r.id = m.role_id
    left join public.role_permissions rp on rp.role_id = r.id and rp.page = p_page
    where w.id = p_workspace
  ), false)
$$;

-- ---------------------------------------------------------------------------
-- Connection management. All writes go through these functions; clients have
-- no insert/update/delete on the table. None of them work over an AI
-- connection: a connection can never widen or restore itself.
-- ---------------------------------------------------------------------------

-- Called from the consent screen. Sets the caller's connection for this client
-- to exactly p_workspaces: listed workspaces are (re)connected, others revoked.
create function public.mcp_connect(p_client_id text, p_client_name text, p_workspaces uuid[]) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if public.is_oauth_client() then
    raise exception 'connections cannot be changed over an AI connection' using errcode = '42501';
  end if;
  if coalesce(btrim(p_client_id), '') = '' then
    raise exception 'missing client' using errcode = '22023';
  end if;

  foreach v_ws in array coalesce(p_workspaces, '{}'::uuid[]) loop
    if not public.is_member(v_ws) then
      raise exception 'you are not a member of that workspace' using errcode = '42501';
    end if;
    insert into public.mcp_connections (workspace_id, user_id, client_id, client_name)
    values (v_ws, auth.uid(), p_client_id, left(coalesce(p_client_name, ''), 200))
    on conflict (workspace_id, user_id, client_id) do update
      set revoked_at = null, client_name = excluded.client_name, created_at = now(), last_used_at = null
      where public.mcp_connections.revoked_at is not null
         or public.mcp_connections.client_name is distinct from excluded.client_name;
  end loop;

  update public.mcp_connections c set revoked_at = now()
  where c.user_id = auth.uid() and c.client_id = p_client_id and c.revoked_at is null
    and not (c.workspace_id = any (coalesce(p_workspaces, '{}'::uuid[])));
end
$$;

-- Revoke your own connection: for one workspace, or (p_workspace null) all of them.
create function public.mcp_revoke(p_client_id text, p_workspace uuid default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if public.is_oauth_client() then
    raise exception 'connections cannot be changed over an AI connection' using errcode = '42501';
  end if;
  update public.mcp_connections c set revoked_at = now()
  where c.user_id = auth.uid() and c.client_id = p_client_id and c.revoked_at is null
    and (p_workspace is null or c.workspace_id = p_workspace);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- The owner cuts any member's connection to their workspace.
create function public.mcp_revoke_any(p_workspace uuid, p_user uuid, p_client_id text) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_owner(p_workspace) or public.is_oauth_client() then
    raise exception 'only the owner can revoke other people''s connections' using errcode = '42501';
  end if;
  if not public.recently_authenticated() then
    raise exception 'reauthentication required' using errcode = 'P0403';
  end if;
  update public.mcp_connections c set revoked_at = now()
  where c.workspace_id = p_workspace and c.user_id = p_user and c.client_id = p_client_id
    and c.revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- One round trip per tool call: write the audit row and stamp the connection.
-- Only meaningful for an AI connection; the actor is always the caller.
create function public.mcp_log_call(
  p_workspace uuid, p_tool text, p_summary jsonb default '{}'::jsonb, p_outcome text default 'ok'
) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_oauth_client() then
    return;
  end if;
  perform public.log_event(p_workspace, 'mcp.call', p_tool, p_summary, p_outcome, 'mcp');
  update public.mcp_connections c set last_used_at = now()
  where c.workspace_id = p_workspace and c.user_id = auth.uid()
    and c.client_id = auth.jwt() ->> 'client_id' and c.revoked_at is null;
end
$$;

-- Connection history is written by the database, like role history.
create function public.audit_mcp_connections() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or (old.revoked_at is not null and new.revoked_at is null) then
    perform public.audit(new.workspace_id, 'mcp.connected', new.user_id::text,
      jsonb_build_object('client_id', new.client_id, 'client_name', new.client_name), 'ok', 'web');
  elsif old.revoked_at is null and new.revoked_at is not null then
    perform public.audit(new.workspace_id, 'mcp.revoked', new.user_id::text,
      jsonb_build_object('client_id', new.client_id, 'client_name', new.client_name), 'ok', 'web');
  end if;
  return null;
end
$$;
create trigger audit_mcp_connections after insert or update on public.mcp_connections
  for each row execute function public.audit_mcp_connections();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

alter table public.mcp_connections enable row level security;

-- You see your own connections; Settings managers see their workspace's.
-- Never readable over an AI connection.
create policy mcp_connections_select on public.mcp_connections for select to authenticated
  using (
    not public.is_oauth_client()
    and (user_id = auth.uid() or public.access_level(workspace_id, 'settings') >= 'manage')
  );

grant select on public.mcp_connections to authenticated;

revoke all on all functions in schema public from public, anon;
revoke execute on function public.audit_mcp_connections() from authenticated;
grant execute on function
  public.mcp_cap(uuid), public.mcp_connect(text, text, uuid[]), public.mcp_revoke(text, uuid),
  public.mcp_revoke_any(uuid, uuid, text), public.mcp_log_call(uuid, text, jsonb, text)
to authenticated;
