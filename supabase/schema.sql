-- =====================================================================
-- BURNING $CHRONIC — Smoke Sessions schema
-- Paste this entire file into Supabase SQL Editor → Run
-- Idempotent: safe to re-run if you tweak something.
-- =====================================================================

-- ───── tables ─────

create table if not exists bw_sessions (
  id          uuid primary key default gen_random_uuid(),
  region      text not null check (char_length(region) between 1 and 80),
  lat         double precision not null,
  lng         double precision not null,
  strain      text not null check (char_length(strain) between 1 and 60),
  vibe        text check (vibe is null or char_length(vibe) <= 120),
  hits        integer not null default 1,
  device_fp   text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '4 hours 20 minutes')
);

create index if not exists bw_sessions_active_idx on bw_sessions (expires_at desc);
create index if not exists bw_sessions_device_idx on bw_sessions (device_fp, created_at desc);

create table if not exists bw_session_joins (
  session_id  uuid references bw_sessions(id) on delete cascade,
  device_fp   text not null,
  joined_at   timestamptz not null default now(),
  primary key (session_id, device_fp)
);

-- ───── RLS ─────

alter table bw_sessions      enable row level security;
alter table bw_session_joins enable row level security;

-- anon can READ active sessions (front-end visibility)
drop policy if exists "anon_read_active_sessions" on bw_sessions;
create policy "anon_read_active_sessions" on bw_sessions
  for select using (expires_at > now());

drop policy if exists "anon_read_joins" on bw_session_joins;
create policy "anon_read_joins" on bw_session_joins
  for select using (true);

-- no direct INSERT/UPDATE/DELETE from anon — everything goes through the RPCs below
-- (RPC functions use SECURITY DEFINER to bypass RLS safely)

-- ───── RPCs ─────

-- Drop a new session (rate-limited: 1 per device per 12h)
create or replace function bw_create_session(
  p_region    text,
  p_lat       double precision,
  p_lng       double precision,
  p_strain    text,
  p_vibe      text,
  p_device_fp text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_at  timestamptz;
  v_new_id   uuid;
begin
  if p_device_fp is null or length(p_device_fp) < 8 then
    return json_build_object('ok', false, 'reason', 'invalid_device');
  end if;

  -- Rate-limit: 1 session per device per 12h
  select max(created_at) into v_last_at
  from bw_sessions
  where device_fp = p_device_fp;

  if v_last_at is not null and v_last_at > now() - interval '12 hours' then
    return json_build_object(
      'ok', false,
      'reason', 'rate_limit',
      'wait_seconds', extract(epoch from (v_last_at + interval '12 hours' - now()))::int
    );
  end if;

  insert into bw_sessions (region, lat, lng, strain, vibe, device_fp)
  values (p_region, p_lat, p_lng, p_strain, nullif(p_vibe, ''), p_device_fp)
  returning id into v_new_id;

  return json_build_object('ok', true, 'id', v_new_id);
exception
  when others then
    return json_build_object('ok', false, 'reason', sqlerrm);
end;
$$;

-- Increment hits on an existing session (one join per device per session)
create or replace function bw_join_session(
  p_session_id uuid,
  p_device_fp  text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session   bw_sessions%rowtype;
  v_existing  boolean;
begin
  select * into v_session
  from bw_sessions
  where id = p_session_id and expires_at > now();

  if not found then
    return json_build_object('ok', false, 'reason', 'expired_or_missing');
  end if;

  select exists(
    select 1 from bw_session_joins
    where session_id = p_session_id and device_fp = p_device_fp
  ) into v_existing;

  if v_existing then
    return json_build_object('ok', false, 'reason', 'already_joined', 'hits', v_session.hits);
  end if;

  insert into bw_session_joins (session_id, device_fp)
  values (p_session_id, p_device_fp);

  update bw_sessions
  set hits = hits + 1
  where id = p_session_id
  returning hits into v_session.hits;

  return json_build_object('ok', true, 'hits', v_session.hits);
exception
  when others then
    return json_build_object('ok', false, 'reason', sqlerrm);
end;
$$;

-- Allow the anon role to execute the RPCs
grant execute on function bw_create_session(text, double precision, double precision, text, text, text) to anon;
grant execute on function bw_join_session(uuid, text) to anon;

-- ───── housekeeping ─────

-- Optional: auto-prune expired sessions (cron extension)
-- Uncomment to enable. Removes sessions >24h past expiry, every hour.
-- select cron.schedule(
--   'bw-prune-sessions',
--   '0 * * * *',
--   $$ delete from bw_sessions where expires_at < now() - interval '24 hours' $$
-- );
