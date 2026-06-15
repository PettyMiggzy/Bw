#!/usr/bin/env node
'use strict';
/*
 * feeburn.js — the $CHRONIC auto-burn engine.
 *
 * A public BURN WALLET that destroys $CHRONIC forever:
 *   1) ALWAYS: any $CHRONIC sent to the wallet is SPL-burned on the next poll
 *      (Token-2022 burn). Post the address publicly — anyone can feed the fire.
 *   2) OPTIONAL (BUYBACK=1): if the wallet also holds SOL above a reserve, it
 *      buys $CHRONIC with the excess via Jupiter, which then gets burned next
 *      loop. Route your 1% trade-fee SOL here to turn "we charge 1%" into
 *      "every trade burns $CHRONIC."
 *
 * Long-running — host on Railway like the firehose:
 *     cd tools && npm install && node feeburn.js
 *
 * Env:
 *   BURN_SECRET_KEY   (required) keypair of the burn wallet, base58 or [json].
 *                     Create a FRESH wallet for this; it only holds tokens
 *                     about to be burned + a little gas. NEVER the pool key.
 *   SOLANA_RPC        your Alchemy RPC
 *   CHRONIC_MINT      default = the live mint    CHRONIC_DECIMALS default 6
 *   BURN_POLL_SEC     default 60
 *   BUYBACK           '1' to enable SOL->CHRONIC buybacks (default off)
 *   RESERVE_SOL       keep this much SOL for gas (default 0.05)
 *   BUYBACK_MIN_SOL   only buy when excess SOL >= this (default 0.2)
 */
const { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const bs58 = require('bs58');

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MINT = new PublicKey(process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump');
const DECIMALS = parseInt(process.env.CHRONIC_DECIMALS || '6', 10);
const T22 = spl.TOKEN_2022_PROGRAM_ID; // $CHRONIC is a Token-2022 mint
const POLL_MS = Math.max(15, parseInt(process.env.BURN_POLL_SEC || '60', 10)) * 1000;
const BUYBACK = process.env.BUYBACK === '1';
const RESERVE_SOL = parseFloat(process.env.RESERVE_SOL || '0.05');
const BUYBACK_MIN_SOL = parseFloat(process.env.BUYBACK_MIN_SOL || '0.2');
const JUP = 'https://lite-api.jup.ag/swap/v1';
const SOL = 'So11111111111111111111111111111111111111112';

function die(m) { console.error('✗ ' + m); process.exit(1); }
function loadKp() {
  const r = process.env.BURN_SECRET_KEY;
  if (!r) die('BURN_SECRET_KEY required (base58 or JSON array)');
  const t = r.trim();
  return Keypair.fromSecretKey(t.startsWith('[') ? Uint8Array.from(JSON.parse(t)) : bs58.decode(t));
}
const kp = loadKp();
const conn = new Connection(RPC, 'confirmed');
const ata = spl.getAssociatedTokenAddressSync(MINT, kp.publicKey, false, T22);
const fmt = (n) => { n = Math.floor(Number(n)); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'; return String(n); };

async function confirm(sig) {
  for (let i = 0; i < 40; i++) {
    const st = await conn.getSignatureStatuses([sig]);
    const v = st.value && st.value[0];
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) {
      if (v.err) throw new Error('tx err ' + JSON.stringify(v.err)); return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('confirm timeout ' + sig);
}
async function sendIxs(ixs) {
  const bh = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg); tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  await confirm(sig); return sig;
}

// burn every $CHRONIC currently in the wallet
async function burnAll() {
  let bal = 0n;
  try { const b = await conn.getTokenAccountBalance(ata); bal = BigInt(b.value.amount); } catch (_) { return; }
  if (bal <= 0n) return;
  const sig = await sendIxs([spl.createBurnCheckedInstruction(ata, MINT, kp.publicKey, bal, DECIMALS, [], T22)]);
  console.log(`🔥 burned ${fmt(Number(bal) / 10 ** DECIMALS)} $CHRONIC — ${sig}`);
}

// optional: spend excess SOL on $CHRONIC (burned next loop)
async function buyback() {
  if (!BUYBACK) return;
  const sol = (await conn.getBalance(kp.publicKey)) / 1e9;
  const excess = sol - RESERVE_SOL;
  if (excess < BUYBACK_MIN_SOL) return;
  const spend = Math.floor(excess * 1e9);
  const q = await (await fetch(`${JUP}/quote?inputMint=${SOL}&outputMint=${MINT.toBase58()}&amount=${spend}&slippageBps=500`)).json();
  if (!q || q.error || !q.outAmount) return;
  const s = await (await fetch(`${JUP}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) })).json();
  if (!s || !s.swapTransaction) return;
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64')); tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  await confirm(sig);
  console.log(`🪙 bought ~${fmt(Number(q.outAmount) / 10 ** DECIMALS)} $CHRONIC with ${(spend / 1e9).toFixed(3)} SOL — ${sig}`);
}

async function loop() {
  try { await buyback(); } catch (e) { console.error('buyback:', e.message); }
  try { await burnAll(); } catch (e) { console.error('burn:', e.message); }
}

console.log('$CHRONIC fee-burn engine');
console.log('  burn wallet:', kp.publicKey.toBase58());
console.log('  send $CHRONIC here to burn it forever. buyback:', BUYBACK ? `on (reserve ${RESERVE_SOL} SOL)` : 'off');
loop();
setInterval(loop, POLL_MS);
