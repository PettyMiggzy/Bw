#!/usr/bin/env node
'use strict';
/*
 * settle-season.js — pay every grower their XP-weighted (pro-rata) share of the
 * weekly pool: the $CHRONIC pool PLUS a SOL yield (the pool wallet's SOL balance
 * minus a gas reserve — route your fee/creator SOL there to fund "earn SOL by
 * farming"). Then close the season and open the next one.
 *
 * Run this once a week (cron / GitHub Action / manual) with the POOL keypair.
 * The keypair is the "burner now -> your wallet later": whatever wallet holds
 * the pool's $CHRONIC signs the payouts. To hand over ownership, just swap
 * POOL_SECRET_KEY (and POOL_TOKEN_ACCOUNT in Vercel) to your own wallet.
 *
 * Env required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   SOLANA_RPC                 (your Alchemy URL)
 *   CHRONIC_MINT               (default: live pump.fun mint)
 *   CHRONIC_DECIMALS           (default: 6)
 *   POOL_SECRET_KEY            base58 string OR JSON array of the 64-byte secret
 *   YIELD_RESERVE_SOL          SOL kept in the pool wallet for gas (default 0.1);
 *                              everything above it is paid out as SOL yield
 *
 * Flags:
 *   --dry    compute + print payouts, send nothing, don't settle
 *
 * Usage:  node tools/settle-season.js [--dry]
 */
