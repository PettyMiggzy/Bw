#!/usr/bin/env node
'use strict';
/*
 * fulfill.js — the $CHRONIC shop money-splitter. Point the shop's checkout at a
 * fresh FULFILLMENT wallet, and this worker keeps the flow hands-off:
 *
 *   order SOL lands in the fulfillment wallet
 *        │
 *        ├─ swap a slice → USDC   (locks the dollars you owe the supplier, so a
 *        │                         SOL dip can't eat the cost between order and
 *        │                         fulfilling on SmokeDrop)
 *        └─ sweep the rest (profit) → DEV wallet (SOL)
 *
 * That automates everything that *can* be automated on-chain. The one step that
 * can't be — actually paying SmokeDrop, who bills your CARD in USD — stays
 * manual: off-ramp the parked USDC (Coinbase/Kraken/crypto card) and place the
 * orders. Burn whatever you want from the dev wallet, whenever you want.
 *
 * One knob: FULFILL_RATIO = the fraction of each batch parked as USDC for cost.
 * Set it to your real cost-of-goods ratio (e.g. 0.65 if gear costs ~65% of what
 * you charge). The remainder is profit and goes to the dev wallet.
 *
 * Long-running — host on the droplet/Railway like feeburn: node fulfill.js
 *
 * Env:
 *   FULFILL_SECRET_KEY  (required) the fulfillment wallet keypair, base58 or
 *                       [json]. A FRESH wallet — never the pool/dev key.
 *   DEV_WALLET          (required) address that receives the profit SOL.
 *   SOLANA_RPC          your Alchemy RPC.
 *   FULFILL_RATIO       0..1, share parked as USDC for supplier cost (default 0.65).
 *   RESERVE_SOL         SOL kept for gas, never moved (default 0.03).
 *   MIN_BATCH_SOL       don't act until this much is spendable (default 0.02).
 *   INTERVAL_MIN        minutes between sweeps (default 10).
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
const RATIO = Math.max(0, Math.min(1, parseFloat(process.env.FULFILL_RATIO || '0.65')));
const RESERVE_SOL = parseFloat(process.env.RESERVE_SOL || '0.03');
const MIN_BATCH_SOL = parseFloat(process.env.MIN_BATCH_SOL || '0.02');
const INTERVAL_MS = Math.max(1, parseFloat(process.env.INTERVAL_MIN || '10')) * 60 * 1000;
const DRY_RUN = process.env.DRY_RUN !== '0'; // safe by default
const JUP = 'https://lite-api.jup.ag/swap/v1';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function die(m) { console.error('✗ ' + m); process.exit(1); }
function loadKp() {
  const r = process.env.FULFILL_SECRET_KEY;
  if (!r) die('FULFILL_SECRET_KEY required (base58 or JSON array) — use a FRESH wallet');
  const t = r.trim();
  return Keypair.fromSecretKey(t.startsWith('[') ? Uint8Array.from(JSON.parse(t)) : b58decode(t));
}
const DEV = (() => { const d = process.env.DEV_WALLET; if (!d) die('DEV_WALLET required (where profit SOL goes)'); try { return new PublicKey(d.trim()); } catch (_) { die('DEV_WALLET is not a valid address'); } })();
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

// swap `lamports` of SOL -> USDC, parked in this wallet to cover supplier cost
async function swapToUsdc(lamports) {
  const q = await (await fetch(`${JUP}/quote?inputMint=${SOL}&outputMint=${USDC}&amount=${lamports}&slippageBps=300`)).json();
  if (!q || q.error || !q.outAmount) throw new Error('no swap route');
  const usdc = Number(q.outAmount) / 1e6;
  if (DRY_RUN) { console.log(`  [dry] would swap ${f3(lamports / 1e9)} SOL → ~$${usdc.toFixed(2)} USDC`); return; }
  const s = await (await fetch(`${JUP}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) })).json();
  if (!s || !s.swapTransaction) throw new Error('swap build failed');
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64')); tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 }); await confirm(sig);
  console.log(`  💵 parked ~$${usdc.toFixed(2)} USDC for supplier cost — ${sig}`);
}

// send `lamports` of SOL -> dev wallet (the profit)
async function sweepToDev(lamports) {
  if (DRY_RUN) { console.log(`  [dry] would send ${f3(lamports / 1e9)} SOL → dev ${DEV.toBase58().slice(0, 4)}…`); return; }
  const bh = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: bh.blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: DEV, lamports })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg); tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 }); await confirm(sig);
  console.log(`  🟢 sent ${f3(lamports / 1e9)} SOL profit → dev — ${sig}`);
}

async function cycle() {
  try {
    const balLamports = await conn.getBalance(kp.publicKey);
    const reserve = Math.floor(RESERVE_SOL * 1e9);
    const spendable = balLamports - reserve;
    if (spendable / 1e9 < MIN_BATCH_SOL) return; // nothing worth moving yet
    console.log(`▶ batch: ${f3(spendable / 1e9)} SOL spendable (ratio ${RATIO})`);

    // 1) park the supplier-cost slice as USDC (locks the dollars)
    const costLamports = Math.floor(spendable * RATIO);
    if (RATIO > 0 && costLamports / 1e9 >= 0.005) {
      try { await swapToUsdc(costLamports); } catch (e) { console.error('  swap:', e.message); return; } // leave funds put on failure
    }

    // 2) sweep whatever SOL is left above the reserve to the dev wallet (profit)
    const after = await conn.getBalance(kp.publicKey);
    const profit = after - reserve;
    if (profit / 1e9 >= 0.002) { try { await sweepToDev(profit); } catch (e) { console.error('  sweep:', e.message); } }
  } catch (e) { console.error('cycle:', e.message); }
}

console.log('$CHRONIC shop fulfillment splitter');
console.log('  fulfillment wallet:', kp.publicKey.toBase58());
console.log(`  cost→USDC ${(RATIO * 100).toFixed(0)}% · profit→dev ${DEV.toBase58()} · reserve ${RESERVE_SOL} SOL · every ${INTERVAL_MS / 60000} min`);
console.log(`  mode: ${DRY_RUN ? 'DRY RUN (no funds move — set DRY_RUN=0 to go live)' : 'LIVE'}`);
console.log('  point the shop SHOP_WALLET at the fulfillment wallet above ☝');
cycle();
setInterval(cycle, INTERVAL_MS);
