-- =====================================================================
-- $CHRONIC MEME GEN — per-IP daily usage cap for /api/meme (Venice AI).
-- Server-only (service_role). Best-effort cost guard; the endpoint still
-- works if this table is absent (it just won't rate-limit). Run once.
-- =====================================================================
create table if not exists grow_meme_usage (
  ip         text not null,
  day        date not null,
  count      integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (ip, day)
);
alter table grow_meme_usage enable row level security;
-- no anon policies on purpose; /api/meme uses the service key (bypasses RLS).

-- spent payment signatures (pay-to-generate). PK = sig => one image per payment.
create table if not exists grow_meme_paid (
  sig        text primary key,
  wallet     text,
  created_at timestamptz not null default now()
);
alter table grow_meme_paid enable row level security;
-- no anon policies; /api/meme (service key) is the only reader/writer.
