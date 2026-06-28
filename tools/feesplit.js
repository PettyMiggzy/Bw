#!/usr/bin/env node
'use strict';
/*
 * feesplit.js — drains the meme-generator fee wallet and routes the split
 * OFF-CHAIN, so the on-chain payment stays ONE clean transfer (no multi-recipient
 * "drainer" shape that flags the domain in Phantom). Server-side signed — no
 * Phantom, so the drainer rule doesn't apply here.
 *
 * Every cycle it drains the collection wallet (over a gas reserve) and splits it:
 *   - BURN_BPS  (default 40%) -> BURN_WALLET   (feeburn.js buys $CHRONIC + burns it)
 *   - YIELD_BPS (default 30%) -> POOL_WALLET   (the grow SOL-yield pool)
 *   - the rest  (default 30%) -> OVERHEAD_WALLET (treasury / Venice cost + profit)
 *
 * IMPORTANT: point the generator at a DEDICATED collection wallet, not your main
 * treasury — this script empties it each cycle. In Vercel set
 *   MEME_FEE_WALLET = <dedicated collection wallet address>
 * and give this script that wallet's key as FEESPLIT_SECRET_KEY.
 *
 * Long-running — host on Railway next to feeburn.js:  node feesplit.js
 *
 * Env:
 *   FEESPLIT_SECRET_KEY  (required) collection wallet keypair, base58 or [json]
 *   SOLANA_RPC           your Alchemy RPC
 *   BURN_WALLET          default 6869BJqsz86WYkQJtc2do5s97hoKXMF8YxZe3oWwzpva (feeburn wallet)
 *   POOL_WALLET          the grow pool wallet (yield)
 *   OVERHEAD_WALLET      treasury (default E7Cr…oUr5)
 *   BURN_BPS=4000  YIELD_BPS=3000   (overhead = remainder)
 *   RESERVE_SOL=0.02     SOL kept for gas, never routed
 *   MIN_SPLIT_SOL=0.01   don't bother splitting below this
 *   INTERVAL_MIN=60
 */
const { Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction, TransactionMessage } = require('@solana/web3.js');

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
const BURN_WALLET = process.env.BURN_WALLET || '6869BJqsz86WYkQJtc2do5s97hoKXMF8YxZe3oWwzpva';
const POOL_WALLET = process.env.POOL_WALLET || 'AdNkFhFLQ7qxy5bognkZ9tiBYEnmX5merWDo98pWT5AM';
const OVERHEAD_WALLET = process.env.OVERHEAD_WALLET || 'E7Cr2nad1SvBWF8vcGhNW575UVVPdTcgHEqSTMQzoUr5';
const BURN_BPS = parseInt(process.env.BURN_BPS || '4000', 10);
const YIELD_BPS = parseInt(process.env.YIELD_BPS || '3000', 10);
const RESERVE_SOL = parseFloat(process.env.RESERVE_SOL || '0.02');
const MIN_SPLIT_SOL = parseFloat(process.env.MIN_SPLIT_SOL || '0.01');
const INTERVAL_MS = Math.max(1, parseFloat(process.env.INTERVAL_MIN || '60')) * 60 * 1000;

function die(m) { console.error('✗ ' + m); process.exit(1); }
function loadKp() {
  const r = process.env.FEESPLIT_SECRET_KEY;
  if (!r) die('FEESPLIT_SECRET_KEY required (base58 or JSON array)');
  const t = r.trim();
  return Keypair.fromSecretKey(t.startsWith('[') ? Uint8Array.from(JSON.parse(t)) : b58decode(t));
}
const kp = loadKp();
const conn = new Connection(RPC, 'confirmed');
const pk = (s) => new PublicKey(s);
const sol = (lam) => (lam / 1e9).toFixed(4);

async function confirm(sig) {
  for (let i = 0; i < 40; i++) {
    const st = await conn.getSignatureStatuses([sig]); const v = st.value && st.value[0];
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) { if (v.err) throw new Error('tx err ' + JSON.stringify(v.err)); return; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('confirm timeout ' + sig);
}

async function cycle() {
  try {
    const bal = await conn.getBalance(kp.publicKey);
    const reserve = Math.floor(RESERVE_SOL * 1e9);
    const spendable = bal - reserve;
    if (spendable < Math.floor(MIN_SPLIT_SOL * 1e9)) return; // nothing worth splitting

    // leave a hair for the tx fee itself
    const txFee = 10000;
    const pot = spendable - txFee;
    if (pot <= 0) return;

    const burn = Math.floor((pot * BURN_BPS) / 10000);
    const yld = Math.floor((pot * YIELD_BPS) / 10000);
    const overhead = pot - burn - yld;

    const ixs = [];
    if (burn > 0) ixs.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: pk(BURN_WALLET), lamports: burn }));
    if (yld > 0) ixs.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: pk(POOL_WALLET), lamports: yld }));
    if (overhead > 0) ixs.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: pk(OVERHEAD_WALLET), lamports: overhead }));
    if (!ixs.length) return;

    const bh = await conn.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message();
    const tx = new VersionedTransaction(msg); tx.sign([kp]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
    await confirm(sig);
    console.log(`💸 split ${sol(pot)} SOL → 🔥 ${sol(burn)} burn · 🌱 ${sol(yld)} pool · 🏦 ${sol(overhead)} overhead — ${sig}`);
  } catch (e) { console.error('split:', e.message); }
}

console.log('$CHRONIC fee splitter');
console.log('  collection wallet:', kp.publicKey.toBase58());
console.log(`  routes: ${BURN_BPS / 100}% burn (${BURN_WALLET.slice(0, 4)}…) · ${YIELD_BPS / 100}% pool · ${(10000 - BURN_BPS - YIELD_BPS) / 100}% overhead · reserve ${RESERVE_SOL} SOL · every ${INTERVAL_MS / 60000} min`);
cycle();
setInterval(cycle, INTERVAL_MS);
