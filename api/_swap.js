'use strict';
/*
 * Shared Jupiter swap builders with the $CHRONIC 1% SOL fee. Used by the
 * terminal route (/api/swap) AND the shareable Blinks (/api/actions/buy|sell)
 * so every surface charges the same fee. Underscore-prefixed => not routed.
 *
 * Fee (1%, in SOL):
 *   - BUY  (input = SOL):  skim 1% of the SOL to SWAP_FEE_WALLET, swap the rest.
 *     Pad-launched tokens split that 1% 50/50 with the dev.
 *   - SELL (output = SOL): Jupiter referral platform fee on the SOL output.
 * Both fall back to a plain swap if fee setup isn't ready, so trades never break.
 */
const G = require('./_grow.js');

const JUP = 'https://lite-api.jup.ag/swap/v1';
const SOL = 'So11111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 500;
const FEE_BPS = parseInt(process.env.SWAP_FEE_BPS || '100', 10);
const FEE_WALLET = process.env.SWAP_FEE_WALLET || 'E7Cr2nad1SvBWF8vcGhNW575UVVPdTcgHEqSTMQzoUr5';
const REFERRAL = process.env.SWAP_REFERRAL_ACCOUNT || '4HgJt8K66Nwu6wb8QCj8scojhmtDETCrAHJWZngHXjSE';
const REFERRAL_PROGRAM = 'REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3';
// optional ALT of common accounts (tools/create-alt.js) so the SOL-fee buy fits
// under the 1232-byte limit on tight, ALT-less routes.
const SWAP_ALT = process.env.SWAP_ALT || '';

async function jget(path) { return (await fetch(`${JUP}${path}`)).json(); }
async function jpost(path, body) { return (await fetch(`${JUP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); }

// SELL referral fee account (fee in the SOL output)
function feeAccountFor(mint) {
  if (!REFERRAL || !FEE_BPS) return null;
  try {
    const { PublicKey } = require('@solana/web3.js');
    const [ata] = PublicKey.findProgramAddressSync(
      [Buffer.from('referral_ata'), new PublicKey(REFERRAL).toBuffer(), new PublicKey(mint).toBuffer()],
      new PublicKey(REFERRAL_PROGRAM));
    return ata.toBase58();
  } catch (_) { return null; }
}

// BUY: skim 1% SOL upfront, then swap the rest — one versioned tx
async function buildBuyWithFee(account, outputMint, lamports, feeBps) {
  feeBps = (feeBps == null ? FEE_BPS : feeBps);
  const web3 = require('@solana/web3.js');
  const { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction, AddressLookupTableAccount } = web3;
  // pad-launched token? -> the dev earns 50% of the (1%) fee
  let dev = null;
  try {
    if (G.sbEnabled()) {
      const rows = await G.sbSelect(`grow_launches?mint=eq.${encodeURIComponent(outputMint)}&select=dev_wallet`);
      if (rows && rows.length && G.isPubkey(rows[0].dev_wallet) && rows[0].dev_wallet !== FEE_WALLET) dev = rows[0].dev_wallet;
    }
  } catch (_) { /* no split */ }
  const fee = (BigInt(lamports) * BigInt(feeBps)) / 10000n;
  const swapLamports = (BigInt(lamports) - fee).toString();
  const qp = new URLSearchParams({ inputMint: SOL, outputMint, amount: swapLamports, slippageBps: String(SLIPPAGE_BPS) });
  const quote = await jget(`/quote?${qp.toString()}`);
  if (!quote || quote.error || !quote.outAmount) return null;
  const si = await jpost('/swap-instructions', { quoteResponse: quote, userPublicKey: account, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true });
  if (!si || !si.swapInstruction) return null;

  const owner = new PublicKey(account);
  const de = (ix) => new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: (ix.accounts || []).map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, 'base64'),
  });
  const feeIxs = [];
  if (dev) {
    const half = fee / 2n;
    feeIxs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(dev), lamports: Number(half) }));
    feeIxs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(FEE_WALLET), lamports: Number(fee - half) }));
  } else {
    feeIxs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(FEE_WALLET), lamports: Number(fee) }));
  }
  const ixs = [
    ...(si.computeBudgetInstructions || []).map(de),
    ...feeIxs,
    ...(si.setupInstructions || []).map(de),
    de(si.swapInstruction),
    ...(si.cleanupInstruction ? [de(si.cleanupInstruction)] : []),
  ];
  let alts = [];
  const addrs = (si.addressLookupTableAddresses || []).slice();
  if (SWAP_ALT && addrs.indexOf(SWAP_ALT) < 0) addrs.push(SWAP_ALT); // our shared ALT shrinks the fee'd tx
  if (addrs.length) {
    const infos = await G.solRpc('getMultipleAccounts', [addrs, { encoding: 'base64' }]);
    (infos.value || []).forEach((acc, i) => {
      if (acc && acc.data) alts.push(new AddressLookupTableAccount({
        key: new PublicKey(addrs[i]),
        state: AddressLookupTableAccount.deserialize(Buffer.from(acc.data[0], 'base64')),
      }));
    });
  }
  const bh = await G.solRpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: bh.value.blockhash, instructions: ixs }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  const serialized = tx.serialize();
  // If Jupiter gave us no lookup tables, the prepended SOL-fee instruction can
  // push the tx past Solana's 1232-byte limit. Rather than ship a tx that fails
  // on-chain, bail so the caller falls back to a compact (Jupiter-built) swap.
  if (serialized.length > 1232) return null;
  return { transaction: Buffer.from(serialized).toString('base64'), outAmount: quote.outAmount, inAmount: lamports, fee: feeBps };
}

// plain or referral-fee Jupiter swap (used for sells + fallback)
async function buildSwap(account, inputMint, outputMint, amount, withFee, feeBps) {
  feeBps = (feeBps == null ? FEE_BPS : feeBps);
  const qp = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: String(SLIPPAGE_BPS) });
  let feeAccount = null;
  if (withFee && feeBps > 0) {
    // charge the fee in SOL whenever SOL is one side (buys via wSOL input,
    // sells via SOL output) — keeps the fee currency consistent and compact.
    const feeMint = (inputMint === SOL || outputMint === SOL) ? SOL : outputMint;
    feeAccount = feeAccountFor(feeMint);
    if (feeAccount) qp.set('platformFeeBps', String(feeBps));
  }
  const quote = await jget(`/quote?${qp.toString()}`);
  if (!quote || quote.error || !quote.outAmount) return { quote: null };
  const body = { quoteResponse: quote, userPublicKey: account, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true };
  if (feeAccount) body.feeAccount = feeAccount;
  const swap = await jpost('/swap', body);
  // Some routes (single pool, no ALTs) are already near Solana's 1232-byte
  // limit; the fee instruction tips them over. Never ship a tx that won't land
  // — if the fee'd tx is too big, rebuild without the fee so the trade works.
  if (feeAccount && swap && swap.swapTransaction) {
    let tooBig = false;
    try { tooBig = Buffer.from(swap.swapTransaction, 'base64').length > 1232; } catch (_) {}
    if (tooBig) return buildSwap(account, inputMint, outputMint, amount, false, feeBps);
  }
  return { quote, swap, feeApplied: !!feeAccount };
}

module.exports = { JUP, SOL, SLIPPAGE_BPS, FEE_BPS, FEE_WALLET, REFERRAL, REFERRAL_PROGRAM, feeAccountFor, buildBuyWithFee, buildSwap };
