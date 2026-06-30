'use strict';
/*
 * /api/burnboard — Solana BURN LEADERBOARD. Ranks a curated set of tokens by the
 * % of supply burned (original − current), computed live on-chain via /api/solrpc.
 * $CHRONIC is flagged so the page can highlight it.
 *
 * Add a rival: drop its mint into DEFAULT_TOKENS. pump.fun tokens all start at 1B
 * supply, so you usually only need { mint, name, symbol } (orig defaults to 1e9).
 * For non-pump tokens, set orig = its original/max supply (whole tokens).
 * Or override the whole list with BURNBOARD_TOKENS env (JSON array).
 *
 * % burned = (orig − currentSupply) / orig.  getTokenSupply returns supply net of
 * SPL burns, so this is an honest "how much of the supply is gone" number.
 */
const G = require('./_grow.js');

const CHRONIC = process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump';

const DEFAULT_TOKENS = [
  { mint: CHRONIC, name: 'Chronic', symbol: 'CHRONIC', orig: 1e9, self: true },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', name: 'Bonk', symbol: 'BONK', orig: 100e12 },
  // add rivals here — pump.fun tokens: just { mint, name, symbol } (orig defaults to 1e9)
];

function tokenList() {
  try { const j = JSON.parse(process.env.BURNBOARD_TOKENS || ''); if (Array.isArray(j) && j.length) return j; } catch (_) {}
  return DEFAULT_TOKENS;
}

let _cache = { t: 0, v: null };

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (_cache.v && Date.now() - _cache.t < 60000) return res.status(200).json(_cache.v);

  const list = tokenList();
  const rows = await Promise.all(list.map(async (t) => {
    const orig = Number(t.orig) || 1e9;
    let current = null;
    try { const s = await G.solRpc('getTokenSupply', [t.mint]); current = Number(s.value.uiAmount); } catch (_) {}
    if (!(current >= 0)) return { mint: t.mint, error: true };
    const burned = Math.max(0, orig - current);
    return {
      mint: t.mint, name: t.name, symbol: (t.symbol || '').toUpperCase(), self: !!t.self,
      orig, current, burned, burnedPct: orig > 0 ? (burned / orig) * 100 : 0,
    };
  }));

  const valid = rows.filter((r) => !r.error).sort((a, b) => b.burnedPct - a.burnedPct);
  valid.forEach((r, i) => { r.rank = i + 1; });

  const out = { tokens: valid, count: valid.length, updatedAt: Date.now() };
  _cache = { t: Date.now(), v: out };
  return res.status(200).json(out);
};
