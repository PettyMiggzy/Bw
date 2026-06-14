-- =====================================================================
-- $CHRONIC GROW — player-to-player market ("The Plug")
-- Run AFTER grow-schema.sql. Idempotent: safe to re-run.
--
-- Players trade seeds / harvested nugs / rare strain NFTs. Payment is on-chain
-- (verified by the API): 5% of each sale is BURNED, 95% goes to the seller.
-- Items are game inventory moved in this DB once the API confirms payment.
-- =====================================================================

-- inventory: nugs (from harvests) + nfts (rare exotic drops)
alter table grow_players add column if not exists nugs jsonb not null default '[]'::jsonb;
alter table grow_players add column if not exists nfts jsonb not null default '[]'::jsonb;

create table if not exists grow_listings (
  id          bigint generated always as identity primary key,
  seller      text not null,
  kind        text not null,                 -- 'seed' | 'nug' | 'nft'
  item        jsonb not null,                -- snapshot {strain, quality?, serial?, iid?}
  price       numeric not null,              -- whole $CHRONIC
  status      text not null default 'active',-- active | reserved | sold | delisted
  buyer       text,
  reserved_at timestamptz,
  created_at  timestamptz not null default now(),
  sold_at     timestamptz,
  sig         text
);
create index if not exists grow_listings_browse_idx on grow_listings (status, created_at desc);
create index if not exists grow_listings_seller_idx on grow_listings (seller, status);

alter table grow_listings enable row level security;
drop policy if exists "anon_read_listings" on grow_listings;
create policy "anon_read_listings" on grow_listings for select using (true);

