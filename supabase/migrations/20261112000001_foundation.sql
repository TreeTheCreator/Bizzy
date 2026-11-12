-- Bizzy foundation: tenancy, roles, access functions, audit log, RLS.
--
-- Security model in one paragraph:
--   * Every row belongs to one workspace (workspace_id).
--   * public.access_level(workspace, page) is the single source of truth for
--     what the calling user may do. RLS policies and the TypeScript authorize()
--     both read it, so they cannot drift apart.
--   * The owner is workspaces.owner_id, never a role row, so there is exactly one.
--   * Only the owner may write roles, role_permissions and memberships, and only
--     from a recently authenticated, non-OAuth-client (i.e. not MCP) session.
--   * Privileged state changes happen in SECURITY DEFINER functions; guard
--     triggers refuse the same changes when attempted directly by a client role.

-- ---------------------------------------------------------------------------
-- Types and constants
-- ---------------------------------------------------------------------------

create type public.level as enum ('none', 'view', 'edit', 'manage');
create type public.role_kind as enum ('full_access', 'custom', 'guest');
create type public.mcp_policy as enum ('off', 'read_only', 'read_write');

-- The list of pages (modules). Adding a page later = replacing this function.
-- Custom roles have no row for a new page, so it defaults to 'none'.
create function public.app_pages() returns text[]
language sql immutable
as $$
  select array['dashboard','tasks','docs','crm','finance','hr','ops','marketing','support','settings']
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  owner_id uuid not null references public.profiles (id),
  mcp_policy public.mcp_policy not null default 'off',
  created_at timestamptz not null default now()
);
create index workspaces_owner_idx on public.workspaces (owner_id);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  kind public.role_kind not null default 'custom',
  is_builtin boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, name),
  unique (id, workspace_id)
);

create table public.role_permissions (
  role_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  page text not null check (page = any (public.app_pages())),
  level public.level not null check (level <> 'none'),
  sensitive boolean not null default false,
  primary key (role_id, page),
  foreign key (role_id, workspace_id) references public.roles (id, workspace_id) on delete cascade
);
create index role_permissions_workspace_idx on public.role_permissions (workspace_id);

create table public.memberships (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- NULL role = no access at all. This is the state of every new member.
  role_id uuid,
  -- Optional expiry (used for guests). After this instant access is 'none'.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  -- The role must belong to the same workspace as the membership.
  foreign key (role_id, workspace_id) references public.roles (id, workspace_id)
    on delete set null (role_id)
);
create index memberships_user_idx on public.memberships (user_id);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (position('@' in email) > 1),
  -- sha256 hex of the secret token. The raw token only ever exists in the link.
  token_hash text not null unique,
  invited_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  revoked_at timestamptz
);
create index invites_workspace_idx on public.invites (workspace_id);

create table public.audit_log (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  channel text not null check (channel in ('web', 'api', 'mcp', 'system')),
  event text not null,
  target text,
  summary jsonb not null default '{}'::jsonb,
  outcome text not null default 'ok' check (outcome in ('ok', 'denied', 'error')),
  created_at timestamptz not null default now()
);
create index audit_log_workspace_idx on public.audit_log (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Session helpers
-- ---------------------------------------------------------------------------

-- True when the JWT was issued to an OAuth client (an MCP connection) rather
-- than a normal web session.
create function public.is_oauth_client() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'client_id', '') <> ''
$$;

-- True when the user typed their password within the last p_seconds. Reads the
-- "amr" claim Supabase Auth puts in the JWT; fails closed if it is missing.
create function public.recently_authenticated(p_seconds integer default 600) returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((
    select max((e ->> 'timestamp')::bigint)
    from jsonb_array_elements(
      case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end
    ) as e
    where jsonb_typeof(e) = 'object' and e ->> 'method' in ('password', 'otp', 'totp', 'mfa/totp')
  ), 0) >= extract(epoch from now())::bigint - p_seconds
