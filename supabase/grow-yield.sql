-- grow-yield.sql — totals for the "your share of the pool / pending yield" display.
-- Run once in the Supabase SQL editor. Safe to re-run (create or replace).
--
-- Returns the sum of XP and the player count for a season, so the API can
-- compute each grower's pro-rata share of the weekly pool:
--     your pending yield = pool * (your_xp / total_xp)

create or replace function grow_season_totals(p_season_id bigint)
returns table(total_xp numeric, players int)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(xp), 0)::numeric, count(*)::int
  from grow_scores
  where season_id = p_season_id;
$$;

grant execute on function grow_season_totals(bigint) to anon, authenticated, service_role;
