#!/usr/bin/env node
'use strict';
/*
 * cashback.js — pay out $CHRONIC cashback owed on shop orders.
 *
 * Reads grow_orders rows that have cashback owed but unpaid (and a buyer wallet),
 * sends each buyer their $CHRONIC from the cashback treasury wallet, then marks
 * the order paid with the payout signature. Idempotent: a row is only paid once.
 *
 * Run on a schedule (cron / Railway / GitHub Action) with the treasury keypair.
 *
 * Env required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   SOLANA_RPC                 (your Alchemy URL)
 *   CHRONIC_MINT               (default: live pump.fun mint)
 *   CHRONIC_DECIMALS           (default: 6)
 *   CASHBACK_SECRET_KEY        base58 string OR JSON array of the 64-byte secret
 *                              (the wallet that holds + sends the cashback $CHRONIC)
 * Optional:
 *   CASHBACK_MIN_TOKENS        skip dust payouts below this (default: 1)
 *
 * Flags:
 *   --dry    list what would be paid, send nothing, mark nothing
 *
 * Usage:  node tools/cashback.js [--dry]
 */
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount, transferChecked, TOKEN_2022_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58').default || require('bs58');

const DRY = process.argv.includes('--dry');
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MINT = new PublicKey(process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump');
const DECIMALS = parseInt(process.env.CHRONIC_DECIMALS || '6', 10);
const MIN_TOKENS = Number(process.env.CASHBACK_MIN_TOKENS || '1');
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

function die(m) { console.error('✗ ' + m); process.exit(1); }
if (!SB_URL || !SB_KEY) die('SUPABASE_URL / SUPABASE_SERVICE_KEY required');

function loadKeypair() {
  const raw = process.env.CASHBACK_SECRET_KEY;
  if (!raw) die('CASHBACK_SECRET_KEY required (base58 or JSON array)');
  const t = raw.trim();
  const bytes = t.startsWith('[') ? Uint8Array.from(JSON.parse(t)) : bs58.decode(t);
  return Keypair.fromSecretKey(bytes);
}

const sbHeaders = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' };
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) die(`supabase GET ${path}: ${r.status}`);
  return r.json();
}
async function sbPatch(path, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: Object.assign({}, sbHeaders, { prefer: 'return=minimal' }), body: JSON.stringify(body),
  });
  if (!r.ok) die(`supabase PATCH ${path}: ${r.status} ${await r.text()}`);
}

function isWallet(s) { return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s); }

(async () => {
  // 1. owed-but-unpaid orders with a valid buyer wallet
  const rows = await sbGet(
    'grow_orders?cashback_paid=eq.false&cashback_chronic=gt.0&buyer_wallet=not.is.null&select=id,buyer_wallet,cashback_chronic&order=created_at.asc&limit=200');
  const due = rows.filter((o) => isWallet(o.buyer_wallet) && Number(o.cashback_chronic) >= MIN_TOKENS);
  if (!due.length) { console.log('• no cashback to pay. up to date.'); return; }

  console.log(`▸ ${due.length} cashback payout(s) due:`);
  due.forEach((o) => console.log(`   ${o.id}  ->  ${Number(o.cashback_chronic)} $CHRONIC  ${o.buyer_wallet}`));
  if (DRY) { console.log('• --dry: nothing sent.'); return; }

  // 2. send from the treasury wallet ($CHRONIC is Token-2022)
  const payer = loadKeypair();
  const conn = new Connection(RPC, 'confirmed');
  const fromAta = await getOrCreateAssociatedTokenAccount(
    conn, payer, MINT, payer.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID);

  let paid = 0;
  for (const o of due) {
    const base = BigInt(Math.round(Number(o.cashback_chronic) * 10 ** DECIMALS));
    if (base <= 0n) continue;
    try {
      const toAta = await getOrCreateAssociatedTokenAccount(
        conn, payer, MINT, new PublicKey(o.buyer_wallet), false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID);
      const sig = await transferChecked(
        conn, payer, fromAta.address, MINT, toAta.address, payer, base, DECIMALS, [], undefined, TOKEN_2022_PROGRAM_ID);
      await sbPatch(`grow_orders?id=eq.${encodeURIComponent(o.id)}`, {
        cashback_paid: true, cashback_tx: sig,
      });
      paid++;
      console.log(`   ✓ ${o.id} — ${Number(o.cashback_chronic)} $CHRONIC — ${sig}`);
    } catch (e) {
      console.error(`   ✗ ${o.id} failed: ${e.message || e} (left unpaid, will retry next run)`);
    }
  }
  console.log(`✓ done. ${paid}/${due.length} paid.`);
})().catch((e) => die(e.stack || e.message || String(e)));
