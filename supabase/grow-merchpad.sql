-- Merch Pad partner requests — projects that want a $CHRONIC-powered merch store.
-- Written server-side by /api/merchpad.js (service key). RLS on, no anon access.

create table if not exists public.grow_merchpad (
  id            bigint generated always as identity primary key,
  project       text not null,        -- the project/brand name
  contact_name  text,                 -- who's asking
  contact       text not null,        -- email / TG / X to reach them
  wallet        text,                  -- payout wallet (SOL), optional
  details       text,                  -- what they want (products, ideas)
  art_url       text,                  -- link to their logo/art, optional
  status        text default 'new',    -- new | contacted | live | passed
  created_at    timestamptz default now()
);

create index if not exists grow_merchpad_created_idx on public.grow_merchpad (created_at desc);

alter table public.grow_merchpad enable row level security;
-- service key (api/merchpad.js) bypasses RLS; no anon policies.
