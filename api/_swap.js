'use strict';
/*
 * Shared Jupiter swap builders with the $CHRONIC 1% SOL fee. Used by the
 * terminal route (/api/swap) AND the shareable Blinks (/api/actions/buy|sell)
 * so every surface charges the same fee. Underscore-prefixed => not routed.
 *
 * Fee (1%, in SOL) — taken via Jupiter's NATIVE platformFee on the referral
 * account (REFERRAL), never a raw SystemProgram transfer (that reads as a
 * drainer to Phantom/Blowfish and warns on the whole dApp):
 *   - BUY  (input = SOL):  platformFee in SOL on the wSOL input side.
 *   - SELL (output = SOL): platformFee in SOL on the SOL output.
 * Fees pool to the referral account; pad-launched dev splits are settled from
 * there out-of-band (see tools/feeburn.js / cashback.js), not on each tx.
 * Every path falls back to a plain swap if fee setup isn't ready, so trades
 * never break.
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

// NOTE: the old buildBuyWithFee() (skim 1% SOL via a prepended SystemProgram
// transfer, then swap the rest) was removed. Phantom/Blowfish read "send SOL to
// an unknown wallet, then swap" as a drainer pattern and warned on the whole
// dApp. Both buys (terminal + blink) now take the 1% through Jupiter's native
// platformFee via buildSwap() below, which carries no such flag.

// plain or referral-fee Jupiter swap (used for buys, sells + fallback)
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

module.exports = { JUP, SOL, SLIPPAGE_BPS, FEE_BPS, FEE_WALLET, REFERRAL, REFERRAL_PROGRAM, feeAccountFor, buildSwap };
