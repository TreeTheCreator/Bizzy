-- File integrity: recorded size and type come from storage, and stored objects
-- that no file row points to can be found for cleanup.

-- ---------------------------------------------------------------------------
-- A file row is only accepted for an object that really exists, and its size
-- and type are copied from storage. Whatever the client sent is ignored, so
-- this holds for the raw API as well as the app.
-- ---------------------------------------------------------------------------

create function public.files_read_storage() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_meta jsonb;
begin
  select o.metadata into v_meta
  from storage.objects o
  where o.bucket_id = 'workspace-files' and o.name = new.storage_path;
  if not found then
    raise exception 'no stored object for this file' using errcode = '23514';
  end if;
  new.size_bytes := coalesce((v_meta ->> 'size')::bigint, 0);
  new.mime_type := left(coalesce(nullif(v_meta ->> 'mimetype', ''), 'application/octet-stream'), 200);
  return new;
end
$$;

create trigger files_read_storage before insert on public.files
  for each row execute function public.files_read_storage();

-- ---------------------------------------------------------------------------
-- Orphans: objects in the bucket with no file row. They come from uploads that
-- were never confirmed and from deletes that failed half-way. Only objects
-- older than a day are returned, far longer than an upload token lives (about
-- two hours), so an upload in progress is never touched.
--
-- Returns paths only. The cleanup worker removes them through the Storage API,
-- which also deletes the bytes; deleting storage.objects rows in SQL would not.
-- ---------------------------------------------------------------------------

create function public.file_orphans(p_limit integer default 200) returns setof text
language sql stable security definer
set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'workspace-files'
    and o.created_at < now() - interval '24 hours'
    and not exists (select 1 from public.files f where f.storage_path = o.name)
  order by o.created_at
  limit least(greatest(coalesce(p_limit, 200), 1), 1000)
$$;

revoke all on all functions in schema public from public, anon;
revoke execute on function public.files_read_storage(), public.file_orphans(integer) from authenticated;
grant execute on function public.file_orphans(integer) to service_role;
