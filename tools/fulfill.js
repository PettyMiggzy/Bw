#!/usr/bin/env node
'use strict';
/*
 * fulfill.js — the $CHRONIC shop money-splitter. Point the shop's checkout at a
 * fresh FULFILLMENT wallet, and this worker splits every order hands-off:
 *
 *   order SOL lands in the fulfillment wallet
 *        │
 *        ├─ supplier COST → parked as USDC   (the $ to pay SmokeDrop's card charge)
 *        └─ NET PROFIT → 60% DEV  +  40% HOLDER rewards
 *
 * No burn. NOTHING is distributed until the order's cost is set aside first —
 * so you're never out of pocket on the charge. The 60/40 is on PROFIT only.
 *
 * How we know the cost (so we know your charge up front): each product carries a
 * server-side wholesale `cost` (what SmokeDrop bills you), set when you load the
 * catalog and recorded with the order at checkout. The worker parks that cost as
 * USDC (you off-ramp it to pay the card), then splits only the leftover profit.
 * Until per-order costs are wired, COST_RATIO approximates the cost share off the
 * top; set it to your real cost-of-goods ratio.
 *
 * Long-running — host on the droplet/Railway like feeburn: node fulfill.js
 *
 * Env:
 *   FULFILL_SECRET_KEY  (required) fulfillment wallet keypair, base58 or [json].
 *                       A FRESH wallet — never the pool/dev key.
 *   DEV_WALLET          (required) address that receives the dev share.
 *   HOLDER_WALLET       (required) rewards address the holder share drips from.
 *   SOLANA_RPC          your Alchemy RPC.
 *   DEV_SHARE           dev fraction 0..1 (default 0.60 → holders get the rest).
 *   COST_RATIO          0..1 parked as USDC for supplier cost before the split (default 0).
 *   RESERVE_SOL         SOL kept for gas, never moved (default 0.03).
 *   MIN_BATCH_SOL       don't act until this much is spendable (default 0.02).
 *   INTERVAL_MIN        minutes between splits (default 10).
 *   DRY_RUN             '1' (default) = log the plan, move nothing. Set '0' to go live.
 */
const { Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction, TransactionMessage } = require('@solana/web3.js');

