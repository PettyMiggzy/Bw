-- =====================================================================
-- $CHRONIC GROW — game backend schema
-- Paste into Supabase SQL Editor -> Run. Idempotent: safe to re-run.
--
-- Trust model: the /api/grow serverless functions hold the SERVICE key and
-- are the only writers. They verify on-chain burns + wallet signatures BEFORE
-- calling the mutating RPCs below. RLS denies anon writes; anon may read the
-- public leaderboard + season info only.
-- =====================================================================

-- ───── tables ─────

-- one row per connected wallet — the player's persistent garden + upgrades
create table if not exists grow_players (
  wallet      text primary key,                       -- base58 Solana pubkey
  lvl         jsonb not null default '{"light":0,"nutes":0,"plot":0,"auto":0}'::jsonb,
  seeds       jsonb not null default '{}'::jsonb,      -- {strainKey: count} owned, unplanted
  plots       jsonb not null default '[]'::jsonb,      -- [{strain,at,sold}] active grows
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- weekly seasons. exactly one is "open" at a time (settled = false, now < ends_at)
create table if not exists grow_seasons (
  id          bigint generated always as identity primary key,
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz not null,
  pool_base   numeric not null default 0,             -- accumulated 40% pool, in token base units
  settled     boolean not null default false,
  winners     jsonb,                                  -- [{wallet,xp,amount_base,sig}] after settle
  settled_at  timestamptz
);

-- per-season XP per wallet (the leaderboard)
create table if not exists grow_scores (
  season_id   bigint not null references grow_seasons(id) on delete cascade,
  wallet      text   not null,
  xp          numeric not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (season_id, wallet)
);
create index if not exists grow_scores_board_idx on grow_scores (season_id, xp desc);

-- every verified on-chain purchase. PK = tx signature => idempotent + audit trail.
create table if not exists grow_purchases (
  sig         text primary key,                       -- Solana tx signature (verified once)
  wallet      text not null,
  kind        text not null,                          -- 'seed' | 'upgrade'
  item        text not null,                          -- strain key or upgrade key
  amount_base numeric not null,                       -- total $CHRONIC spent (base units)
  burn_base   numeric not null,                       -- 60% burned
  pool_base   numeric not null,                       -- 40% to pool
  season_id   bigint not null references grow_seasons(id),
  created_at  timestamptz not null default now()
);
create index if not exists grow_purchases_wallet_idx on grow_purchases (wallet, created_at desc);

-- short-lived login nonces (sign-in-with-Solana challenge)
create table if not exists grow_nonces (
  wallet      text primary key,
  nonce       text not null,
  created_at  timestamptz not null default now()
);

-- ───── RLS ─────
alter table grow_players   enable row level security;
alter table grow_seasons   enable row level security;
alter table grow_scores    enable row level security;
alter table grow_purchases enable row level security;
alter table grow_nonces    enable row level security;

-- anon may read the public board + season info; everything else is server-only.
drop policy if exists "anon_read_seasons" on grow_seasons;
create policy "anon_read_seasons" on grow_seasons for select using (true);
drop policy if exists "anon_read_scores" on grow_scores;
create policy "anon_read_scores" on grow_scores for select using (true);
-- (service_role bypasses RLS for all writes; no anon write policies on purpose)

-- ───── helpers ─────

-- return the open season, creating a fresh 7-day one if none / expired.
create or replace function grow_current_season()
returns grow_seasons
language plpgsql security definer set search_path = public as $$
declare s grow_seasons%rowtype;
begin
  select * into s from grow_seasons
   where settled = false and ends_at > now()
   order by id desc limit 1;
  if not found then
    insert into grow_seasons (starts_at, ends_at)
    values (now(), now() + interval '7 days')
    returning * into s;
  end if;
  return s;
end; $$;

-- ───── RPCs (called by the trusted API with the service key) ─────

-- record a verified purchase: bump pool, grant the item, lock idempotency on sig.
create or replace function grow_record_buy(
  p_wallet text, p_sig text, p_kind text, p_item text,
  p_amount numeric, p_burn numeric, p_pool numeric
) returns json
language plpgsql security definer set search_path = public as $$
declare s grow_seasons%rowtype; pl grow_players%rowtype; cur int;
begin
  if exists (select 1 from grow_purchases where sig = p_sig) then
    return json_build_object('ok', true, 'dupe', true);
  end if;
  s := grow_current_season();

  insert into grow_players (wallet) values (p_wallet) on conflict (wallet) do nothing;
  select * into pl from grow_players where wallet = p_wallet for update;

  insert into grow_purchases (sig, wallet, kind, item, amount_base, burn_base, pool_base, season_id)
  values (p_sig, p_wallet, p_kind, p_item, p_amount, p_burn, p_pool, s.id);

  update grow_seasons set pool_base = pool_base + p_pool where id = s.id;

  if p_kind = 'seed' then
    cur := coalesce((pl.seeds ->> p_item)::int, 0);
    update grow_players
       set seeds = jsonb_set(seeds, array[p_item], to_jsonb(cur + 1), true),
           updated_at = now()
     where wallet = p_wallet;
  elsif p_kind = 'upgrade' then
    cur := coalesce((pl.lvl ->> p_item)::int, 0);
    update grow_players
       set lvl = jsonb_set(lvl, array[p_item], to_jsonb(cur + 1), true),
           updated_at = now()
     where wallet = p_wallet;
  end if;

  return json_build_object('ok', true, 'season', s.id);
exception when others then
  return json_build_object('ok', false, 'reason', sqlerrm);
end; $$;

-- plant: consume one owned seed of p_strain into the plot array.
create or replace function grow_plant(p_wallet text, p_strain text)
returns json
language plpgsql security definer set search_path = public as $$
declare pl grow_players%rowtype; have int;
begin
  select * into pl from grow_players where wallet = p_wallet for update;
  if not found then return json_build_object('ok', false, 'reason', 'no_player'); end if;
  have := coalesce((pl.seeds ->> p_strain)::int, 0);
  if have < 1 then return json_build_object('ok', false, 'reason', 'no_seed'); end if;

  update grow_players set
    seeds = jsonb_set(seeds, array[p_strain], to_jsonb(have - 1), true),
    plots = plots || jsonb_build_object('strain', p_strain, 'at', extract(epoch from now())*1000, 'sold', false),
    updated_at = now()
  where wallet = p_wallet;
  return json_build_object('ok', true);
end; $$;

-- sell: mark plot index sold + credit fixed XP (computed & passed by the API,
-- which knows the ripeness rule + nutrient multiplier). XP is server-trusted
-- because it derives only from verified purchases, never client input.
create or replace function grow_sell(p_wallet text, p_idx int, p_xp numeric)
returns json
language plpgsql security definer set search_path = public as $$
declare s grow_seasons%rowtype; pl grow_players%rowtype; plot jsonb;
begin
  s := grow_current_season();
  select * into pl from grow_players where wallet = p_wallet for update;
  if not found then return json_build_object('ok', false, 'reason', 'no_player'); end if;
  plot := pl.plots -> p_idx;
  if plot is null then return json_build_object('ok', false, 'reason', 'no_plot'); end if;
  if (plot ->> 'sold')::boolean then return json_build_object('ok', false, 'reason', 'already_sold'); end if;

  update grow_players
     set plots = plots - p_idx, updated_at = now()
   where wallet = p_wallet;

  insert into grow_scores (season_id, wallet, xp) values (s.id, p_wallet, p_xp)
  on conflict (season_id, wallet) do update
     set xp = grow_scores.xp + p_xp, updated_at = now();

  return json_build_object('ok', true, 'xp_added', p_xp);
end; $$;

-- settle a finished season: record winners, mark settled, open next season.
-- Called by the settle script AFTER it has sent the on-chain payouts.
create or replace function grow_settle_season(p_season_id bigint, p_winners jsonb)
returns json
language plpgsql security definer set search_path = public as $$
declare s grow_seasons%rowtype;
begin
  select * into s from grow_seasons where id = p_season_id for update;
  if not found then return json_build_object('ok', false, 'reason', 'no_season'); end if;
  if s.settled then return json_build_object('ok', false, 'reason', 'already_settled'); end if;

  update grow_seasons
     set settled = true, winners = p_winners, settled_at = now()
   where id = p_season_id;

  -- ensure a fresh season exists for the next race
  perform grow_current_season();
  return json_build_object('ok', true);
end; $$;

-- ───── grants (service_role only; anon gets none of the mutators) ─────
grant execute on function grow_current_season() to service_role;
grant execute on function grow_record_buy(text,text,text,text,numeric,numeric,numeric) to service_role;
grant execute on function grow_plant(text,text) to service_role;
grant execute on function grow_sell(text,int,numeric) to service_role;
grant execute on function grow_settle_season(bigint,jsonb) to service_role;
