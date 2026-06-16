-- $CHRONIC shop product reviews. Read + written server-side by /api/review.js
-- (service key). RLS on, no anon policies — only the API touches this table.

create table if not exists public.grow_reviews (
  id          bigint generated always as identity primary key,
  product_id  text not null,                       -- matches PRODUCTS[].id in shop.html
  rating      int  not null check (rating between 1 and 5),
  name        text,
  body        text,
  approved    boolean default true,                -- flip to false + add moderation later if spammed
  created_at  timestamptz default now()
);

create index if not exists grow_reviews_product_idx on public.grow_reviews (product_id, created_at desc);

alter table public.grow_reviews enable row level security;
-- No policies => anon/auth get nothing directly. The service key (api/review.js)
-- bypasses RLS, so reads/writes only happen through our origin-guarded endpoint.