$$;

-- ---------------------------------------------------------------------------
-- Access functions (the single source of truth)
-- ---------------------------------------------------------------------------

create function public.is_owner(p_workspace uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = p_workspace and w.owner_id = auth.uid()
  )
$$;

-- Member with an unexpired membership (may still have no role).
create function public.is_member(p_workspace uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace
      and m.user_id = auth.uid()
      and (m.expires_at is null or m.expires_at > now())
  )
$$;

-- The one place access is resolved. INTERNAL: takes an arbitrary user id, so it
-- is never granted to client roles; they call access_level() below, which is
-- pinned to the caller.
create function public.access_level_for(p_user uuid, p_workspace uuid, p_page text) returns public.level
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when p_user is null then 'none'
      when m.user_id is null then 'none'                                  -- not a member
      when m.expires_at is not null and m.expires_at <= now() then 'none' -- expired
      when w.owner_id = p_user then 'manage'                              -- owner
      when m.role_id is null then 'none'                                  -- no role yet
      when r.kind = 'full_access' then 'manage'                           -- every current and future page
      else coalesce(rp.level, 'none')                                     -- missing entry = none
    end::public.level
    from public.workspaces w
    left join public.memberships m on m.workspace_id = w.id and m.user_id = p_user
    left join public.roles r on r.id = m.role_id
    left join public.role_permissions rp on rp.role_id = r.id and rp.page = p_page
    where w.id = p_workspace
  ), 'none'::public.level)
$$;

create function public.access_level(p_workspace uuid, p_page text) returns public.level
language sql stable security definer
set search_path = ''
as $$
  select public.access_level_for(auth.uid(), p_workspace, p_page)
$$;

