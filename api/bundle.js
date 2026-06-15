'use strict';
/*
 * /api/bundle?ca=<mint> — Solana bundle / insider checker.
 * Read-only on-chain forensics (uses SOLANA_RPC = your Alchemy). Reports:
 *   - supply + holder concentration (top holders, % of supply)
 *   - launch snipers (earliest buyers + % taken in the first slot)
 *   - funding clusters (wallets funded by the same source = a bundle)
 *   - a 0-100 bundle/rug-risk score
 * Every section is best-effort so partial results still return.
 */
const G = require('./_grow.js');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'; // pump.fun bonding-curve program
const SYS = '11111111111111111111111111111111';            // System Program (normal wallets)
// known AMM / pool programs — for labelling; the generic "non-system-owned"
// check below already catches these, this is just belt-and-suspenders.
const POOL_PROGRAMS = new Set([
  PUMP,
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',   // pump.fun AMM (pumpswap)
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',   // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',   // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',   // Raydium CPMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',   // Meteora DLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',    // Orca Whirlpool
]);
const TOP = 20;          // holders to inspect
const TRACE = 12;        // wallets to trace funding for
const EARLY = 16;        // earliest buyers to inspect

const big = (s) => { try { return BigInt(s); } catch (_) { return 0n; } };
const pct = (part, whole) => (whole > 0n ? Number((part * 10000n) / whole) / 100 : 0);

async function rpc(method, params) { return G.solRpc(method, params); }

// oldest chunk of signatures for an address (+ whether we reached its creation)
async function oldestSigs(addr, pages) {
  let before = null, page = [], reachedEnd = false;
  for (let i = 0; i < pages; i++) {
    const opt = { limit: 1000 }; if (before) opt.before = before;
    const r = await rpc('getSignaturesForAddress', [addr, opt]);
    if (!r || !r.length) { reachedEnd = true; break; }
    page = r; before = r[r.length - 1].signature;
    if (r.length < 1000) { reachedEnd = true; break; }
  }
  return { page, reachedEnd };
}

