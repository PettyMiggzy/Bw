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

-- No anon INSERT policy: inserts go through /api/nft, which verifies the mint
-- on-chain (the Minted event) and writes with the service_role key (bypasses
-- RLS). This blocks browsers from spamming/forging rows directly.
drop policy if exists chronic_nfts_insert on chronic_nfts;

-- Art + metadata live on IPFS (via /api/pin → Pinata). Supabase only indexes
-- mints for a fast gallery feed; it is not the source of truth for the NFTs.

-- Moderation: to pull an abusive post from the gallery, set hidden=true in
-- Table Editor (the chain entry + IPFS art stay — they're immutable — but it leaves the UI).