-- Whether the caller may see fields flagged sensitive on a page.
create function public.can_see_sensitive(p_workspace uuid, p_page text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
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

create function public.has_any_access(p_workspace uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from unnest(public.app_pages()) as p
    where public.access_level(p_workspace, p) > 'none'
  )
$$;

create function public.my_role_id(p_workspace uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.role_id from public.memberships m
  where m.workspace_id = p_workspace and m.user_id = auth.uid()
    and (m.expires_at is null or m.expires_at > now())
$$;

-- The gate for every role / membership write: owner + web session + fresh login.
create function public.can_manage_roles(p_workspace uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.is_owner(p_workspace)
     and not public.is_oauth_client()
     and public.recently_authenticated()
$$;

-- Everything authorize() needs, in one round trip.
create function public.my_access(p_workspace uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'member', public.is_member(p_workspace),
    'is_owner', public.is_owner(p_workspace),
    'role_id', public.my_role_id(p_workspace),
    'role_name', (select r.name from public.roles r where r.id = public.my_role_id(p_workspace)),
    'role_kind', (select r.kind from public.roles r where r.id = public.my_role_id(p_workspace)),
    'levels', (select jsonb_object_agg(p, public.access_level(p_workspace, p)) from unnest(public.app_pages()) as p),
    'sensitive', (select jsonb_object_agg(p, public.can_see_sensitive(p_workspace, p)) from unnest(public.app_pages()) as p),
    'recent_auth', public.recently_authenticated(),
    'oauth_client', public.is_oauth_client()
  )
$$;

-- ---------------------------------------------------------------------------
-- Audit log writers
-- ---------------------------------------------------------------------------

-- Internal writer. Not callable by clients; used by triggers and definer functions.
create function public.audit(
  p_workspace uuid, p_event text, p_target text default null,
  p_summary jsonb default '{}'::jsonb, p_outcome text default 'ok', p_channel text default null
) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  -- During a workspace delete the cascade fires our triggers after the
  -- workspace row is gone; there is nothing left to attach the event to.
  if not exists (select 1 from public.workspaces where id = p_workspace) then
    return;
  end if;
  insert into public.audit_log (workspace_id, actor_id, channel, event, target, summary, outcome)
  values (
    p_workspace, auth.uid(),
    coalesce(p_channel, case when public.is_oauth_client() then 'mcp' else 'web' end),
    p_event, p_target, coalesce(p_summary, '{}'::jsonb), p_outcome
  );
end
$$;

-- Application-level events (things the database cannot observe itself).
-- The actor is always the caller, and only an allowlist of events is accepted,
-- so a member cannot forge role or membership history.
create function public.log_event(
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
  if p_event not in ('authz.denied', 'data.export', 'mcp.call') then
    raise exception 'event not allowed: %', p_event using errcode = '22023';
  end if;
  if p_channel not in ('web', 'api', 'mcp') or p_outcome not in ('ok', 'denied', 'error') then
    raise exception 'bad channel or outcome' using errcode = '22023';
  end if;
  -- Only people attached to the workspace can write to its log (including
  -- no-role and expired members, whose denials we want to see).
  if not exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace and m.user_id = auth.uid()
  ) then
    return;
  end if;
  perform public.audit(p_workspace, p_event, left(p_target, 200), p_summary, p_outcome, p_channel);
end
$$;

-- Called once after a successful sign-in: one login row per workspace the user is in.
create function public.log_login() returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  if auth.uid() is null then return; end if;
  for v_ws in select workspace_id from public.memberships where user_id = auth.uid() loop
    perform public.audit(v_ws, 'auth.login', null, '{}'::jsonb, 'ok', 'web');
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Profiles are created from auth.users
-- ---------------------------------------------------------------------------

create function public.handle_new_user() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Guard triggers: refuse privileged changes made directly by a client role.
-- Inside our SECURITY DEFINER functions current_user is the function owner,
-- so the same statements are allowed there.
-- ---------------------------------------------------------------------------

create function public.is_client_role() returns boolean
language sql stable
as $$ select current_user in ('authenticated', 'anon') $$;

create function public.guard_workspaces() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_client_role() then return new; end if;
  if new.id <> old.id or new.created_at <> old.created_at then
    raise exception 'immutable column' using errcode = '42501';
  end if;
  if new.owner_id <> old.owner_id then
    raise exception 'ownership changes only through transfer_ownership()' using errcode = '42501';
  end if;
  if new.mcp_policy <> old.mcp_policy
     and (old.owner_id <> auth.uid() or public.is_oauth_client()) then
    raise exception 'only the owner can change the MCP policy' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger guard_workspaces before update on public.workspaces
  for each row execute function public.guard_workspaces();

create function public.guard_memberships() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select w.owner_id into v_owner from public.workspaces w where w.id = old.workspace_id;
  if tg_op = 'DELETE' then
    -- v_owner is null while the workspace itself is being deleted (cascade).
    if v_owner is not null and v_owner = old.user_id then
      raise exception 'the owner cannot be removed from the workspace' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.workspace_id <> old.workspace_id or new.user_id <> old.user_id then
    raise exception 'immutable column' using errcode = '42501';
  end if;
  if public.is_client_role() and v_owner = old.user_id
     and (new.role_id is not null or new.expires_at is not null) then
    raise exception 'the owner cannot be given a role or an expiry' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger guard_memberships before update or delete on public.memberships
  for each row execute function public.guard_memberships();

create function public.guard_roles() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_client_role() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.is_builtin or new.kind = 'full_access' then
      raise exception 'built-in roles cannot be created by clients' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.is_builtin then
    raise exception 'built-in roles cannot be changed or deleted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.workspace_id <> old.workspace_id
       or new.is_builtin or new.kind = 'full_access' then
      raise exception 'invalid role change' using errcode = '42501';
    end if;
    return new;
  end if;
  return old;
end
$$;
create trigger guard_roles before insert or update or delete on public.roles
  for each row execute function public.guard_roles();

create function public.guard_role_permissions() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_kind public.role_kind;
begin
  select r.kind into v_kind from public.roles r where r.id = new.role_id;
  if v_kind = 'full_access' then
    raise exception 'Full Access needs no permission rows' using errcode = '22023';
  end if;
  if v_kind = 'guest' and new.level = 'manage' then
    raise exception 'guest roles are limited to view or edit' using errcode = '22023';
  end if;
  if v_kind = 'guest' and new.page = 'settings' then
    raise exception 'guest roles cannot access settings' using errcode = '22023';
  end if;
  return new;
end
$$;
create trigger guard_role_permissions before insert or update on public.role_permissions
  for each row execute function public.guard_role_permissions();

-- ---------------------------------------------------------------------------
-- Audit triggers: role and membership history is written by the database, so
-- it cannot be skipped or forged by application code.
-- ---------------------------------------------------------------------------

create function public.audit_memberships() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit(new.workspace_id, 'member.joined', new.user_id::text, '{}'::jsonb);
  elsif tg_op = 'DELETE' then
    perform public.audit(old.workspace_id, 'member.removed', old.user_id::text,
      jsonb_build_object('role_id', old.role_id));
  elsif new.role_id is distinct from old.role_id or new.expires_at is distinct from old.expires_at then
    perform public.audit(
      new.workspace_id,
      case when new.role_id is null and old.role_id is not null then 'role.revoked' else 'role.assigned' end,
      new.user_id::text,
      jsonb_build_object('from_role', old.role_id, 'to_role', new.role_id,
                         'from_expiry', old.expires_at, 'to_expiry', new.expires_at));
  end if;
  return null;
end
$$;
create trigger audit_memberships after insert or update or delete on public.memberships
  for each row execute function public.audit_memberships();

create function public.audit_roles() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit(new.workspace_id, 'role.created', new.id::text,
      jsonb_build_object('name', new.name, 'kind', new.kind));
  elsif tg_op = 'DELETE' then
    perform public.audit(old.workspace_id, 'role.deleted', old.id::text,
      jsonb_build_object('name', old.name));
  else
    perform public.audit(new.workspace_id, 'role.updated', new.id::text,
      jsonb_build_object('from_name', old.name, 'name', new.name));
  end if;
  return null;
end
$$;
create trigger audit_roles after insert or update or delete on public.roles
  for each row execute function public.audit_roles();

create function public.audit_role_permissions() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.audit(old.workspace_id, 'role.permission_removed', old.role_id::text,
      jsonb_build_object('page', old.page, 'level', old.level));
  else
    perform public.audit(new.workspace_id, 'role.permission_set', new.role_id::text,
      jsonb_build_object('page', new.page, 'level', new.level, 'sensitive', new.sensitive));
  end if;
  return null;
end
$$;
create trigger audit_role_permissions after insert or update or delete on public.role_permissions
  for each row execute function public.audit_role_permissions();

create function public.audit_workspaces() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit(new.id, 'workspace.created', new.id::text, jsonb_build_object('name', new.name));
    return null;
  end if;
  if new.owner_id <> old.owner_id then
    perform public.audit(new.id, 'ownership.transferred', new.owner_id::text,
      jsonb_build_object('from', old.owner_id, 'to', new.owner_id));
  end if;
  if new.mcp_policy <> old.mcp_policy then
    perform public.audit(new.id, 'mcp.policy_changed', null,
      jsonb_build_object('from', old.mcp_policy, 'to', new.mcp_policy));
  end if;
  if new.name <> old.name then
    perform public.audit(new.id, 'workspace.renamed', null,
      jsonb_build_object('from', old.name, 'to', new.name));
  end if;
  return null;
end
$$;
create trigger audit_workspaces after insert or update on public.workspaces
  for each row execute function public.audit_workspaces();

create function public.audit_invites() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit(new.workspace_id, 'invite.created', new.email, '{}'::jsonb);
  elsif tg_op = 'DELETE' then
    perform public.audit(old.workspace_id, 'invite.deleted', old.email, '{}'::jsonb);
  elsif new.accepted_at is not null and old.accepted_at is null then
    perform public.audit(new.workspace_id, 'invite.accepted', new.email, '{}'::jsonb);
  elsif new.revoked_at is not null and old.revoked_at is null then
    perform public.audit(new.workspace_id, 'invite.revoked', new.email, '{}'::jsonb);
  end if;
  return null;
end
$$;
create trigger audit_invites after insert or update or delete on public.invites
  for each row execute function public.audit_invites();

-- ---------------------------------------------------------------------------
-- Privileged operations (RPC)
-- ---------------------------------------------------------------------------

-- Creating a workspace makes the caller its owner and adds the built-in
-- Full Access role. Not available to MCP connections.
create function public.create_workspace(p_name text) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if public.is_oauth_client() then
    raise exception 'workspaces cannot be created over an AI connection' using errcode = '42501';
  end if;
  insert into public.workspaces (name, owner_id) values (btrim(p_name), auth.uid()) returning id into v_id;
  insert into public.memberships (workspace_id, user_id) values (v_id, auth.uid());
  insert into public.roles (workspace_id, name, kind, is_builtin)
  values (v_id, 'Full Access', 'full_access', true);
  return v_id;
end
$$;

create function public.hash_invite_token(p_token text) returns text
language sql immutable
set search_path = ''
as $$ select encode(sha256(convert_to(p_token, 'UTF8')), 'hex') $$;

-- What an invite link points at, for the accept page. Requires the secret token.
create function public.invite_preview(p_token text)
returns table (workspace_name text, email text, usable boolean)
language sql stable security definer
set search_path = ''
as $$
  select w.name, i.email,
         (i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
  from public.invites i
  join public.workspaces w on w.id = i.workspace_id
  where i.token_hash = public.hash_invite_token(p_token)
$$;

-- Accepting an invite creates a membership with NO role. The invite must have
-- been issued to the caller's own email address.
create function public.accept_invite(p_token text) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_inv public.invites%rowtype;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if public.is_oauth_client() then
    raise exception 'invites cannot be accepted over an AI connection' using errcode = '42501';
  end if;
  select * into v_inv from public.invites
  where token_hash = public.hash_invite_token(p_token)
  for update;
  if not found or v_inv.accepted_at is not null or v_inv.revoked_at is not null
     or v_inv.expires_at <= now() then
    raise exception 'this invite is no longer valid' using errcode = 'P0001';
  end if;
  select p.email into v_email from public.profiles p where p.id = auth.uid();
  if lower(v_email) <> lower(v_inv.email) then
    raise exception 'this invite was sent to a different email address' using errcode = '42501';
  end if;
  insert into public.memberships (workspace_id, user_id)
  values (v_inv.workspace_id, auth.uid())
  on conflict (workspace_id, user_id) do nothing;
  update public.invites set accepted_at = now() where id = v_inv.id;
  return v_inv.workspace_id;
end
$$;

-- Ownership transfer: owner only, web session only, fresh login, audited.
-- The previous owner stays a member with no role until the new owner assigns one.
create function public.transfer_ownership(p_workspace uuid, p_new_owner uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_owner(p_workspace) then
    raise exception 'only the owner can transfer ownership' using errcode = '42501';
  end if;
  if public.is_oauth_client() then
    raise exception 'ownership cannot be transferred over an AI connection' using errcode = '42501';
  end if;
  if not public.recently_authenticated() then
    raise exception 'reauthentication required' using errcode = 'P0403';
  end if;
  if p_new_owner = auth.uid() then
    raise exception 'you already own this workspace' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace and m.user_id = p_new_owner
      and (m.expires_at is null or m.expires_at > now())
  ) then
    raise exception 'the new owner must be a current member' using errcode = 'P0001';
  end if;
  update public.workspaces set owner_id = p_new_owner where id = p_workspace;
  -- Owners hold no role row; ownership is the whole grant.
  update public.memberships set role_id = null, expires_at = null
  where workspace_id = p_workspace and user_id = p_new_owner;
end
$$;

-- Create or update a custom/guest role and replace its permission map in one
-- transaction. SECURITY INVOKER on purpose: it has no powers of its own, so
-- the RLS policies and guard triggers above still decide whether it succeeds.
-- p_permissions: { "<page>": { "level": "view|edit|manage", "sensitive": bool } }
create function public.save_role(
  p_workspace uuid, p_role_id uuid, p_name text, p_kind public.role_kind, p_permissions jsonb
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid := p_role_id;
begin
  if v_id is null then
    insert into public.roles (workspace_id, name, kind)
    values (p_workspace, btrim(p_name), p_kind) returning id into v_id;
  else
    update public.roles set name = btrim(p_name), kind = p_kind
    where id = v_id and workspace_id = p_workspace;
    if not found then
      raise exception 'role not found or not permitted' using errcode = '42501';
    end if;
  end if;

  delete from public.role_permissions rp
  where rp.role_id = v_id
    and not (coalesce(p_permissions, '{}'::jsonb) ? rp.page
             and coalesce(p_permissions -> rp.page ->> 'level', 'none') <> 'none');

  insert into public.role_permissions (role_id, workspace_id, page, level, sensitive)
  select v_id, p_workspace, e.key, (e.value ->> 'level')::public.level,
         coalesce((e.value ->> 'sensitive')::boolean, false)
  from jsonb_each(coalesce(p_permissions, '{}'::jsonb)) as e
  where coalesce(e.value ->> 'level', 'none') <> 'none'
  on conflict (role_id, page) do update
    set level = excluded.level, sensitive = excluded.sensitive
    where role_permissions.level is distinct from excluded.level
       or role_permissions.sensitive is distinct from excluded.sensitive;

  return v_id;
end
$$;

-- Names for assignee pickers and bylines. Anyone with access to at least one page.
create function public.workspace_people(p_workspace uuid)
returns table (user_id uuid, display_name text)
language sql stable security definer
set search_path = ''
as $$
  select m.user_id, p.display_name
  from public.memberships m
  join public.profiles p on p.id = m.user_id
  where m.workspace_id = p_workspace
    and public.has_any_access(p_workspace)
  order by p.display_name
$$;

-- Full member list with emails and roles. Needs Settings view (owner, Full Access).
create function public.workspace_members(p_workspace uuid)
returns table (user_id uuid, email text, display_name text, role_id uuid,
               expires_at timestamptz, is_owner boolean, joined_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select m.user_id, p.email, p.display_name, m.role_id, m.expires_at,
         (w.owner_id = m.user_id), m.created_at
  from public.memberships m
  join public.profiles p on p.id = m.user_id
  join public.workspaces w on w.id = m.workspace_id
  where m.workspace_id = p_workspace
    and public.access_level(p_workspace, 'settings') >= 'view'
  order by (w.owner_id = m.user_id) desc, p.display_name
$$;

-- ---------------------------------------------------------------------------
-- Row-level security: default deny, then explicit policies.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.memberships enable row level security;
alter table public.invites enable row level security;
alter table public.audit_log enable row level security;

-- profiles: you can read and rename yourself. Other people's names come from
-- workspace_people() / workspace_members(), which check access first.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- workspaces: members can see the workspace exists (its name). No direct insert.
create policy workspaces_select on public.workspaces for select to authenticated
  using (public.is_member(id));
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.access_level(id, 'settings') >= 'manage')
  with check (public.access_level(id, 'settings') >= 'manage');
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (public.can_manage_roles(id));

-- roles and their permissions: readable with Settings view, or if it is your own role.
create policy roles_select on public.roles for select to authenticated
  using (public.access_level(workspace_id, 'settings') >= 'view' or id = public.my_role_id(workspace_id));
create policy roles_insert on public.roles for insert to authenticated
  with check (public.can_manage_roles(workspace_id));
create policy roles_update on public.roles for update to authenticated
  using (public.can_manage_roles(workspace_id)) with check (public.can_manage_roles(workspace_id));
create policy roles_delete on public.roles for delete to authenticated
  using (public.can_manage_roles(workspace_id));

create policy role_permissions_select on public.role_permissions for select to authenticated
  using (public.access_level(workspace_id, 'settings') >= 'view' or role_id = public.my_role_id(workspace_id));
create policy role_permissions_insert on public.role_permissions for insert to authenticated
  with check (public.can_manage_roles(workspace_id));
create policy role_permissions_update on public.role_permissions for update to authenticated
  using (public.can_manage_roles(workspace_id)) with check (public.can_manage_roles(workspace_id));
create policy role_permissions_delete on public.role_permissions for delete to authenticated
  using (public.can_manage_roles(workspace_id));

-- memberships: no direct insert (only create_workspace / accept_invite).
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = auth.uid() or public.access_level(workspace_id, 'settings') >= 'view');
create policy memberships_update on public.memberships for update to authenticated
  using (public.can_manage_roles(workspace_id)) with check (public.can_manage_roles(workspace_id));
-- The owner removes members; anyone except the owner may leave.
create policy memberships_delete on public.memberships for delete to authenticated
  using (
    public.can_manage_roles(workspace_id)
    or (user_id = auth.uid() and not public.is_owner(workspace_id) and not public.is_oauth_client())
  );

-- invites: Settings manage (owner or Full Access). Invites carry no access.
create policy invites_select on public.invites for select to authenticated
  using (public.access_level(workspace_id, 'settings') >= 'manage');
create policy invites_insert on public.invites for insert to authenticated
  with check (public.access_level(workspace_id, 'settings') >= 'manage'
              and invited_by = auth.uid() and not public.is_oauth_client()
              and accepted_at is null and revoked_at is null);
create policy invites_update on public.invites for update to authenticated
  using (public.access_level(workspace_id, 'settings') >= 'manage' and not public.is_oauth_client())
  with check (public.access_level(workspace_id, 'settings') >= 'manage' and accepted_at is null);

-- audit log: owner reads; nobody writes directly; nobody updates or deletes.
create policy audit_log_select on public.audit_log for select to authenticated
  using (public.is_owner(workspace_id) and not public.is_oauth_client());

-- ---------------------------------------------------------------------------
-- Grants. Signed-out visitors get nothing; signed-in users get table access
-- that RLS then narrows. Internal functions are not callable by clients.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- A user may rename themselves but never change the email on their profile:
-- invites are matched against it and owners read it when assigning roles.
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.roles, public.role_permissions to authenticated;
grant select, update, delete on public.memberships to authenticated;
grant select, insert, update on public.invites to authenticated;
grant select on public.audit_log to authenticated;

grant execute on function
  public.app_pages(), public.is_oauth_client(), public.recently_authenticated(integer),
  public.is_owner(uuid), public.is_member(uuid), public.access_level(uuid, text),
  public.can_see_sensitive(uuid, text), public.has_any_access(uuid), public.my_role_id(uuid),
  public.can_manage_roles(uuid), public.my_access(uuid), public.is_client_role(),
  public.log_event(uuid, text, text, jsonb, text, text), public.log_login(),
  public.create_workspace(text), public.hash_invite_token(text), public.invite_preview(text),
  public.accept_invite(text), public.transfer_ownership(uuid, uuid),
  public.save_role(uuid, uuid, text, public.role_kind, jsonb),
  public.workspace_people(uuid), public.workspace_members(uuid)
to authenticated;

-- Tables added by later migrations start with no client access. (Functions are
-- executable by PUBLIC by default in Postgres and that cannot be switched off
-- per schema, so every migration ends with an explicit revoke; a test checks it.)
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
