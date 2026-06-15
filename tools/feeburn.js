#!/usr/bin/env node
'use strict';
/*
 * feeburn.js — the $CHRONIC buy-&-burn engine. Your honest "volume bot":
 * real buys (green candles) + real burns (supply down), all provable on-chain,
 * funded by your own trade fees/treasury. No wash trading.
 *
 * Three things, every cycle:
 *   1) DCA buy (DCA_SOL > 0): spend a fixed bit of SOL on $CHRONIC via Jupiter
 *      each interval — steady green candles instead of one lumpy buy.
 *   2) Burn: every $CHRONIC in the wallet (the DCA buys + anything anyone sent
 *      in) is SPL-burned (Token-2022). Supply drops; the homepage counter
 *      (1B − live supply) ticks up on its own.
 *   3) Tweet (TWEET_BURNS=1): broadcast each burn so it becomes marketing.
 *
 * Send $CHRONIC to this wallet anytime → it gets burned. Send SOL (e.g. route
 * your 1% fees here) → it gets DCA'd into buys and burned.
 *
 * Long-running — host on Railway like the firehose: node feeburn.js
 *
 * Env:
 *   BURN_SECRET_KEY   (required) burn wallet keypair, base58 or [json]. FRESH
 *                     wallet only — never the pool key.
 *   SOLANA_RPC        your Alchemy RPC
 *   CHRONIC_MINT / CHRONIC_DECIMALS   (default live mint / 6)
 *   DCA_SOL           SOL to spend per cycle on buy&burn (default 0 = off)
 *   DCA_INTERVAL_MIN  minutes between cycles (default 10)
 *   RESERVE_SOL       SOL kept for gas, never spent (default 0.05)
 *   TWEET_BURNS       '1' to tweet each burn (needs X_* keys below)
 *   TWEET_MIN         only tweet burns >= this many whole $CHRONIC (default 1)
 *   X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET
 */
const { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
// pure-JS base58 decode (no dependency — bs58 v6's CJS export shape is flaky)
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
const MINT = new PublicKey(process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump');
const DECIMALS = parseInt(process.env.CHRONIC_DECIMALS || '6', 10);
const T22 = spl.TOKEN_2022_PROGRAM_ID;
const DCA_SOL = parseFloat(process.env.DCA_SOL || '0');
const INTERVAL_MS = Math.max(1, parseFloat(process.env.DCA_INTERVAL_MIN || '10')) * 60 * 1000;
const RESERVE_SOL = parseFloat(process.env.RESERVE_SOL || '0.05');
const TWEET_BURNS = process.env.TWEET_BURNS === '1';
const TWEET_MIN = parseFloat(process.env.TWEET_MIN || '1');
const JUP = 'https://lite-api.jup.ag/swap/v1';
const SOL = 'So11111111111111111111111111111111111111112';
const SITE = 'https://www.burnchronic.xyz';

function die(m) { console.error('✗ ' + m); process.exit(1); }
function loadKp() {
  const r = process.env.BURN_SECRET_KEY;
  if (!r) die('BURN_SECRET_KEY required (base58 or JSON array)');
  const t = r.trim();
  return Keypair.fromSecretKey(t.startsWith('[') ? Uint8Array.from(JSON.parse(t)) : b58decode(t));
}
const kp = loadKp();
const conn = new Connection(RPC, 'confirmed');
const ata = spl.getAssociatedTokenAddressSync(MINT, kp.publicKey, false, T22);
const fmt = (n) => { n = Math.floor(Number(n)); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'; return String(n); };

let _x = null;
function xClient() {
  if (!TWEET_BURNS) return null;
  if (_x) return _x;
  const k = process.env.X_API_KEY, s = process.env.X_API_SECRET, at = process.env.X_ACCESS_TOKEN, as = process.env.X_ACCESS_SECRET;
  if (!k || !s || !at || !as) { console.error('TWEET_BURNS set but X_* keys missing — tweets off'); return null; }
  const { TwitterApi } = require('twitter-api-v2');
  _x = new TwitterApi({ appKey: k, appSecret: s, accessToken: at, accessSecret: as }).readWrite;
  return _x;
}
async function tweetBurn(whole, sig) {
  const x = xClient(); if (!x || whole < TWEET_MIN) return;
  const text = `🔥 $CHRONIC buy & burn\n\nbought + burned ${fmt(whole)} $CHRONIC — gone forever. supply only goes down 💀\n\nsolscan.io/tx/${sig}\n${SITE}`;
  try { await x.v2.tweet(text); console.log('  🐦 tweeted'); } catch (e) { console.error('  tweet err', e.message); }
}

async function confirm(sig) {
  for (let i = 0; i < 40; i++) {
    const st = await conn.getSignatureStatuses([sig]); const v = st.value && st.value[0];
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) { if (v.err) throw new Error('tx err ' + JSON.stringify(v.err)); return; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('confirm timeout ' + sig);
}
async function sendIxs(ixs) {
  const bh = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg); tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 }); await confirm(sig); return sig;
}

// DCA: spend up to DCA_SOL (capped by what's available over the reserve) on $CHRONIC
async function dcaBuy() {
  if (!(DCA_SOL > 0)) return;
  const sol = (await conn.getBalance(kp.publicKey)) / 1e9;
  const spendSol = Math.min(DCA_SOL, sol - RESERVE_SOL);
  if (spendSol < 0.005) return; // not enough to bother
  const lamports = Math.floor(spendSol * 1e9);
  const q = await (await fetch(`${JUP}/quote?inputMint=${SOL}&outputMint=${MINT.toBase58()}&amount=${lamports}&slippageBps=500`)).json();
  if (!q || q.error || !q.outAmount) return;
  const s = await (await fetch(`${JUP}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) })).json();
  if (!s || !s.swapTransaction) return;
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64')); tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 }); await confirm(sig);
  console.log(`🪙 bought ~${fmt(Number(q.outAmount) / 10 ** DECIMALS)} $CHRONIC for ${spendSol.toFixed(3)} SOL — ${sig}`);
}

// burn everything in the wallet; returns whole tokens burned (0 if none)
async function burnAll() {
  let bal = 0n;
  try { const b = await conn.getTokenAccountBalance(ata); bal = BigInt(b.value.amount); } catch (_) { return 0; }
  if (bal <= 0n) return 0;
  const sig = await sendIxs([spl.createBurnCheckedInstruction(ata, MINT, kp.publicKey, bal, DECIMALS, [], T22)]);
  const whole = Number(bal) / 10 ** DECIMALS;
  console.log(`🔥 burned ${fmt(whole)} $CHRONIC — ${sig}`);
  await tweetBurn(whole, sig);
  return whole;
}

async function cycle() {
  try { await dcaBuy(); } catch (e) { console.error('dca:', e.message); }
  try { await burnAll(); } catch (e) { console.error('burn:', e.message); }
}

console.log('$CHRONIC buy-&-burn engine');
console.log('  burn wallet:', kp.publicKey.toBase58());
console.log(`  DCA: ${DCA_SOL > 0 ? DCA_SOL + ' SOL / ' + (INTERVAL_MS / 60000) + ' min' : 'off (burn-only)'} · reserve ${RESERVE_SOL} SOL · tweets ${TWEET_BURNS ? 'on' : 'off'}`);
console.log('  send $CHRONIC here to burn it forever 🔥');
cycle();
setInterval(cycle, INTERVAL_MS);
