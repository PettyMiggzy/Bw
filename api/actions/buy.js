'use strict';
/*
 * /api/actions/buy — Solana Action ("Blink") to BUY $CHRONIC with SOL from a
 * tweet/link, via the Jupiter swap aggregator. "Trade from X."
 *   GET  -> card with SOL amount presets + custom
 *   POST -> Jupiter quote + swap; returns the ready-to-sign swap transaction
 * Zero-dep: Jupiter builds the transaction, we just relay it.
 */
const G = require('../_grow.js');
const S = require('../_swap.js');

const ICON = 'https://www.burnchronic.xyz/assets/og-chronic.jpg';
const SOL = 'So11111111111111111111111111111111111111112';
const PRESETS = [0.1, 0.5, 1];

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Action-Version, X-Blockchain-Ids');
  res.setHeader('Access-Control-Expose-Headers', 'X-Action-Version, X-Blockchain-Ids');
  res.setHeader('X-Action-Version', '2.4');
  res.setHeader('X-Blockchain-Ids', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  res.setHeader('Content-Type', 'application/json');
}
const send = (res, code, obj) => { res.status(code).json(obj); };
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
}

module.exports = async (req, res) => {
  setHeaders(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method === 'GET') {
    const mk = (s) => ({ type: 'transaction', label: `Buy with ${s} SOL`, href: `/api/actions/buy?sol=${s}` });
    return send(res, 200, {
      type: 'action', icon: ICON,
      title: '🪙 Buy $CHRONIC',
      description: 'Ape into $CHRONIC straight from here — swaps SOL → $CHRONIC via Jupiter, one click. then burn it 🔥💀',
      label: 'Buy $CHRONIC',
      links: { actions: [
        ...PRESETS.map(mk),
        { type: 'transaction', label: 'Buy', href: '/api/actions/buy?sol={amount}',
          parameters: [{ name: 'amount', label: 'how much SOL?', type: 'number', required: true, min: 0.001 }] },
      ] },
    });
  }
  if (req.method !== 'POST') return send(res, 405, { message: 'POST only' });

  const body = await readBody(req);
  const account = body.account;
  const sol = Number(req.query.sol);
  if (!(sol > 0) || sol > 1000) return send(res, 400, { message: 'Enter a valid SOL amount.' });
  if (!account || !G.isPubkey(account)) return send(res, 400, { message: 'Connect a Solana wallet.' });

  try {
    const lamports = String(Math.round(sol * 1e9));
    // 1% SOL fee (same as the terminal); fall back to a plain swap if it can't build
    let transaction = null;
    try { const r = await S.buildBuyWithFee(account, G.MINT, lamports); if (r) transaction = r.transaction; } catch (_) { /* fall through */ }
    if (!transaction) {
      const r = await S.buildSwap(account, SOL, G.MINT, lamports, false);
      if (!r.quote) return send(res, 400, { message: 'No route — try a different amount or later.' });
      if (!r.swap || !r.swap.swapTransaction) return send(res, 502, { message: 'Swap build failed — try again.' });
      transaction = r.swap.swapTransaction;
    }
    return send(res, 200, {
      type: 'transaction',
      transaction,
      message: `Buy $CHRONIC with ${sol} SOL — then burn it 🔥`,
    });
  } catch (e) {
    return send(res, 502, { message: 'Buy failed: ' + ((e && e.message) || e) });
  }
};