// who first funded `wallet` with SOL (best-effort)
async function funderOf(wallet) {
  try {
    const { page } = await oldestSigs(wallet, 2);
    if (!page.length) return null;
    const sig = page[page.length - 1].signature; // oldest
    const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    if (!tx) return null;
    const keys = (tx.transaction.message.accountKeys || []).map((k) => k.pubkey || k);
    const signer = (tx.transaction.message.accountKeys || []).find((k) => k.signer);
    const payer = signer ? (signer.pubkey || signer) : keys[0];
    if (payer && payer !== wallet) return payer; // the account that paid/sent = funder
    // else: find the account whose SOL balance dropped the most (the source)
    const pre = tx.meta.preBalances || [], post = tx.meta.postBalances || [];
    let best = null, drop = 0;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === wallet) continue;
      const d = (pre[i] || 0) - (post[i] || 0);
      if (d > drop) { drop = d; best = keys[i]; }
    }
    return best;
  } catch (_) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (require('./_guard.js').blocked(req, res)) return;
  const ca = (req.query.ca || '').toString().trim();
  if (!G.isPubkey(ca)) return res.status(400).json({ error: 'paste a valid token CA (mint address)' });

  const out = { ca, supply: null, holders: null, launch: null, funding: null, score: null, notes: [] };

  // the pump.fun bonding-curve PDA for this mint is always-known (derived, no
  // RPC), so we can exclude it from concentration + snipers even if the heavy
  // holder calls fail or get rate-limited.
  let CURVE = null;
  try {
    const { PublicKey } = require('@solana/web3.js');
    const [c] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(ca).toBuffer()], new PublicKey(PUMP));
    CURVE = c.toBase58();
  } catch (_) { /* web3 unavailable — fall back to on-chain owner detection */ }

  // ── supply ──
  let supply = 0n, decimals = 6;
  try {
    const s = await rpc('getTokenSupply', [ca]);
    supply = big(s.value.amount); decimals = s.value.decimals;
    out.supply = { amount: s.value.amount, decimals, uiAmount: s.value.uiAmountString };
  } catch (e) { out.notes.push('supply unavailable'); }

  // ── holders / concentration ──
  const ownerOf = {};            // tokenAccount -> owner
  const lpOwners = new Set();     // authorities that are pools/curves (not insiders)
  if (CURVE) lpOwners.add(CURVE); // the bonding curve, always
  let topHolders = [];
  try {
    const la = await rpc('getTokenLargestAccounts', [ca]);
    const accts = (la.value || []).slice(0, TOP);
    if (accts.length) {
      const infos = await rpc('getMultipleAccounts', [accts.map((a) => a.address), { encoding: 'jsonParsed' }]);
      (infos.value || []).forEach((acc, i) => {
        const owner = acc && acc.data && acc.data.parsed && acc.data.parsed.info && acc.data.parsed.info.owner;
        ownerOf[accts[i].address] = owner || null;
      });
      // resolve which authorities are pools/curves (program-owned PDAs) vs real
      // wallets (System-Program owned). The bonding curve, Raydium/pumpswap
      // vaults, etc. are NOT insiders — exclude them from concentration.
      const uniqOwners = [...new Set(Object.values(ownerOf).filter(Boolean))];
      if (uniqOwners.length) {
        try {
          const oi = await rpc('getMultipleAccounts', [uniqOwners, { encoding: 'base64' }]);
          (oi.value || []).forEach((acc, i) => {
            const prog = acc && acc.owner;            // the program that owns this authority
            if (prog && (prog !== SYS || POOL_PROGRAMS.has(uniqOwners[i]))) lpOwners.add(uniqOwners[i]);
          });
        } catch (_) { /* fall back to PUMP-only below */ }
      }
      topHolders = accts.map((a) => {
        const owner = ownerOf[a.address];
        const amt = big(a.amount);
        const isLP = !!owner && (owner === PUMP || lpOwners.has(owner) || POOL_PROGRAMS.has(owner));
        return { owner, tokenAccount: a.address, amount: a.amount, pct: pct(amt, supply), lp: isLP };
      });
      const realHolders = topHolders.filter((h) => !h.lp);
      const top10 = realHolders.slice(0, 10).reduce((s, h) => s + big(h.amount), 0n);
      const top20 = realHolders.reduce((s, h) => s + big(h.amount), 0n);
      const firstReal = realHolders[0]; // topHolders is sorted desc, so this is the biggest wallet
      out.holders = {
        count: topHolders.length,
        lpExcluded: topHolders.length - realHolders.length,
        top10Pct: pct(top10, supply),
        top20Pct: pct(top20, supply),
        largestPct: firstReal ? firstReal.pct : 0,
        top: topHolders.map((h) => ({ owner: h.owner, pct: h.pct, lp: h.lp })),
      };
    }
  } catch (e) { out.notes.push('holders unavailable'); }

  // ── launch snipers (earliest buyers) ──
  const earlyBuyers = []; // {wallet, amount, slot}
  try {
    const { page, reachedEnd } = await oldestSigs(ca, 3);
    const oldest = page.slice(-Math.min(EARLY + 2, page.length)).reverse(); // chronological-ish
    let firstSlot = null;
    for (const s of oldest) {
      if (earlyBuyers.length >= EARLY) break;
      const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      if (!tx || (tx.meta && tx.meta.err)) continue;
      const b = buyerFrom(tx, ca, lpOwners);
      if (!b) continue;
      if (lpOwners.has(b.owner) || b.owner === PUMP || POOL_PROGRAMS.has(b.owner)) continue; // the curve isn't a sniper
      if (firstSlot == null) firstSlot = tx.slot;
      earlyBuyers.push({ wallet: b.owner, amount: b.amount, slot: tx.slot });
    }
    const firstSlotAmt = earlyBuyers.filter((b) => b.slot === firstSlot).reduce((s, b) => s + big(b.amount), 0n);
    out.launch = {
      reachedCreation: reachedEnd,
      firstSlot,
      buyers: earlyBuyers.slice(0, 12).map((b) => ({ wallet: b.wallet, pct: pct(big(b.amount), supply), slot: b.slot })),
      sniperCount: earlyBuyers.filter((b) => b.slot === firstSlot).length,
      sniperPct: pct(firstSlotAmt, supply),
    };
  } catch (e) { out.notes.push('launch scan unavailable'); }

  // ── funding clusters ──
  try {
    const wallets = [];
    topHolders.forEach((h) => { if (h.owner && !h.lp && wallets.indexOf(h.owner) < 0) wallets.push(h.owner); });
    earlyBuyers.forEach((b) => { if (b.wallet && wallets.indexOf(b.wallet) < 0) wallets.push(b.wallet); });
    const pick = wallets.slice(0, TRACE);
    const funders = await mapLimit(pick, 4, async (w) => ({ w, f: await funderOf(w) }));
    const byFunder = {};
    funders.forEach(({ w, f }) => { if (!f) return; (byFunder[f] = byFunder[f] || []).push(w); });
    const clusters = Object.keys(byFunder).map((f) => ({ funder: f, wallets: byFunder[f], size: byFunder[f].length }))
      .filter((c) => c.size >= 2).sort((a, b) => b.size - a.size);
    out.funding = {
      traced: pick.length,
      clusters: clusters.slice(0, 6),
      biggestCluster: clusters.length ? clusters[0].size : 0,
    };
  } catch (e) { out.notes.push('funding trace unavailable'); }

  // ── score (0-100, higher = more bundled/risky) ──
  try {
    let score = 0; const flags = [];
    const h = out.holders, l = out.launch, f = out.funding;
    if (h) {
      if (h.top10Pct >= 50) { score += 35; flags.push(`top 10 hold ${h.top10Pct}%`); }
      else if (h.top10Pct >= 30) { score += 20; flags.push(`top 10 hold ${h.top10Pct}%`); }
      else if (h.top10Pct >= 15) { score += 8; }
      if (h.largestPct >= 25) { score += 10; flags.push(`one wallet holds ${h.largestPct}%`); }
    }
    if (l && l.sniperPct >= 25) { score += 30; flags.push(`${l.sniperPct}% sniped in the launch slot (${l.sniperCount} wallets)`); }
    else if (l && l.sniperPct >= 10) { score += 15; flags.push(`${l.sniperPct}% sniped at launch`); }
    if (f && f.biggestCluster >= 5) { score += 25; flags.push(`${f.biggestCluster} wallets funded by one source 🚩`); }
    else if (f && f.biggestCluster >= 3) { score += 15; flags.push(`${f.biggestCluster} wallets share a funder`); }
    else if (f && f.biggestCluster === 2) { score += 6; }
    score = Math.min(100, score);
    out.score = { value: score, level: score >= 60 ? 'high' : score >= 30 ? 'med' : 'low', flags };
  } catch (e) { out.notes.push('score unavailable'); }

  res.status(200).json(out);
};

// the buyer in a tx = owner whose $mint token balance increased the most,
// ignoring the bonding curve / pool authorities (they receive the minted
// supply on the create tx and aren't snipers).
function buyerFrom(tx, mint, lpOwners) {
  const pre = (tx.meta.preTokenBalances || []).filter((b) => b.mint === mint);
  const post = (tx.meta.postTokenBalances || []).filter((b) => b.mint === mint);
  const m = {};
  pre.forEach((b) => { m[b.owner] = (m[b.owner] || 0n) - big(b.uiTokenAmount.amount); });
  post.forEach((b) => { m[b.owner] = (m[b.owner] || 0n) + big(b.uiTokenAmount.amount); });
  let best = null, amt = 0n;
  for (const owner in m) {
    if (owner === PUMP || POOL_PROGRAMS.has(owner) || (lpOwners && lpOwners.has(owner))) continue;
    if (m[owner] > amt) { amt = m[owner]; best = owner; }
  }
  return best ? { owner: best, amount: amt.toString() } : null;
}
async function mapLimit(arr, limit, fn) {
  const out = []; let i = 0;
  async function worker() { while (i < arr.length) { const idx = i++; out[idx] = await fn(arr[idx]); } }
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker));
  return out;
}
