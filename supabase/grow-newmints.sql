-- =====================================================================
-- $CHRONIC — live new-mint firehose (fed by tools/newmints-listener.js).
-- Run after grow-schema.sql. Idempotent.
-- =====================================================================
create table if not exists grow_newmints (
  mint       text primary key,
  name       text,
  symbol     text,
  image      text,
  uri        text,
  creator    text,
  sol        numeric,
  created_at timestamptz not null default now()
);
create index if not exists grow_newmints_recent_idx on grow_newmints (created_at desc);

alter table grow_newmints enable row level security;
drop policy if exists "anon_read_newmints" on grow_newmints;
create policy "anon_read_newmints" on grow_newmints for select using (true);
