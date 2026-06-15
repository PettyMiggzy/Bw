#!/usr/bin/env node
'use strict';
/*
 * create-alt.js — publish an Address Lookup Table (ALT) of the common accounts
 * our buy transactions reference (programs, wSOL, fee wallet, referral, Jupiter).
 *
 * Why: $CHRONIC (and tight single-pool tokens) route through Jupiter WITHOUT
 * lookup tables, so the tx is already near Solana's 1232-byte limit and the 1%
 * SOL fee instruction tips it over — meaning buys either fail or drop the fee.
 * Moving these constant accounts into an ALT shrinks the tx so the fee fits and
 * buys keep the 1% (and the pad dev 50/50 split).
 *
 * Run ONCE (needs a funded keypair to pay rent + a few signatures):
 *     cd tools && POOL_SECRET_KEY=... SOLANA_RPC=... node create-alt.js
 * Then set the printed value in Vercel:  SWAP_ALT=<address>
 *
 * Env: POOL_SECRET_KEY (base58 or JSON array), SOLANA_RPC,
 *      optional SWAP_FEE_WALLET / SWAP_REFERRAL_ACCOUNT (defaults match _swap.js)
 */
const {
  Connection, Keypair, PublicKey, AddressLookupTableProgram,
  TransactionMessage, VersionedTransaction,
} = require('@solana/web3.js');
const bs58 = require('bs58');

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const FEE_WALLET = process.env.SWAP_FEE_WALLET || 'E7Cr2nad1SvBWF8vcGhNW575UVVPdTcgHEqSTMQzoUr5';
const REFERRAL = process.env.SWAP_REFERRAL_ACCOUNT || '4HgJt8K66Nwu6wb8QCj8scojhmtDETCrAHJWZngHXjSE';

// constant accounts a SOL→token buy touches besides the route-specific pool keys
const ADDRS = [
  '11111111111111111111111111111111',            // System Program
  'ComputeBudget111111111111111111111111111111', // Compute Budget
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022 (CHRONIC)
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // legacy SPL Token (wSOL)
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token program
  'So11111111111111111111111111111111111111112',  // wSOL mint
  FEE_WALLET,                                     // our fee wallet
  REFERRAL,                                       // Jupiter referral account
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter v6
];

function die(m) { console.error('✗ ' + m); process.exit(1); }
function loadKeypair() {
  const raw = process.env.POOL_SECRET_KEY;
  if (!raw) die('POOL_SECRET_KEY required (base58 or JSON array)');
  const t = raw.trim();
  return Keypair.fromSecretKey(t.startsWith('[') ? Uint8Array.from(JSON.parse(t)) : bs58.decode(t));
}
async function sendV0(conn, payer, ixs) {
  const bh = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'confirmed');
  return sig;
}

(async () => {
  const conn = new Connection(RPC, 'confirmed');
  const payer = loadKeypair();
  console.log('authority / payer:', payer.publicKey.toBase58());

  const slot = await conn.getSlot('finalized');
  const [createIx, alt] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });
  console.log('• creating ALT', alt.toBase58());
  console.log('  create sig:', await sendV0(conn, payer, [createIx]));

  console.log(`• extending with ${ADDRS.length} addresses`);
  console.log('  extend sig:', await sendV0(conn, payer, [
    AddressLookupTableProgram.extendLookupTable({
      lookupTable: alt, authority: payer.publicKey, payer: payer.publicKey,
      addresses: ADDRS.map((a) => new PublicKey(a)),
    }),
  ]));

  console.log('\n✅ ALT published. Add this to Vercel env, then redeploy:\n');
  console.log('   SWAP_ALT=' + alt.toBase58());
  console.log('\n(buildBuyWithFee picks it up automatically; existing swaps keep working without it.)');
})().catch((e) => die((e && e.message) || e));
