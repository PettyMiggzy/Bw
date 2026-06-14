'use strict';
/*
 * /api/swap — generic Jupiter swap builder for the Chronic Terminal.
 * POST { account, inputMint, outputMint, amount }  (amount = base units of inputMint, string)
 * -> { transaction (base64 versioned), outAmount, inAmount, fee }
 *
 * Platform fee: 1% by default (SWAP_FEE_BPS=100). Collected via a Jupiter
 * Referral account (SWAP_REFERRAL_ACCOUNT) — the fee lands in the referral
 * token account for the output mint. If the fee setup isn't ready, we retry
 * WITHOUT the fee so trades never break.
 */
const G = require('./_grow.js');

const JUP = 'https://lite-api.jup.ag/swap/v1';
const SLIPPAGE_BPS = 500;
const FEE_BPS = parseInt(process.env.SWAP_FEE_BPS || '100', 10);          // 1%
const REFERRAL = process.env.SWAP_REFERRAL_ACCOUNT || '';                  // jup referral account pubkey
const REFERRAL_PROGRAM = 'REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3';

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('content-type', 'application/json');
}
const send = (res, code, obj) => res.status(code).json(obj);
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
}

// derive the Jupiter referral token account (where the fee lands) for a mint
function feeAccountFor(outputMint) {
  if (!REFERRAL || !FEE_BPS) return null;
  try {
    const { PublicKey } = require('@solana/web3.js');
    const [ata] = PublicKey.findProgramAddressSync(
      [Buffer.from('referral_ata'), new PublicKey(REFERRAL).toBuffer(), new PublicKey(outputMint).toBuffer()],
      new PublicKey(REFERRAL_PROGRAM));
    return ata.toBase58();
  } catch (_) { return null; }
}

async function buildSwap(account, inputMint, outputMint, amount, withFee) {
  const qp = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: String(SLIPPAGE_BPS) });
  let feeAccount = null;
  if (withFee) { feeAccount = feeAccountFor(outputMint); if (feeAccount) qp.set('platformFeeBps', String(FEE_BPS)); }
  const quote = await (await fetch(`${JUP}/quote?${qp.toString()}`)).json();
  if (!quote || quote.error || !quote.outAmount) return { quote: null };
  const body = { quoteResponse: quote, userPublicKey: account, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true };
  if (feeAccount) body.feeAccount = feeAccount;
  const swap = await (await fetch(`${JUP}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { quote, swap, feeApplied: !!feeAccount };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });

  const b = await readBody(req);
  const { account, inputMint, outputMint } = b;
  const amount = String(b.amount || '').replace(/[^0-9]/g, '');
  if (!G.isPubkey(account)) return send(res, 400, { error: 'connect a wallet' });
  if (!G.isPubkey(inputMint) || !G.isPubkey(outputMint)) return send(res, 400, { error: 'bad mints' });
  if (!amount || amount === '0') return send(res, 400, { error: 'bad amount' });

  try {
    let r = await buildSwap(account, inputMint, outputMint, amount, true);
    if ((!r.swap || !r.swap.swapTransaction) && REFERRAL) r = await buildSwap(account, inputMint, outputMint, amount, false); // fee setup not ready -> trade anyway
    if (!r.quote) return send(res, 400, { error: 'no route — try another amount' });
    if (!r.swap || !r.swap.swapTransaction) return send(res, 502, { error: 'swap build failed' });
    return send(res, 200, { transaction: r.swap.swapTransaction, outAmount: r.quote.outAmount, inAmount: r.quote.inAmount, fee: r.feeApplied ? FEE_BPS : 0 });
  } catch (e) {
    return send(res, 502, { error: 'swap failed: ' + ((e && e.message) || e) });
  }
};
