-- Secure Home Cloud: connect the existing Assignment 4 tables to Supabase Auth.
-- Based on the CREATE TABLE statements in the submitted Assignment 4 PDF.
-- Existing assignment rows are kept. Run once in Supabase SQL Editor.

begin;

alter table public."USER" add column if not exists auth_uid uuid;
create unique index if not exists user_auth_uid_unique on public."USER" (auth_uid);
-- Supabase Auth now owns passwords. The old password_hash column is not used.
alter table public."USER" alter column password_hash drop not null;

insert into storage.buckets (id, name, public, file_size_limit)
values ('home-files', 'home-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

insert into public."STORAGE" (storage_name, total_space_bytes, free_space_bytes, status)
select 'Supabase Demo Storage', 52428800, 52428800, 'online'
where not exists (select 1 from public."STORAGE" where storage_name = 'Supabase Demo Storage');

create or replace function public.app_ensure_user()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare result_id bigint;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public."USER" (username, password_hash, role, created_at, auth_uid)
  values ('app_' || replace(auth.uid()::text, '-', ''), null, 'user', now(), auth.uid())
  on conflict (auth_uid) do nothing;
  select user_id into result_id from public."USER" where auth_uid = auth.uid();
  return result_id;
end;
$$;
revoke all on function public.app_ensure_user() from public;
grant execute on function public.app_ensure_user() to authenticated;

create or replace function public.app_user_id()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select user_id from public."USER" where auth_uid = auth.uid() limit 1;
$$;
revoke all on function public.app_user_id() from public;
grant execute on function public.app_user_id() to authenticated;

create or replace function public.app_file_stats()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'total_files', count(*),
    'total_bytes', coalesce(sum(size_bytes), 0)
  )
  from public."FILE"
  where user_id = public.app_user_id();
$$;
revoke all on function public.app_file_stats() from public;
grant execute on function public.app_file_stats() to authenticated;

alter table public."USER" enable row level security;
alter table public."FILE" enable row level security;
alter table public."STORAGE" enable row level security;

drop policy if exists "app files read" on public."FILE";
create policy "app files read" on public."FILE" for select to authenticated
using (user_id = public.app_user_id());
drop policy if exists "app files add" on public."FILE";
create policy "app files add" on public."FILE" for insert to authenticated
with check (user_id = public.app_user_id()
  and storage_id = (select storage_id from public."STORAGE" where storage_name = 'Supabase Demo Storage' limit 1)
  and split_part(storage_path, '/', 1) = auth.uid()::text);
drop policy if exists "app files rename" on public."FILE";
create policy "app files rename" on public."FILE" for update to authenticated
using (user_id = public.app_user_id()) with check (user_id = public.app_user_id());
drop policy if exists "app files delete" on public."FILE";
create policy "app files delete" on public."FILE" for delete to authenticated
using (user_id = public.app_user_id());
drop policy if exists "app storage info" on public."STORAGE";
create policy "app storage info" on public."STORAGE" for select to authenticated
using (storage_name = 'Supabase Demo Storage');

grant select, insert, delete on public."FILE" to authenticated;
revoke update on public."FILE" from authenticated;
grant update (file_name) on public."FILE" to authenticated;
grant select on public."STORAGE" to authenticated;
do $$
declare seq_name text;
begin
  seq_name := pg_get_serial_sequence('public."FILE"', 'file_id');
  if seq_name is not null then execute format('grant usage on sequence %s to authenticated', seq_name); end if;
end;
$$;

drop policy if exists "app object read" on storage.objects;
create policy "app object read" on storage.objects for select to authenticated
using (bucket_id = 'home-files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "app object add" on storage.objects;
create policy "app object add" on storage.objects for insert to authenticated
with check (bucket_id = 'home-files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "app object delete" on storage.objects;
create policy "app object delete" on storage.objects for delete to authenticated
using (bucket_id = 'home-files' and (storage.foldername(name))[1] = auth.uid()::text);

-- If the old tables already have broad policies, inspect and tighten them.
-- PostgreSQL combines permissive policies with OR, so an old broad policy
-- could override the intended per-user restriction above.

commit;
notify pgrst, 'reload schema';
