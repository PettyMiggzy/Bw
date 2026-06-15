'use strict';
/*
 * /api/swap — generic Jupiter swap builder for the Chronic Terminal.
 * POST { account, inputMint, outputMint, amount }  (amount = base units of inputMint, string)
 * -> { transaction (base64 versioned), outAmount, inAmount, fee }
 *
 * 1% platform fee, collected in SOL:
 *   - BUY  (input = SOL):  skim 1% of the SOL to SWAP_FEE_WALLET, swap the rest.
 *   - SELL (output = SOL): Jupiter platform fee on the SOL output (needs SWAP_REFERRAL_ACCOUNT).
 * Both paths fall back to a plain swap if fee setup isn't ready, so trades never break.
 */
const G = require('./_grow.js');
const S = require('./_swap.js');

const SOL = S.SOL;
const FEE_BPS = S.FEE_BPS;

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
    // BUY (paying in SOL): skim the 1% in SOL, fall back to plain swap on any hiccup
    if (inputMint === SOL && FEE_BPS > 0) {
      try { const r = await S.buildBuyWithFee(account, outputMint, amount); if (r) return send(res, 200, r); } catch (_) { /* fall through */ }
    }
    // SELL / other: referral fee on output (SOL on sells), fallback to no fee
    let r = await S.buildSwap(account, inputMint, outputMint, amount, true);
    if ((!r.swap || !r.swap.swapTransaction)) r = await S.buildSwap(account, inputMint, outputMint, amount, false);
    if (!r.quote) return send(res, 400, { error: 'no route — try another amount' });
    if (!r.swap || !r.swap.swapTransaction) return send(res, 502, { error: 'swap build failed' });
    return send(res, 200, { transaction: r.swap.swapTransaction, outAmount: r.quote.outAmount, inAmount: r.quote.inAmount, fee: r.feeApplied ? FEE_BPS : 0 });
  } catch (e) {
    return send(res, 502, { error: 'swap failed: ' + ((e && e.message) || e) });
  }
};