const {
  Connection, Keypair, PublicKey,
  SystemProgram, Transaction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount, transferChecked, TOKEN_2022_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58').default || require('bs58'); // bs58 v6 exposes fns on .default in CJS

const DRY = process.argv.includes('--dry');
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MINT = new PublicKey(process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump');
const DECIMALS = parseInt(process.env.CHRONIC_DECIMALS || '6', 10);
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

function die(m) { console.error('✗ ' + m); process.exit(1); }
if (!SB_URL || !SB_KEY) die('SUPABASE_URL / SUPABASE_SERVICE_KEY required');

function loadKeypair() {
  const raw = process.env.POOL_SECRET_KEY;
  if (!raw) die('POOL_SECRET_KEY required (base58 or JSON array)');
  const trimmed = raw.trim();
  const bytes = trimmed.startsWith('[')
    ? Uint8Array.from(JSON.parse(trimmed))
    : bs58.decode(trimmed);
  return Keypair.fromSecretKey(bytes);
}

const sbHeaders = {
  apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json',
};
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) die(`supabase GET ${path}: ${r.status}`);
  return r.json();
}
async function sbRpc(fn, args) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: sbHeaders, body: JSON.stringify(args || {}),
  });
  const t = await r.text();
  if (!r.ok) die(`supabase RPC ${fn}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}

(async () => {
  // 1. find the most recent ended, unsettled season
  const seasons = await sbGet(
    'grow_seasons?settled=eq.false&order=id.asc&select=id,ends_at,pool_base');
  const now = Date.now();
  const due = seasons.find((s) => new Date(s.ends_at).getTime() <= now);
  if (!due) { console.log('• no ended season to settle. up to date.'); return; }

  const poolBase = BigInt(Math.trunc(Number(due.pool_base)));
  console.log(`▸ settling season ${due.id} — pool ${Number(poolBase) / 10 ** DECIMALS} $CHRONIC`);

  // 2. every grower, ranked by XP. PAYOUT_SLOTS caps the count so the on-chain
  // payout gas stays bounded (each new recipient costs ~0.002 SOL in ATA rent).
  const SLOTS = Math.max(1, parseInt(process.env.PAYOUT_SLOTS || '50', 10));
  const top = await sbGet(
    `grow_scores?season_id=eq.${due.id}&order=xp.desc&limit=${SLOTS}&select=wallet,xp`);
  if (!top.length || poolBase === 0n) {
    console.log('• no players / empty pool — closing season with no payout.');
    if (!DRY) await sbRpc('grow_settle_season', { p_season_id: due.id, p_winners: [] });
    return;
  }

  // 3. XP-weighted split (largest-remainder so the parts sum exactly to the pool)
  const xps = top.map((t) => BigInt(Math.trunc(Number(t.xp))));
  const sum = xps.reduce((a, b) => a + b, 0n) || 1n;
  let alloc = xps.map((x) => (poolBase * x) / sum);
  let left = poolBase - alloc.reduce((a, b) => a + b, 0n);
  // hand the rounding dust to the highest XP first
  for (let i = 0; left > 0n && i < alloc.length; i++) { alloc[i] += 1n; left -= 1n; }

  // SOL yield: the "earn SOL by farming" stream. Distribute the pool wallet's
  // SOL (the routed fee/volume SOL) minus a gas reserve, pro-rata by the SAME
  // XP weights — on top of the $CHRONIC pool.
  // SOL yield is OFF by default so the pool wallet's SOL (gas + any stray SOL)
  // is never swept to growers. Turn it on only by setting SOL_YIELD=on.
  const SOL_YIELD = process.env.SOL_YIELD === 'on';
  const RESERVE_SOL = parseFloat(process.env.YIELD_RESERVE_SOL || '0.1');
  const conn = new Connection(RPC, 'confirmed');
  let payer = null;
  const payerKey = () => (payer || (payer = loadKeypair()));
  const poolPub = process.env.POOL_WALLET ? new PublicKey(process.env.POOL_WALLET) : payerKey().publicKey;
  const balLamports = BigInt(await conn.getBalance(poolPub));
  const reserveLamports = BigInt(Math.floor(RESERVE_SOL * 1e9));
  const solPot = (SOL_YIELD && balLamports > reserveLamports) ? balLamports - reserveLamports : 0n;
  let solAlloc = xps.map((x) => (solPot * x) / sum);
  let solLeft = solPot - solAlloc.reduce((a, b) => a + b, 0n);
  for (let i = 0; solLeft > 0n && i < solAlloc.length; i++) { solAlloc[i] += 1n; solLeft -= 1n; }

  const winners = top.map((t, i) => ({
    wallet: t.wallet, xp: Number(t.xp),
    amount_base: alloc[i].toString(), sol_lamports: solAlloc[i].toString(),
  }));
  console.log(`▸ paying ${winners.length} growers: ${Number(poolBase) / 10 ** DECIMALS} $CHRONIC + ${Number(solPot) / 1e9} SOL yield`);
  winners.forEach((w, i) => console.log(
    `   #${i + 1} ${w.wallet}  ${Number(w.xp)} XP  ->  ${Number(alloc[i]) / 10 ** DECIMALS} $CHRONIC + ${Number(solAlloc[i]) / 1e9} SOL`));

  if (DRY) { console.log('• --dry: nothing sent, season left open.'); return; }

  // 4. send the on-chain payouts from the pool wallet ($CHRONIC + SOL yield)
  payer = payerKey();
  // $CHRONIC is a Token-2022 mint — derive ATAs and transfer with that program.
  const fromAta = await getOrCreateAssociatedTokenAccount(conn, payer, MINT, payer.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID);

  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    const amt = BigInt(w.amount_base);
    const solAmt = BigInt(w.sol_lamports);
    if (amt > 0n) {
      const toAta = await getOrCreateAssociatedTokenAccount(conn, payer, MINT, new PublicKey(w.wallet), false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID);
      w.sig = await transferChecked(conn, payer, fromAta.address, MINT, toAta.address, payer, amt, DECIMALS, [], undefined, TOKEN_2022_PROGRAM_ID);
    }
    if (solAmt > 0n) {
      const stx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: payer.publicKey, toPubkey: new PublicKey(w.wallet), lamports: Number(solAmt),
      }));
      w.solSig = await sendAndConfirmTransaction(conn, stx, [payer]);
    }
    console.log(`   ✓ paid #${i + 1} — ${Number(amt) / 10 ** DECIMALS} $CHRONIC${solAmt > 0n ? ' + ' + Number(solAmt) / 1e9 + ' SOL' : ''}`);
  }

  // 5. close the season + open the next
  await sbRpc('grow_settle_season', { p_season_id: due.id, p_winners: winners });
  console.log(`✓ season ${due.id} settled. next race is live.`);
})().catch((e) => die(e.stack || e.message || String(e)));
