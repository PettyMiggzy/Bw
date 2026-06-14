-- =====================================================================
-- $CHRONIC GROW — credit XP for a Blink (tweet) burn. Run after grow-schema.sql.
-- Idempotent on the tx signature (reuses grow_purchases as the ledger).
-- =====================================================================
create or replace function grow_credit_burn(p_wallet text, p_sig text, p_xp numeric, p_amount numeric)
returns json
language plpgsql security definer set search_path = public as $$
declare s grow_seasons%rowtype;
begin
  if exists (select 1 from grow_purchases where sig = p_sig) then
    return json_build_object('ok', true, 'dupe', true);
  end if;
  s := grow_current_season();
  insert into grow_players (wallet) values (p_wallet) on conflict (wallet) do nothing;
  insert into grow_purchases (sig, wallet, kind, item, amount_base, burn_base, pool_base, season_id)
    values (p_sig, p_wallet, 'blink', 'burn', p_amount, p_amount, 0, s.id);
  insert into grow_scores (season_id, wallet, xp) values (s.id, p_wallet, p_xp)
    on conflict (season_id, wallet) do update set xp = grow_scores.xp + p_xp, updated_at = now();
  return json_build_object('ok', true);
exception when others then
  return json_build_object('ok', false, 'reason', sqlerrm);
end; $$;

grant execute on function grow_credit_burn(text,text,numeric,numeric) to service_role;
