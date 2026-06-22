'use strict';
/*
 * /api/moonpay — builds a SIGNED MoonPay widget URL for the fiat on/off ramp.
 *
 * MoonPay is the licensed party: it KYCs the end user, takes the card/bank, and
 * delivers SOL to (on-ramp) or cashes out SOL from (off-ramp) the user's own
 * wallet. We never touch fiat or custody — we only hand MoonPay a pre-filled,
 * tamper-proof URL. The $CHRONIC leg is the existing Jupiter swap (buy/sell).
 *
 *   GET /api/moonpay?intent=buy&address=<pubkey>[&usd=50]   -> { url }
 *   GET /api/moonpay?intent=sell&address=<pubkey>           -> { url }
 *
 * Security: the walletAddress (and any prefilled amount) MUST be locked with an
 * HMAC signature, or anyone could rewrite the URL to send funds elsewhere.
 * Signing uses the SECRET key, so it can only happen here, server-side.
 *
 * Env:
 *   MOONPAY_KEY     publishable key (pk_live_… / pk_test_…)
 *   MOONPAY_SECRET  secret key (sk_live_… / sk_test_…) — server only, never ship
 *   MOONPAY_ENV     'sandbox' (default until KYB clears) or 'live'
 * Until keys are set, returns { error:'ramp_unconfigured' } so the UI can show
 * a friendly "card buy unlocks soon" state instead of breaking.
 */
const crypto = require('crypto');
const G = require('./_grow.js');

const KEY = process.env.MOONPAY_KEY || '';
const SECRET = process.env.MOONPAY_SECRET || '';
const ENV = (process.env.MOONPAY_ENV || 'sandbox').toLowerCase();
const SANDBOX = ENV !== 'live';

const SITE = 'https://www.burnchronic.xyz';
const BRAND_GREEN = '#52ff8f';

// MoonPay widget hosts (sandbox vs production)
const BUY_HOST = SANDBOX ? 'https://buy-sandbox.moonpay.com' : 'https://buy.moonpay.com';
const SELL_HOST = SANDBOX ? 'https://sell-sandbox.moonpay.com' : 'https://sell.moonpay.com';

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('content-type', 'application/json');
}
const send = (res, code, obj) => res.status(code).json(obj);

// Sign the EXACT query string (leading '?') with the secret, base64 — exactly
// what MoonPay re-computes on their side to verify nothing was tampered with.
function sign(query) {
  return crypto.createHmac('sha256', SECRET).update(query).digest('base64');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });

  if (!KEY || !SECRET) return send(res, 503, { error: 'ramp_unconfigured' });

  const q = req.query || {};
  const intent = (q.intent === 'sell') ? 'sell' : 'buy';
  const address = String(q.address || '');
  if (!G.isPubkey(address)) return send(res, 400, { error: 'connect a wallet first' });

  const p = new URLSearchParams();
  p.set('apiKey', KEY);
  p.set('theme', 'dark');
  p.set('colorCode', BRAND_GREEN);

  let host;
  if (intent === 'buy') {
    host = BUY_HOST;
    p.set('currencyCode', 'sol');           // deliver SOL to the user's wallet
    p.set('walletAddress', address);         // locked by the signature below
    const usd = parseFloat(q.usd);
    if (usd > 0) p.set('baseCurrencyAmount', String(usd));
    p.set('redirectURL', SITE + '/buy?funded=1'); // back to the Jupiter swap
  } else {
    host = SELL_HOST;
    p.set('baseCurrencyCode', 'sol');        // user is selling SOL for fiat
    p.set('refundWalletAddress', address);   // where SOL returns if cancelled
    p.set('redirectURL', SITE + '/sell?cashed=1');
  }

  const query = '?' + p.toString();
  const signature = sign(query);
  const url = host + query + '&signature=' + encodeURIComponent(signature);

  return send(res, 200, { url, env: SANDBOX ? 'sandbox' : 'live' });
};
