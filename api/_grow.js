'use strict';
/*
 * Shared helpers for the $CHRONIC GROW backend (/api/grow).
 * Zero npm deps — uses global fetch + Node's built-in crypto.
 * Underscore-prefixed => excluded from Vercel routing (plain module).
 *
 * Env (set in Vercel project settings, NEVER commit real values):
 *   SUPABASE_URL            - your project URL
 *   SUPABASE_SERVICE_KEY    - service_role key (server-only; bypasses RLS)
 *   SOLANA_RPC              - Solana RPC URL (default: public mainnet-beta)
 *   CHRONIC_MINT            - SPL mint (default: the live pump.fun mint)
 *   CHRONIC_DECIMALS        - token decimals (default: 6)
 *   POOL_WALLET             - the pool wallet ADDRESS (the 40% lands in its
 *                             $CHRONIC token account; burner now, your wallet
 *                             later). Alias: POOL_TOKEN_ACCOUNT also accepted.
 */

const crypto = require('crypto');

const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MINT = process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump';
const DECIMALS = parseInt(process.env.CHRONIC_DECIMALS || '6', 10);
// the pool wallet ADDRESS (owner). The 40% is verified by its token-balance
// gain, so you only need the plain wallet address — not a token account.
const POOL_WALLET = process.env.POOL_WALLET || process.env.POOL_TOKEN_ACCOUNT || '';

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// ---------------------------------------------------------------------------
// product catalog — MUST stay in sync with grow.html. Prices in whole $CHRONIC.
// burn = 50%, 50% to the pool wallet (40% credited to the prize pool, 10% treasury). xp is awarded on sell (seeds only).
// ---------------------------------------------------------------------------
const SEEDS = {
  mids:   { cost: 50000,   grow: 30000,  xp: 50   },
  loud:   { cost: 250000,  grow: 60000,  xp: 300  },
  gas:    { cost: 1000000, grow: 120000, xp: 1400 },
  exotic: { cost: 5000000, grow: 240000, xp: 8000 },
};
const UPGRADES = {
  light: { base: 150000,  mul: 1.9,  max: 8 },
  nutes: { base: 200000,  mul: 1.85, max: 10 },
  plot:  { base: 400000,  mul: 2.1,  max: 8 },
  auto:  { base: 3000000, mul: 1,    max: 1 },
};
const BURN_BPS = 5000; // 50.00% burned
const POOL_BPS = 5000; // 50.00% sent to the pool wallet (burn+pool = 100% of the buy, kept as ONE transfer)
const POOL_CREDIT_BPS = 4000; // of the buy, 40% is credited to the prize pool (paid to winners); the remaining 10% accrues in the pool wallet as treasury (owner moves it out as needed)
const MARKET_FEE_BPS = 500; // 5.00% of each P2P sale is burned; 95% to seller

// watering: each water shaves WATER_PCT of grow time, up to MAX_WATERS, with a
// cooldown between taps. XP is NOT affected (XP only from verified burns).
const MAX_WATERS = 5;
const WATER_PCT = 0.10;
const WATER_COOLDOWN_MS = 5000;

// harvest quality roll — multiplies the sale's XP. Adds payoff variance;
// still burn-gated (you only harvest seeds you bought), so it can't be farmed.
const QUALITY = [
  { name: 'common', mult: 1.0, w: 65 },
  { name: 'fire',   mult: 1.6, w: 25 },
  { name: 'exotic', mult: 2.5, w: 10 },
];
function rollQuality() {
  let r = Math.random() * 100, acc = 0;
  for (const q of QUALITY) { acc += q.w; if (r < acc) return q; }
  return QUALITY[0];
}

// effective state of a plot given the player's upgrade levels + waters
function plotState(plot, lvl) {
  const seed = SEEDS[plot.strain] || SEEDS.mids;
  const light = (lvl && lvl.light) || 0, nutes = (lvl && lvl.nutes) || 0;
  const gt = Math.round(seed.grow * Math.pow(0.85, light));
  const waters = plot.w || 0;
  const elapsed = (Date.now() - plot.at) + gt * WATER_PCT * waters;
  return { gt, waters, ripe: elapsed >= gt, xp: Math.round(seed.xp * Math.pow(1.4, nutes)) };
}

