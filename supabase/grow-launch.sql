-- =====================================================================
-- $CHRONIC LAUNCHPAD — tokens deployed on the pad (+ the dev who launched,
-- for the 50% trading-fee split). Run after grow-schema.sql. Idempotent.
-- =====================================================================
create table if not exists grow_launches (
  mint        text primary key,
  dev_wallet  text not null,
  name        text,
  symbol      text,
  uri         text,
  image       text,
  created_at  timestamptz not null default now()
);
create index if not exists grow_launches_recent_idx on grow_launches (created_at desc);

alter table grow_launches enable row level security;
drop policy if exists "anon_read_launches" on grow_launches;
create policy "anon_read_launches" on grow_launches for select using (true);
-- writes happen only through the API with the service key.
