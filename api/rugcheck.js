'use strict';
/*
 * GET /api/rugcheck?ca=<mint>  — the Rug Radar safety scan.
 *
 * On Solana launchpads (pump.fun/Bonk) every token is the SAME standard SPL
 * program, so "read the contract" doesn't apply — there's nothing custom to
 * read. People still get rugged, just by different vectors. This endpoint reads
 * the on-chain facts that ACTUALLY decide whether a launch can rug you, scores
 * them, and explains each one in plain English so the scan teaches as it grades:
 *
 *   - mint authority    → can the dev print more supply and dump on you?
 *   - freeze authority   → can the dev freeze your wallet so you can't sell?
 *   - holder spread      → does one wallet / the top 10 hold enough to nuke it?
 *   - dev bag            → how much does the creator still hold?
 *   - liquidity          → escrowed on the curve (can't be pulled) vs migrated?
 *
 * Reuses the proven pool/curve-exclusion logic from /api/holders so the
 * concentration numbers are real wallet concentration, not "the curve holds 80%".
 * No auth — read-only, anon-safe.
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
const r1 = (n) => Math.round(n * 10) / 10;

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, max-age=30');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (require('./_guard.js').blocked(req, res)) return;
  const ca = (req.query.ca || '').toString().trim();
  if (!G.isPubkey(ca)) return res.status(400).json({ error: 'bad ca' });

  try {
    // 1) mint account: authorities + supply + decimals
    const acc = await G.solRpc('getAccountInfo', [ca, { encoding: 'jsonParsed' }]);
    const info = acc && acc.value && acc.value.data && acc.value.data.parsed && acc.value.data.parsed.info;
    if (!info) return res.status(200).json({ ok: false, error: 'not an SPL mint (or not found yet)' });
    const mintAuth = info.mintAuthority || null;
    const freezeAuth = info.freezeAuthority || null;
    const decimals = Number(info.decimals) || 0;
    const supply = big(info.supply);

    // 2) holder concentration — pool/curve excluded (mirrors /api/holders)
    let CURVE = null;
    try { const { PublicKey } = require('@solana/web3.js'); const [c] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(ca).toBuffer()], new PublicKey(PUMP)); CURVE = c.toBase58(); } catch (_) {}

    const la = await G.solRpc('getTokenLargestAccounts', [ca]);
    const accts = (la.value || []).slice(0, 20);
    const ownerOf = {};
    let escrowed = 0n;
    if (accts.length) {
      const infos = await G.solRpc('getMultipleAccounts', [accts.map((a) => a.address), { encoding: 'jsonParsed' }]);
      (infos.value || []).forEach((a, i) => { const o = a && a.data && a.data.parsed && a.data.parsed.info && a.data.parsed.info.owner; ownerOf[accts[i].address] = o || null; });
    }
    const lpOwners = new Set(); if (CURVE) lpOwners.add(CURVE);
    const uniq = [...new Set(Object.values(ownerOf).filter(Boolean))];
    if (uniq.length) {
      try {
        const oi = await G.solRpc('getMultipleAccounts', [uniq, { encoding: 'base64' }]);
        (oi.value || []).forEach((a, i) => { const prog = a && a.owner; if (prog && (prog !== SYS || POOL_PROGRAMS.has(uniq[i]))) lpOwners.add(uniq[i]); });
      } catch (_) {}
    }
    const isPool = (o) => o && (lpOwners.has(o) || POOL_PROGRAMS.has(o) || o === PUMP);
    const real = [];
    accts.forEach((a) => { const o = ownerOf[a.address]; const amt = big(a.amount); if (isPool(o)) escrowed += amt; else real.push({ owner: o, amt }); });
    const top10 = real.slice(0, 10).reduce((s, h) => s + h.amt, 0n);
    const largest = real.length ? real[0].amt : 0n;
    const largestPct = pct(largest, supply);
    const top10Pct = pct(top10, supply);
    const escrowedPct = pct(escrowed, supply);

    // 3) dev/creator bag (CHRONIC, or a pad-launched token we recorded)
    let DEV = (ca === CHRONIC) ? CHRONIC_DEV : null;
    if (!DEV && G.sbEnabled()) {
      try { const rows = await G.sbSelect(`grow_launches?mint=eq.${encodeURIComponent(ca)}&select=dev_wallet`); if (rows && rows[0] && G.isPubkey(rows[0].dev_wallet)) DEV = rows[0].dev_wallet; } catch (_) {}
    }
    let devPct = null;
    if (DEV) { const d = real.find((h) => h.owner === DEV); devPct = d ? pct(d.amt, supply) : 0; }

    // 4) score it — each check carries a plain-English "why this matters"
    const checks = [];
    let score = 100;
    const add = (c) => { checks.push(c); score -= (c.penalty || 0); };

    add(mintAuth
      ? { key: 'mint', label: 'Mint authority', value: 'ACTIVE', status: 'bad', penalty: 35,
          why: 'the dev can still mint NEW tokens out of thin air and dump them on you. supply is not fixed. this is the classic infinite-print rug.' }
      : { key: 'mint', label: 'Mint authority', value: 'revoked', status: 'good',
          why: 'revoked — nobody can print more supply. what you see is the whole supply, forever.' });

    add(freezeAuth
      ? { key: 'freeze', label: 'Freeze authority', value: 'ACTIVE', status: 'bad', penalty: 35,
          why: 'the dev can FREEZE your wallet, locking your tokens so you literally cannot sell while they exit. hard red flag — walk away.' }
      : { key: 'freeze', label: 'Freeze authority', value: 'revoked', status: 'good',
          why: 'revoked — no one can freeze or blacklist your wallet. you can always sell.' });

    if (real.length) {
      const lp = largestPct;
      add(lp >= 20
        ? { key: 'whale', label: 'Top wallet', value: r1(lp) + '%', status: 'bad', penalty: 25,
            why: 'one wallet holds ' + r1(lp) + '% of supply. if they sell, the chart is gone in one tx. that much in a single hand is a loaded gun.' }
        : lp >= 8
        ? { key: 'whale', label: 'Top wallet', value: r1(lp) + '%', status: 'warn', penalty: 10,
            why: 'biggest wallet holds ' + r1(lp) + '%. not fatal, but watch it — a holder that size moving is a real dump.' }
        : { key: 'whale', label: 'Top wallet', value: r1(lp) + '%', status: 'good',
            why: 'biggest single wallet is only ' + r1(lp) + '%. no one hand can nuke it. healthy spread.' });

      const t = top10Pct;
      add(t >= 40
        ? { key: 'top10', label: 'Top 10 hold', value: r1(t) + '%', status: 'bad', penalty: 18,
            why: 'the top 10 wallets control ' + r1(t) + '% between them. that\'s a bundle — they can coordinate an exit on you.' }
        : t >= 25
        ? { key: 'top10', label: 'Top 10 hold', value: r1(t) + '%', status: 'warn', penalty: 8,
            why: 'top 10 hold ' + r1(t) + '%. a bit concentrated — fine if they\'re real, ugly if they\'re one person\'s bundle.' }
        : { key: 'top10', label: 'Top 10 hold', value: r1(t) + '%', status: 'good',
            why: 'top 10 only hold ' + r1(t) + '% combined. supply is spread across real buyers, not a cartel.' });
    } else {
      add({ key: 'holders', label: 'Holders', value: 'none yet', status: 'warn', penalty: 5,
            why: 'no real holders outside the curve yet — brand new. nothing to read into the spread until people actually buy.' });
    }

    if (devPct !== null) {
      add(devPct >= 10
        ? { key: 'dev', label: 'Dev bag', value: r1(devPct) + '%', status: 'bad', penalty: 15,
            why: 'the creator is holding ' + r1(devPct) + '% themselves. devs that size their own bag this big usually plan to sell it.' }
        : devPct >= 3
        ? { key: 'dev', label: 'Dev bag', value: r1(devPct) + '%', status: 'warn', penalty: 6,
            why: 'creator holds ' + r1(devPct) + '%. normal-ish, but it\'s their sell pressure sitting there. keep an eye on the dev wallet.' }
        : { key: 'dev', label: 'Dev bag', value: r1(devPct) + '%', status: 'good',
            why: 'creator only holds ' + r1(devPct) + '%. not stacked against you.' });
    }

    add(escrowedPct >= 40
      ? { key: 'liq', label: 'Liquidity', value: 'on curve', status: 'good',
          why: 'still on the launchpad bonding curve — the liquidity is escrowed by the program and the dev CANNOT pull it. the risk here is holders dumping, not an LP rug. watch the graduation.' }
      : { key: 'liq', label: 'Liquidity', value: 'migrated / AMM', status: 'warn',
          why: 'graduated to an AMM pool. the curve no longer protects you — confirm the LP tokens are burned or locked before you trust the liquidity.' });

    // hard red flags cap the grade no matter how clean everything else is
    if (mintAuth || freezeAuth) score = Math.min(score, 45);
    score = Math.max(0, Math.min(100, Math.round(score)));
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
    const bads = checks.filter((c) => c.status === 'bad').length;
    const verdict = (mintAuth || freezeAuth) ? 'danger'
      : bads >= 1 || score < 55 ? 'sketchy'
      : score >= 85 ? 'clean' : 'mixed';

    return res.status(200).json({
      ok: true, ca, score, grade, verdict,
      checks,
      facts: {
        decimals, supply: supply.toString(),
        largestPct: r1(largestPct), top10Pct: r1(top10Pct),
        escrowedPct: r1(escrowedPct), onCurve: escrowedPct >= 40,
        dev: DEV || null, devPct: devPct === null ? null : r1(devPct),
        mintAuthority: mintAuth, freezeAuthority: freezeAuth,
        sampled: accts.length, realHolders: real.length,
      },
    });
  } catch (e) { return res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
};