const base = (whole) => BigInt(Math.round(whole)) * (10n ** BigInt(DECIMALS));
const splitOf = (totalBase) => {
  const t = BigInt(totalBase);
  const burn = (t * BigInt(BURN_BPS)) / 10000n;
  return { burn, pool: t - burn }; // pool gets the remainder so burn+pool === total exactly (this is what the buy tx must burn + transfer)
};
// how much of a buy is credited to the prize pool (winners). The gap between
// this and splitOf().pool (10% of the buy) stays in the pool wallet as treasury.
const poolCreditOf = (totalBase) => (BigInt(totalBase) * BigInt(POOL_CREDIT_BPS)) / 10000n;
// cost of the next level of an upgrade given the current owned level
const upgradeCost = (key, lvl) => {
  const u = UPGRADES[key]; if (!u) return null;
  return Math.round(u.base * Math.pow(u.mul, lvl));
};

// ---------------------------------------------------------------------------
// Supabase (PostgREST) — service key, server-only.
// ---------------------------------------------------------------------------
function sbEnabled() { return Boolean(SB_URL && SB_KEY); }
function sbHeaders(extra) {
  return Object.assign({
    apikey: SB_KEY,
    authorization: `Bearer ${SB_KEY}`,
    'content-type': 'application/json',
  }, extra || {});
}
async function sbRpc(fn, args) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: sbHeaders(), body: JSON.stringify(args || {}),
  });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : null; } catch (_) { j = txt; }
  if (!r.ok) throw new Error(`supabase rpc ${fn}: ${r.status} ${txt.slice(0, 200)}`);
  return j;
}
async function sbSelect(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`supabase select ${path}: ${r.status}`);
  return r.json();
}
async function sbUpsert(table, row, onConflict) {
  const q = onConflict ? `?on_conflict=${onConflict}` : '';
  const r = await fetch(`${SB_URL}/rest/v1/${table}${q}`, {
    method: 'POST',
    headers: sbHeaders({ prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row),
  });
  // surface failures — a silently-failed nonce rotation would reopen the replay window
  if (!r.ok) throw new Error(`supabase upsert ${table}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// base58 (Solana) — decode only, no deps.
// ---------------------------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  if (typeof str !== 'string' || !str.length) return null;
  const map = {}; for (let i = 0; i < B58.length; i++) map[B58[i]] = i;
  let bytes = [0];
  for (const ch of str) {
    const val = map[ch]; if (val === undefined) return null;
    let carry = val;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}
const isPubkey = (s) => { const b = b58decode(s); return !!b && b.length === 32; };

// ---------------------------------------------------------------------------
// ed25519 signature verify (sign-in-with-Solana).
// pubkey: base58 (32 bytes). message: utf8 string. signature: base64 (64 bytes).
// ---------------------------------------------------------------------------
function verifySignature(pubkeyB58, message, signatureB64) {
  try {
    const pub = b58decode(pubkeyB58); if (!pub || pub.length !== 32) return false;
    const sig = Buffer.from(signatureB64, 'base64'); if (sig.length !== 64) return false;
    // wrap the raw 32-byte ed25519 key as SPKI DER for crypto.verify
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Solana RPC + transaction verification.
// ---------------------------------------------------------------------------
async function solRpc(method, params) {
  const r = await fetch(SOLANA_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`solana ${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

// pull every spl-token instruction (top-level + inner) as parsed objects
function collectTokenIx(tx) {
  const out = [];
  const msg = tx && tx.transaction && tx.transaction.message;
  const push = (ix) => {
    if (ix && (ix.program === 'spl-token' || ix.program === 'spl-token-2022') && ix.parsed) out.push(ix.parsed);
  };
  if (msg && Array.isArray(msg.instructions)) msg.instructions.forEach(push);
  const inner = tx && tx.meta && tx.meta.innerInstructions;
  if (Array.isArray(inner)) inner.forEach((g) => (g.instructions || []).forEach(push));
  return out;
}

// sum an owner's $CHRONIC balance across a token-balances array (base units)
function ownerBalanceOf(arr, owner) {
  return (arr || []).reduce((acc, b) => {
    if (b.owner === owner && b.mint === MINT) {
      try { return acc + BigInt(b.uiTokenAmount.amount); } catch (_) { return acc; }
    }
    return acc;
  }, 0n);
}
const poolBalance = (arr) => ownerBalanceOf(arr, POOL_WALLET);

// verify a P2P market payment: buyer burned the 5% fee + paid 95% to the seller
async function verifyMarketTx(sig, buyer, sellerWallet, priceBase) {
  if (typeof sig !== 'string' || sig.length < 80 || sig.length > 100) return { ok: false, reason: 'bad_sig' };
  const total = BigInt(priceBase);
  const fee = (total * BigInt(MARKET_FEE_BPS)) / 10000n;
  const toSeller = total - fee;

  const tx = await solRpc('getTransaction', [sig, {
    encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  }]);
  if (!tx) return { ok: false, reason: 'tx_not_found' };
  if (tx.meta && tx.meta.err) return { ok: false, reason: 'tx_failed' };
  const keys = tx.transaction.message.accountKeys || [];
  const signer = keys.find((k) => k.signer);
  if (!signer || (signer.pubkey || signer) !== buyer) return { ok: false, reason: 'wrong_signer' };

  let gotBurn = 0n;
  for (const p of collectTokenIx(tx)) {
    const t = p.type, info = p.info || {};
    if (info.mint && info.mint !== MINT) continue;
    const amt = info.tokenAmount ? BigInt(info.tokenAmount.amount) : (info.amount ? BigInt(info.amount) : 0n);
    if ((t === 'burn' || t === 'burnChecked') && info.authority === buyer) gotBurn += amt;
  }
  if (fee > 0n && gotBurn < fee) return { ok: false, reason: 'fee_short' };

  const gotSeller = ownerBalanceOf(tx.meta.postTokenBalances, sellerWallet) - ownerBalanceOf(tx.meta.preTokenBalances, sellerWallet);
  if (gotSeller < toSeller) return { ok: false, reason: 'seller_short' };
  return { ok: true };
}

/*
 * Verify a buy tx actually burned 50% and moved 50% to the pool wallet of `expectedTotalBase`,
 * signed by `wallet`. The pool credit is checked via the pool WALLET's
 * token-balance gain (pre->post), so POOL_WALLET is a plain wallet address.
 * Returns { ok, reason?, burn, pool }.
 */
async function verifyBuyTx(sig, wallet, expectedTotalBase) {
  if (!POOL_WALLET) return { ok: false, reason: 'pool_not_configured' };
  if (typeof sig !== 'string' || sig.length < 80 || sig.length > 100) return { ok: false, reason: 'bad_sig' };

  const tx = await solRpc('getTransaction', [sig, {
    encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  }]);
  if (!tx) return { ok: false, reason: 'tx_not_found' };
  if (tx.meta && tx.meta.err) return { ok: false, reason: 'tx_failed' };

  // signer / fee payer must be the claiming wallet
  const keys = tx.transaction.message.accountKeys || [];
  const signer = keys.find((k) => k.signer);
  const signerPk = signer ? (signer.pubkey || signer) : null;
  if (signerPk !== wallet) return { ok: false, reason: 'wrong_signer' };

  const { burn: needBurn, pool: needPool } = splitOf(expectedTotalBase);

  // burn: from the parsed spl-token burn instruction(s) authored by the wallet
  let gotBurn = 0n;
  for (const p of collectTokenIx(tx)) {
    const t = p.type, info = p.info || {};
    if (info.mint && info.mint !== MINT) continue;
    const amt = info.tokenAmount ? BigInt(info.tokenAmount.amount) : (info.amount ? BigInt(info.amount) : 0n);
    if ((t === 'burn' || t === 'burnChecked') && info.authority === wallet) gotBurn += amt;
  }
  if (gotBurn < needBurn) return { ok: false, reason: 'burn_short' };

  // pool: the pool wallet's $CHRONIC balance must rise by >= the 50% share (40% credited to winners, 10% treasury)
  const gotPool = poolBalance(tx.meta.postTokenBalances) - poolBalance(tx.meta.preTokenBalances);
  if (gotPool < needPool) return { ok: false, reason: 'pool_short' };

  return { ok: true, burn: needBurn.toString(), pool: needPool.toString() };
}

module.exports = {
  SOLANA_RPC, MINT, DECIMALS, POOL_WALLET,
  SEEDS, UPGRADES, BURN_BPS, POOL_BPS, POOL_CREDIT_BPS, MARKET_FEE_BPS,
  MAX_WATERS, WATER_PCT, WATER_COOLDOWN_MS, plotState,
  QUALITY, rollQuality,
  base, splitOf, poolCreditOf, upgradeCost,
  sbEnabled, sbHeaders, sbRpc, sbSelect, sbUpsert,
  b58decode, isPubkey, verifySignature, solRpc, verifyBuyTx, verifyMarketTx,
};
