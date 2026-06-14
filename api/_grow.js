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
 *   POOL_TOKEN_ACCOUNT      - the pool wallet's $CHRONIC associated token acct
 *                             (the 40% lands here; burner now, your wallet later)
 */

const crypto = require('crypto');

const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MINT = process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump';
const DECIMALS = parseInt(process.env.CHRONIC_DECIMALS || '6', 10);
const POOL_TOKEN_ACCOUNT = process.env.POOL_TOKEN_ACCOUNT || '';

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// ---------------------------------------------------------------------------
// product catalog — MUST stay in sync with grow.html. Prices in whole $CHRONIC.
// burn = 60%, pool = 40%. xp is awarded on sell (seeds only).
// ---------------------------------------------------------------------------
const SEEDS = {
  mids:   { cost: 250,   grow: 30000,  xp: 10   },
  loud:   { cost: 1200,  grow: 60000,  xp: 60   },
  gas:    { cost: 5000,  grow: 120000, xp: 320  },
  exotic: { cost: 20000, grow: 240000, xp: 1600 },
};
const UPGRADES = {
  light: { base: 3000,  mul: 1.9,  max: 8 },
  nutes: { base: 4000,  mul: 1.85, max: 10 },
  plot:  { base: 8000,  mul: 2.1,  max: 5 },
  auto:  { base: 60000, mul: 1,    max: 1 },
};
const BURN_BPS = 6000; // 60.00%
const POOL_BPS = 4000; // 40.00%

const base = (whole) => BigInt(Math.round(whole)) * (10n ** BigInt(DECIMALS));
const splitOf = (totalBase) => {
  const t = BigInt(totalBase);
  const burn = (t * BigInt(BURN_BPS)) / 10000n;
  return { burn, pool: t - burn }; // pool gets the remainder so burn+pool === total exactly
};
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
  await fetch(`${SB_URL}/rest/v1/${table}${q}`, {
    method: 'POST',
    headers: sbHeaders({ prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row),
  });
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
    if (ix && ix.program === 'spl-token' && ix.parsed) out.push(ix.parsed);
  };
  if (msg && Array.isArray(msg.instructions)) msg.instructions.forEach(push);
  const inner = tx && tx.meta && tx.meta.innerInstructions;
  if (Array.isArray(inner)) inner.forEach((g) => (g.instructions || []).forEach(push));
  return out;
}

/*
 * Verify a buy tx actually burned 60% and pooled 40% of `expectedTotalBase`,
 * signed by `wallet`, against our mint + pool account.
 * Returns { ok, reason?, burn, pool }.
 */
async function verifyBuyTx(sig, wallet, expectedTotalBase) {
  if (!POOL_TOKEN_ACCOUNT) return { ok: false, reason: 'pool_not_configured' };
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
  const ix = collectTokenIx(tx);
  let gotBurn = 0n, gotPool = 0n;

  for (const p of ix) {
    const t = p.type, info = p.info || {};
    const amt = info.tokenAmount ? BigInt(info.tokenAmount.amount) : (info.amount ? BigInt(info.amount) : 0n);
    // mint guard (burnChecked/transferChecked carry mint; plain burn/transfer don't)
    if (info.mint && info.mint !== MINT) continue;

    if ((t === 'burn' || t === 'burnChecked') && info.authority === wallet) {
      gotBurn += amt;
    } else if ((t === 'transfer' || t === 'transferChecked') &&
               info.destination === POOL_TOKEN_ACCOUNT && info.authority === wallet) {
      gotPool += amt;
    }
  }

  if (gotBurn < needBurn) return { ok: false, reason: 'burn_short' };
  if (gotPool < needPool) return { ok: false, reason: 'pool_short' };
  return { ok: true, burn: needBurn.toString(), pool: needPool.toString() };
}

module.exports = {
  SOLANA_RPC, MINT, DECIMALS, POOL_TOKEN_ACCOUNT,
  SEEDS, UPGRADES, BURN_BPS, POOL_BPS,
  base, splitOf, upgradeCost,
  sbEnabled, sbHeaders, sbRpc, sbSelect, sbUpsert,
  b58decode, isPubkey, verifySignature, solRpc, verifyBuyTx,
};
