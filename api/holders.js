'use strict';
/*
 * GET /api/holders?ca=<mint> — quick top-holder concentration for the terminal.
 * A light version of /api/bundle: just top10/top20/largest % of supply, with the
 * bonding curve + AMM pools/vaults excluded (so it's real wallet concentration,
 * not "the curve holds 80%"). No sniper/funding trace, so it returns in ~1-2s.
 */
const G = require('./_grow.js');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CHRONIC = process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump';
const CHRONIC_DEV = process.env.CHRONIC_DEV_WALLET || 'E7Cr2nad1SvBWF8vcGhNW575UVVPdTcgHEqSTMQzoUr5';
const SYS = '11111111111111111111111111111111';
const POOL_PROGRAMS = new Set([
  PUMP,
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
]);
const big = (s) => { try { return BigInt(s); } catch (_) { return 0n; } };
const pct = (part, whole) => (whole > 0n ? Number((part * 10000n) / whole) / 100 : 0);

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (require('./_guard.js').blocked(req, res)) return;
  const ca = (req.query.ca || '').toString().trim();
  if (!G.isPubkey(ca)) return res.status(400).json({ error: 'bad ca' });

  try {
    const sup = await G.solRpc('getTokenSupply', [ca]);
    const supply = big(sup.value.amount);

    // bonding curve PDA — always excluded
    let CURVE = null;
    try { const { PublicKey } = require('@solana/web3.js'); const [c] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(ca).toBuffer()], new PublicKey(PUMP)); CURVE = c.toBase58(); } catch (_) {}

    const la = await G.solRpc('getTokenLargestAccounts', [ca]);
    const accts = (la.value || []).slice(0, 20);
    if (!accts.length) return res.status(200).json({ holders: 0 });

    const infos = await G.solRpc('getMultipleAccounts', [accts.map((a) => a.address), { encoding: 'jsonParsed' }]);
    const ownerOf = {};
    (infos.value || []).forEach((acc, i) => { const o = acc && acc.data && acc.data.parsed && acc.data.parsed.info && acc.data.parsed.info.owner; ownerOf[accts[i].address] = o || null; });

    // pools/curves = authorities that are program-owned (not normal wallets)
    const lpOwners = new Set(); if (CURVE) lpOwners.add(CURVE);
    const uniq = [...new Set(Object.values(ownerOf).filter(Boolean))];
    if (uniq.length) {
      try {
        const oi = await G.solRpc('getMultipleAccounts', [uniq, { encoding: 'base64' }]);
        (oi.value || []).forEach((acc, i) => { const prog = acc && acc.owner; if (prog && (prog !== SYS || POOL_PROGRAMS.has(uniq[i]))) lpOwners.add(uniq[i]); });
      } catch (_) {}
    }

    const real = accts.map((a) => ({ owner: ownerOf[a.address], amt: big(a.amount) }))
      .filter((h) => !(h.owner && (lpOwners.has(h.owner) || POOL_PROGRAMS.has(h.owner) || h.owner === PUMP)));
    const top10 = real.slice(0, 10).reduce((s, h) => s + h.amt, 0n);
    const top20 = real.reduce((s, h) => s + h.amt, 0n);
    const largest = real.length ? real[0].amt : 0n;

    // resolve the project's dev/creator wallet (CHRONIC, or a pad-launched token)
    let DEV = (ca === CHRONIC) ? CHRONIC_DEV : null;
    if (!DEV && G.sbEnabled()) {
      try { const rows = await G.sbSelect(`grow_launches?mint=eq.${encodeURIComponent(ca)}&select=dev_wallet`); if (rows && rows[0] && G.isPubkey(rows[0].dev_wallet)) DEV = rows[0].dev_wallet; } catch (_) {}
    }
    let devPct = 0, devIsBiggest = false;
    if (DEV) { const d = real.find((h) => h.owner === DEV); if (d) { devPct = pct(d.amt, supply); devIsBiggest = !!(real.length && real[0].owner === DEV); } }

    return res.status(200).json({
      top10Pct: pct(top10, supply), top20Pct: pct(top20, supply), largestPct: pct(largest, supply),
      lpExcluded: accts.length - real.length, sampled: accts.length,
      dev: DEV || null, devPct, devIsBiggest,
    });
  } catch (e) { return res.status(200).json({ error: String((e && e.message) || e) }); }
};
