-- $CHRONIC Community NFTs — Supabase schema
-- Paste into Supabase SQL Editor → New query → Run.
-- Project: cuqhqcmrgpdjlhyqztnc

-- ───── index of every community mint ─────
create table if not exists chronic_nfts (
  id           uuid primary key default gen_random_uuid(),
  contract     text not null,                 -- lowercase NFT contract
  token_id     bigint not null,
  creator      text not null,                 -- lowercase minter wallet
  name         text not null,
  description  text default '',
  image_url    text not null,                 -- public storage URL
  metadata_url text not null,                 -- tokenURI
  tx           text,
  hidden       boolean not null default false, -- moderation: hide from gallery
  created_at   timestamptz not null default now(),
  unique (contract, token_id)
);
create index if not exists chronic_nfts_created_idx on chronic_nfts (created_at desc);
create index if not exists chronic_nfts_creator_idx on chronic_nfts (creator);

-- ───── row-level security ─────
alter table chronic_nfts enable row level security;

drop policy if exists chronic_nfts_read on chronic_nfts;
create policy chronic_nfts_read on chronic_nfts
  for select using (hidden = false);

drop policy if exists chronic_nfts_insert on chronic_nfts;
create policy chronic_nfts_insert on chronic_nfts
  for insert with check (true);   -- client records its own mint after the tx confirms

-- ───── public storage bucket for art + metadata ─────
insert into storage.buckets (id, name, public)
values ('chronic-nfts', 'chronic-nfts', true)
on conflict (id) do nothing;

drop policy if exists chronic_obj_read on storage.objects;
create policy chronic_obj_read on storage.objects
  for select using (bucket_id = 'chronic-nfts');

drop policy if exists chronic_obj_insert on storage.objects;
create policy chronic_obj_insert on storage.objects
  for insert with check (bucket_id = 'chronic-nfts');

-- Moderation: to pull an abusive post from the gallery, set hidden=true in
-- Table Editor (the chain entry stays — it's immutable — but it leaves the UI).