// pure-JS base58 decode (bs58 v6's CJS export is flaky — same as feeburn.js)
const _B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  const map = {}; for (let i = 0; i < _B58.length; i++) map[_B58[i]] = i;
  let bytes = [0];
  for (const ch of str) {
    const val = map[ch]; if (val === undefined) throw new Error('bad base58 char');
    let carry = val;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const DEV_SHARE = Math.max(0, Math.min(1, parseFloat(process.env.DEV_SHARE || '0.60')));
const COST_RATIO = Math.max(0, Math.min(1, parseFloat(process.env.COST_RATIO || '0')));
const RESERVE_SOL = parseFloat(process.env.RESERVE_SOL || '0.03');
const MIN_BATCH_SOL = parseFloat(process.env.MIN_BATCH_SOL || '0.02');
const INTERVAL_MS = Math.max(1, parseFloat(process.env.INTERVAL_MIN || '10')) * 60 * 1000;
const DRY_RUN = process.env.DRY_RUN !== '0'; // safe by default
const JUP = 'https://lite-api.jup.ag/swap/v1';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function die(m) { console.error('✗ ' + m); process.exit(1); }
function addr(env, label) { const v = process.env[env]; if (!v) die(`${env} required (${label})`); try { return new PublicKey(v.trim()); } catch (_) { die(`${env} is not a valid address`); } }
function loadKp() {
  const r = process.env.FULFILL_SECRET_KEY;
  if (!r) die('FULFILL_SECRET_KEY required (base58 or JSON array) — use a FRESH wallet');
  const t = r.trim();
  return Keypair.fromSecretKey(t.startsWith('[') ? Uint8Array.from(JSON.parse(t)) : b58decode(t));
}
const DEV = addr('DEV_WALLET', 'receives the dev share');
const HOLDER = addr('HOLDER_WALLET', 'holder-rewards address');
const kp = loadKp();
const conn = new Connection(RPC, 'confirmed');
const f3 = (n) => Number(n).toFixed(3);

async function confirm(sig) {
  for (let i = 0; i < 40; i++) {
    const st = await conn.getSignatureStatuses([sig]); const v = st.value && st.value[0];
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) { if (v.err) throw new Error('tx err ' + JSON.stringify(v.err)); return; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('confirm timeout ' + sig);
}

// optional: swap `lamports` of SOL -> USDC, parked here to cover supplier cost
async function swapToUsdc(lamports) {
  const q = await (await fetch(`${JUP}/quote?inputMint=${SOL}&outputMint=${USDC}&amount=${lamports}&slippageBps=300`)).json();
  if (!q || q.error || !q.outAmount) throw new Error('no swap route');
  const usdc = Number(q.outAmount) / 1e6;
  if (DRY_RUN) { console.log(`  [dry] would park ${f3(lamports / 1e9)} SOL → ~$${usdc.toFixed(2)} USDC (supplier cost)`); return; }
  const s = await (await fetch(`${JUP}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) })).json();
  if (!s || !s.swapTransaction) throw new Error('swap build failed');
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64')); tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 }); await confirm(sig);
  console.log(`  💵 parked ~$${usdc.toFixed(2)} USDC for supplier cost — ${sig}`);
}

async function sendSol(to, lamports, label, emoji) {
  if (lamports <= 0) return;
  if (DRY_RUN) { console.log(`  [dry] would send ${f3(lamports / 1e9)} SOL → ${label} ${to.toBase58().slice(0, 4)}…`); return; }
  const bh = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: bh.blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg); tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 }); await confirm(sig);
  console.log(`  ${emoji} sent ${f3(lamports / 1e9)} SOL → ${label} — ${sig}`);
}

async function cycle() {
  try {
    const reserve = Math.floor(RESERVE_SOL * 1e9);
    let spendable = (await conn.getBalance(kp.publicKey)) - reserve;
    if (spendable / 1e9 < MIN_BATCH_SOL) return; // nothing worth moving yet
    console.log(`▶ batch: ${f3(spendable / 1e9)} SOL spendable · dev ${(DEV_SHARE * 100).toFixed(0)}% / holders ${((1 - DEV_SHARE) * 100).toFixed(0)}%${COST_RATIO > 0 ? ` · cost-lock ${(COST_RATIO * 100).toFixed(0)}%` : ''}`);

    // 0) optional: lock supplier cost as USDC off the top
    if (COST_RATIO > 0) {
      const cost = Math.floor(spendable * COST_RATIO);
      if (cost / 1e9 >= 0.005) { try { await swapToUsdc(cost); } catch (e) { console.error('  cost-swap:', e.message); return; } }
    }

    // recompute after any cost swap, then split the rest 60/40
    const avail = (await conn.getBalance(kp.publicKey)) - reserve;
    if (avail / 1e9 < 0.002) return;
    const devCut = Math.floor(avail * DEV_SHARE);
    try { await sendSol(DEV, devCut, 'dev', '🟢'); } catch (e) { console.error('  dev:', e.message); return; }

    // sweep whatever's left above the reserve to holders (their ~40%)
    const holderCut = (await conn.getBalance(kp.publicKey)) - reserve;
    if (holderCut / 1e9 >= 0.002) { try { await sendSol(HOLDER, holderCut, 'holders', '🌿'); } catch (e) { console.error('  holders:', e.message); } }
  } catch (e) { console.error('cycle:', e.message); }
}

console.log('$CHRONIC shop money-splitter');
console.log('  fulfillment wallet:', kp.publicKey.toBase58());
console.log(`  split: dev ${(DEV_SHARE * 100).toFixed(0)}% → ${DEV.toBase58()}`);
console.log(`         holders ${((1 - DEV_SHARE) * 100).toFixed(0)}% → ${HOLDER.toBase58()}`);
console.log(`  ${COST_RATIO > 0 ? 'cost-lock ' + (COST_RATIO * 100).toFixed(0) + '% → USDC · ' : ''}reserve ${RESERVE_SOL} SOL · every ${INTERVAL_MS / 60000} min`);
console.log(`  mode: ${DRY_RUN ? 'DRY RUN (no funds move — set DRY_RUN=0 to go live)' : 'LIVE'}`);
console.log('  point the shop SHOP_WALLET at the fulfillment wallet above ☝');
cycle();
setInterval(cycle, INTERVAL_MS);
