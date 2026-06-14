'use strict';
/*
 * /api/actions/sell — Solana Action ("Blink") to SELL $CHRONIC for SOL from a
 * tweet/link, via Jupiter. Mirror of /api/actions/buy. "Take profit from X."
 *   GET  -> card with $CHRONIC amount presets + custom
 *   POST -> Jupiter quote + swap ($CHRONIC -> SOL); returns the swap transaction
 */
const G = require('../_grow.js');

const ICON = 'https://www.burnchronic.xyz/assets/og-chronic.jpg';
const SOL = 'So11111111111111111111111111111111111111112';
const JUP = 'https://lite-api.jup.ag/swap/v1';
const SLIPPAGE_BPS = 500;
const PRESETS = [100000, 500000, 1000000];

function fmt(n) { n = Math.floor(Number(n) || 0); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'; return String(n); }
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
    const mk = (a) => ({ type: 'transaction', label: `Sell ${fmt(a)}`, href: `/api/actions/sell?amt=${a}` });
    return send(res, 200, {
      type: 'action', icon: ICON,
      title: '🔻 Sell $CHRONIC',
      description: 'Take profit straight from here — swaps $CHRONIC → SOL via Jupiter. (or just burn it 🔥💀)',
      label: 'Sell $CHRONIC',
      links: { actions: [
        ...PRESETS.map(mk),
        { type: 'transaction', label: 'Sell', href: '/api/actions/sell?amt={amount}',
          parameters: [{ name: 'amount', label: 'how much $CHRONIC?', type: 'number', required: true, min: 1 }] },
      ] },
    });
  }
  if (req.method !== 'POST') return send(res, 405, { message: 'POST only' });

  const body = await readBody(req);
  const account = body.account;
  const amt = Math.floor(Number(req.query.amt));
  if (!(amt >= 1) || amt > 1e15) return send(res, 400, { message: 'Enter a valid $CHRONIC amount.' });
  if (!account || !G.isPubkey(account)) return send(res, 400, { message: 'Connect a Solana wallet.' });

  try {
    const baseUnits = (BigInt(amt) * (10n ** BigInt(G.DECIMALS))).toString();
    const qs = new URLSearchParams({ inputMint: G.MINT, outputMint: SOL, amount: baseUnits, slippageBps: String(SLIPPAGE_BPS) });
    const quote = await (await fetch(`${JUP}/quote?${qs.toString()}`)).json();
    if (!quote || quote.error || !quote.outAmount) return send(res, 400, { message: 'No route — try a different amount or later.' });

    const swap = await (await fetch(`${JUP}/swap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: account, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
    })).json();
    if (!swap || !swap.swapTransaction) return send(res, 502, { message: 'Swap build failed — try again.' });

    return send(res, 200, {
      type: 'transaction',
      transaction: swap.swapTransaction,
      message: `Sell ${fmt(amt)} $CHRONIC for SOL`,
    });
  } catch (e) {
    return send(res, 502, { message: 'Sell failed: ' + ((e && e.message) || e) });
  }
};
