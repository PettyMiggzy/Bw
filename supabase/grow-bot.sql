-- =====================================================================
-- $CHRONIC GROW — auto-poster state (remembers what's been tweeted).
-- Server-only (service_role). Run after grow-schema.sql.
-- =====================================================================
create table if not exists grow_bot_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table grow_bot_state enable row level security;
-- no anon policies on purpose; the poster uses the service key (bypasses RLS).