-- ───── list an item for sale (removes it from the seller's inventory) ─────
create or replace function grow_market_list(p_wallet text, p_kind text, p_iid text, p_price numeric)
returns json
language plpgsql security definer set search_path = public as $$
declare pl grow_players%rowtype; have int; arr jsonb; el jsonb; keep jsonb; snap jsonb; hit boolean := false;
begin
  if p_price is null or p_price < 1 then return json_build_object('ok', false, 'reason', 'bad_price'); end if;
  select * into pl from grow_players where wallet = p_wallet for update;
  if not found then return json_build_object('ok', false, 'reason', 'no_player'); end if;

  if p_kind = 'seed' then
    have := coalesce((pl.seeds ->> p_iid)::int, 0);
    if have < 1 then return json_build_object('ok', false, 'reason', 'no_item'); end if;
    update grow_players set seeds = jsonb_set(seeds, array[p_iid], to_jsonb(have - 1), true), updated_at = now()
     where wallet = p_wallet;
    snap := jsonb_build_object('strain', p_iid);
  elsif p_kind in ('nug','nft') then
    arr := case when p_kind='nug' then pl.nugs else pl.nfts end;
    keep := '[]'::jsonb;
    for el in select * from jsonb_array_elements(arr) loop
      if not hit and (el ->> 'id') = p_iid then snap := el; hit := true;
      else keep := keep || jsonb_build_array(el); end if;
    end loop;
    if not hit then return json_build_object('ok', false, 'reason', 'no_item'); end if;
    if p_kind='nug' then update grow_players set nugs = keep, updated_at = now() where wallet = p_wallet;
    else update grow_players set nfts = keep, updated_at = now() where wallet = p_wallet; end if;
  else
    return json_build_object('ok', false, 'reason', 'bad_kind');
  end if;

  insert into grow_listings (seller, kind, item, price) values (p_wallet, p_kind, snap, p_price);
  return json_build_object('ok', true);
end; $$;

-- ───── delist (return the item to the seller) ─────
create or replace function grow_market_delist(p_wallet text, p_id bigint)
returns json
language plpgsql security definer set search_path = public as $$
declare l grow_listings%rowtype; have int;
begin
  select * into l from grow_listings where id = p_id for update;
  if not found then return json_build_object('ok', false, 'reason', 'no_listing'); end if;
  if l.seller <> p_wallet then return json_build_object('ok', false, 'reason', 'not_seller'); end if;
  if l.status = 'sold' then return json_build_object('ok', false, 'reason', 'already_sold'); end if;
  -- allow delist if active, or reserved but the reservation went stale (>3 min)
  if l.status = 'reserved' and l.reserved_at > now() - interval '3 minutes' then
    return json_build_object('ok', false, 'reason', 'reserved'); end if;

  if l.kind = 'seed' then
    have := coalesce((select (seeds ->> (l.item->>'strain'))::int from grow_players where wallet = p_wallet), 0);
    update grow_players set seeds = jsonb_set(seeds, array[(l.item->>'strain')], to_jsonb(have + 1), true), updated_at = now()
     where wallet = p_wallet;
  elsif l.kind = 'nug' then
    update grow_players set nugs = nugs || jsonb_build_array(l.item), updated_at = now() where wallet = p_wallet;
  else
    update grow_players set nfts = nfts || jsonb_build_array(l.item), updated_at = now() where wallet = p_wallet;
  end if;
  update grow_listings set status = 'delisted' where id = p_id;
  return json_build_object('ok', true);
end; $$;

-- ───── reserve a listing for a buyer (blocks others while they pay) ─────
create or replace function grow_market_reserve(p_buyer text, p_id bigint)
returns json
language plpgsql security definer set search_path = public as $$
declare l grow_listings%rowtype;
begin
  select * into l from grow_listings where id = p_id for update;
  if not found then return json_build_object('ok', false, 'reason', 'no_listing'); end if;
  if l.seller = p_buyer then return json_build_object('ok', false, 'reason', 'own_listing'); end if;
  if l.status = 'sold' or l.status = 'delisted' then return json_build_object('ok', false, 'reason', 'gone'); end if;
  if l.status = 'reserved' and l.reserved_at > now() - interval '3 minutes' and l.buyer <> p_buyer then
    return json_build_object('ok', false, 'reason', 'reserved'); end if;
  update grow_listings set status = 'reserved', buyer = p_buyer, reserved_at = now() where id = p_id;
  return json_build_object('ok', true, 'seller', l.seller, 'price', l.price, 'kind', l.kind);
end; $$;

-- ───── complete a sale: API calls this AFTER verifying the on-chain payment ─────
create or replace function grow_market_complete(p_buyer text, p_id bigint, p_sig text)
returns json
language plpgsql security definer set search_path = public as $$
declare l grow_listings%rowtype; have int;
begin
  if exists (select 1 from grow_listings where sig = p_sig) then
    return json_build_object('ok', true, 'dupe', true); end if;
  select * into l from grow_listings where id = p_id for update;
  if not found then return json_build_object('ok', false, 'reason', 'no_listing'); end if;
  if l.status = 'sold' then return json_build_object('ok', false, 'reason', 'already_sold'); end if;
  if l.buyer <> p_buyer then return json_build_object('ok', false, 'reason', 'not_reserver'); end if;

  insert into grow_players (wallet) values (p_buyer) on conflict (wallet) do nothing;
  if l.kind = 'seed' then
    have := coalesce((select (seeds ->> (l.item->>'strain'))::int from grow_players where wallet = p_buyer), 0);
    update grow_players set seeds = jsonb_set(seeds, array[(l.item->>'strain')], to_jsonb(have + 1), true), updated_at = now()
     where wallet = p_buyer;
  elsif l.kind = 'nug' then
    update grow_players set nugs = nugs || jsonb_build_array(l.item), updated_at = now() where wallet = p_buyer;
  else
    update grow_players set nfts = nfts || jsonb_build_array(l.item), updated_at = now() where wallet = p_buyer;
  end if;
  update grow_listings set status = 'sold', sold_at = now(), sig = p_sig where id = p_id;
  return json_build_object('ok', true);
end; $$;

-- ───── grant a harvest drop (nug, + rare NFT) — API calls this on sell ─────
create or replace function grow_add_drop(p_wallet text, p_nug jsonb, p_nft jsonb)
returns json
language plpgsql security definer set search_path = public as $$
begin
  update grow_players set
    nugs = case when p_nug is not null and p_nug <> 'null'::jsonb then nugs || jsonb_build_array(p_nug) else nugs end,
    nfts = case when p_nft is not null and p_nft <> 'null'::jsonb then nfts || jsonb_build_array(p_nft) else nfts end,
    updated_at = now()
  where wallet = p_wallet;
  return json_build_object('ok', true);
end; $$;

grant execute on function grow_add_drop(text,jsonb,jsonb) to service_role;
grant execute on function grow_market_list(text,text,text,numeric) to service_role;
grant execute on function grow_market_delist(text,bigint) to service_role;
grant execute on function grow_market_reserve(text,bigint) to service_role;
grant execute on function grow_market_complete(text,bigint,text) to service_role;
