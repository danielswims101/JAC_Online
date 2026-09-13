-- Tidelyne auth hardening — applied to project gzqovsffnziumfbmqdes on 2026-09-13.
-- Kept here for reference/version control; the live database already has it.

-- 1. profiles: stop exposing every username to anyone holding the public anon key.
--    "Users see own profile" (ALL, auth.uid() = id) remains, so people still read their own row.
drop policy if exists "profiles are readable" on public.profiles;

-- 2. Username availability check that reveals only a yes/no, never the table.
create or replace function public.username_taken(candidate text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where lower(username) = lower(coalesce(candidate, ''))
  );
$$;
revoke all on function public.username_taken(text) from public;
grant execute on function public.username_taken(text) to anon, authenticated;
comment on function public.username_taken(text) is 'Public yes/no username availability check for the signup form. SECURITY DEFINER on purpose: profiles is not readable by anon.';

-- 3. Usernames are unique case-insensitively and must match the format the site enforces.
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username));
alter table public.profiles drop constraint if exists profiles_username_format;
alter table public.profiles add constraint profiles_username_format
  check (username ~ '^[A-Za-z0-9_]{3,24}$');

-- 4. Create the profile row on the server when an account is created, using the
--    username the site passes in signUp({ options: { data: { username } } }).
--    Works whether or not email confirmation is switched on. Falls back to a
--    generated name if the requested one was taken in a race.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  wanted   text := nullif(regexp_replace(coalesce(new.raw_user_meta_data->>'username', ''), '[^A-Za-z0-9_]', '', 'g'), '');
  fallback text := 'swimmer_' || substr(replace(new.id::text, '-', ''), 1, 8);
begin
  if wanted is null then
    return new; -- older clients create the profile themselves
  end if;
  if length(wanted) < 3 or length(wanted) > 24 then
    wanted := fallback;
  end if;
  begin
    insert into public.profiles (id, username) values (new.id, wanted);
  exception when unique_violation then
    insert into public.profiles (id, username) values (new.id, fallback)
    on conflict (id) do nothing;
  end;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to supabase_auth_admin;
comment on function public.handle_new_user() is 'Creates public.profiles row from signUp metadata (username). Fired by on_auth_user_created; not an API endpoint.';
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5. ai_usage is written and read only by the ask-ai Edge Function (service role).
--    RLS with no policies already blocks the public roles; make it explicit and
--    index the rate-limit lookup.
revoke all on table public.ai_usage from anon, authenticated;
create index if not exists ai_usage_user_created_idx on public.ai_usage (user_id, created_at desc);
