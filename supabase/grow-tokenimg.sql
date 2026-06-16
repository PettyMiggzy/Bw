-- =====================================================================
-- $CHRONIC — token PFP cache (filled by /api/tokenimg).
-- Persists resolved on-chain metadata images so the terminal board is instant
-- even on a cold serverless start. Idempotent.
-- =====================================================================
create table if not exists grow_tokenimg (
  mint       text primary key,
  image      text,
  updated_at timestamptz not null default now()
);

alter table grow_tokenimg enable row level security;
drop policy if exists "anon_read_tokenimg" on grow_tokenimg;
create policy "anon_read_tokenimg" on grow_tokenimg for select using (true);
