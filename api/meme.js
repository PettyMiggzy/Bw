'use strict';
/*
 * /api/meme — Venice AI image generation for the CHRONIC meme generator.
 *
 *   GET                              -> { paid, priceSol, feeWallet, burnWallet, ... }
 *   POST { prompt, style }           -> { image } | 402 payment_required (paid mode)
 *   POST { prompt, style, account, signature }
 *                                    -> verifies the SOL payment on-chain, then { image }
 *
 * Pay-to-generate (covers the Venice cost + profit, and burns):
 *   Each generation costs MEME_PRICE_SOL. The user's wallet sends ONE plain tx:
 *     - MEME_BURN_BPS (40%) -> MEME_BURN_WALLET  (the DCA buy-burn wallet; it
 *       buys $CHRONIC with the SOL and burns it -> deflationary)
 *     - the rest    (60%)  -> MEME_FEE_WALLET   (overhead)
 *   We verify that tx landed before calling Venice, so nobody gets a free image.
 *   Plain SystemProgram transfers => Phantom simulates cleanly (no warning).
 *
 * Set MEME_PRICE_SOL=0 to make it free (then a per-IP daily cap applies instead).
 * The Venice key NEVER leaves the server.
 *
 * Env:
 *   venice_api_key / VENICE_API_KEY  - required
 *   VENICE_MODEL     - default z-image-turbo (cheapest: $0.01/image)
 *   MEME_PRICE_SOL   - default 0.002  (per image)
 *   MEME_BURN_BPS    - default 4000   (40% of the fee buys+burns $CHRONIC)
 *   MEME_FEE_WALLET  - 60% overhead   (default: shop wallet)
 *   MEME_BURN_WALLET - 40% buy-burn   (default: DCA buy-burn wallet)
 *   MEME_DAILY_CAP   - free-mode only, per-IP images/day (default 25)
 */
const G = require('./_grow.js');

const VENICE = 'https://api.venice.ai/api/v1/image/generate';
const KEY = process.env.VENICE_API_KEY || process.env.venice_api_key || '';
const MODEL = process.env.VENICE_MODEL || 'z-image-turbo';
const DAILY_CAP = parseInt(process.env.MEME_DAILY_CAP || '25', 10);

const PRICE_SOL = parseFloat(process.env.MEME_PRICE_SOL || '0.002');
const PRICE_LAMPORTS = Math.max(0, Math.round((PRICE_SOL || 0) * 1e9));
const BURN_BPS = parseInt(process.env.MEME_BURN_BPS || '4000', 10);
const YIELD_BPS = parseInt(process.env.MEME_YIELD_BPS || '3000', 10);
const FEE_WALLET = process.env.MEME_FEE_WALLET || 'E7Cr2nad1SvBWF8vcGhNW575UVVPdTcgHEqSTMQzoUr5';
const BURN_WALLET = process.env.MEME_BURN_WALLET || '6869BJqsz86WYkQJtc2do5s97hoKXMF8YxZe3oWwzpva';
// some of the overhead funds the grow SOL-yield pool (defaults to the grow pool wallet)
const YIELD_WALLET = process.env.MEME_YIELD_WALLET || process.env.POOL_WALLET || '';
const PAID = PRICE_LAMPORTS > 0;
const BURN_LAMPORTS = Math.floor((PRICE_LAMPORTS * BURN_BPS) / 10000);
const YIELD_LAMPORTS = YIELD_WALLET ? Math.floor((PRICE_LAMPORTS * YIELD_BPS) / 10000) : 0;
const FEE_LAMPORTS = Math.max(0, PRICE_LAMPORTS - BURN_LAMPORTS - YIELD_LAMPORTS);

function paymentInfo(extra) {
  return Object.assign({
    error: 'payment_required',
    priceSol: PRICE_SOL,
    priceLamports: PRICE_LAMPORTS,
    feeWallet: FEE_WALLET,
    burnWallet: BURN_WALLET,
    yieldWallet: YIELD_WALLET,
    feeLamports: FEE_LAMPORTS,
    burnLamports: BURN_LAMPORTS,
    yieldLamports: YIELD_LAMPORTS,
    burnBps: BURN_BPS,
    yieldBps: YIELD_LAMPORTS ? YIELD_BPS : 0,
  }, extra || {});
}

// prompt flavor presets — appended to the user's prompt
const STYLES = {
  none: '',
  stoner: ', trippy psychedelic stoner art, cannabis leaves, vivid neon green smoke, glowing',
  cartoon: ', bold cartoon meme style, thick black outlines, exaggerated, funny, high contrast',
  pixel: ', retro pixel art, 8-bit, crisp pixels, vibrant palette',
  anime: ', anime style, cel shaded, vibrant, highly detailed',
  realistic: ', photorealistic, cinematic lighting, ultra detailed, 8k',
  '3d': ', glossy 3d render, octane render, studio lighting, smooth',
};

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
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
function clientIp(req) {
  const h = req.headers || {};
  return String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim();
}

// best-effort per-IP daily cap — FREE mode only; never blocks on infra errors
async function underLimit(ip) {
  if (!G.sbEnabled() || !ip) return true;
  const day = new Date().toISOString().slice(0, 10);
  try {
    const rows = await G.sbSelect(`grow_meme_usage?ip=eq.${encodeURIComponent(ip)}&day=eq.${day}&select=count`);
    const used = (rows && rows[0] && rows[0].count) || 0;
    if (used >= DAILY_CAP) return false;
    await G.sbUpsert('grow_meme_usage', { ip, day, count: used + 1 }, 'ip,day');
  } catch (_) { /* table missing / infra hiccup — don't block */ }
  return true;
}

// each payment signature is spendable once (best-effort; recency check backs it up)
async function sigUsed(sig) {
  if (!G.sbEnabled()) return false;
  try {
    const rows = await G.sbSelect(`grow_meme_paid?sig=eq.${encodeURIComponent(sig)}&select=sig`);
    return !!(rows && rows.length);
  } catch (_) { return false; }
}
async function markSig(sig, wallet) {
  if (!G.sbEnabled()) return;
  try { await G.sbUpsert('grow_meme_paid', { sig, wallet }, 'sig'); } catch (_) { /* ignore */ }
}

// verify the payment tx: signed by `account`, recent, and both wallets got their share
async function verifyPayment(sig, account) {
  if (typeof sig !== 'string' || sig.length < 80 || sig.length > 100) return { ok: false, reason: 'bad_sig' };
  const tx = await G.solRpc('getTransaction', [sig, {
    encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  }]);
  if (!tx) return { ok: false, reason: 'tx_not_found' };
  if (tx.meta && tx.meta.err) return { ok: false, reason: 'tx_failed' };
  // recency backstop so a payment can't be replayed long after the fact
  // (generous window so a user can retry a failed generation without re-paying)
  if (tx.blockTime && (Date.now() / 1000 - tx.blockTime) > 1200) return { ok: false, reason: 'too_old' };

  const akeys = tx.transaction.message.accountKeys || [];
  const signer = akeys.find((k) => k.signer);
  if (!signer || (signer.pubkey || signer) !== account) return { ok: false, reason: 'wrong_signer' };

  // Count the SOL actually sent TO each wallet from the parsed System transfers.
  // (We can't use net balance deltas: when the payer IS the fee wallet — e.g. the
  // owner testing with the treasury wallet — its delta nets negative and looks short.)
  let gotFee = 0n, gotBurn = 0n, gotYield = 0n;
  const scan = (ixs) => {
    for (const ix of (ixs || [])) {
      const p = ix.parsed;
      if (p && p.type === 'transfer' && p.info && p.info.lamports != null) {
        const amt = BigInt(p.info.lamports);
        if (p.info.destination === FEE_WALLET) gotFee += amt;
        if (p.info.destination === BURN_WALLET) gotBurn += amt;
        if (YIELD_WALLET && p.info.destination === YIELD_WALLET) gotYield += amt;
      }
    }
  };
  scan(tx.transaction.message.instructions);
  for (const inner of (tx.meta.innerInstructions || [])) scan(inner.instructions);

  if (gotFee < BigInt(FEE_LAMPORTS)) return { ok: false, reason: 'fee_short' };
  if (gotBurn < BigInt(BURN_LAMPORTS)) return { ok: false, reason: 'burn_short' };
  if (YIELD_LAMPORTS > 0 && gotYield < BigInt(YIELD_LAMPORTS)) return { ok: false, reason: 'yield_short' };
  return { ok: true };
}

async function generate(prompt, style) {
  const fullPrompt = prompt + (STYLES[style] || '');
  const r = await fetch(VENICE, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, prompt: fullPrompt,
      width: 1024, height: 1024, format: 'png', steps: 20,
      safe_mode: false, hide_watermark: true, return_binary: false,
    }),
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (_) { j = null; }
  if (!r.ok) { const m = (j && (j.error || j.message)) || `venice ${r.status}`; return { error: String(m).slice(0, 180) }; }
  const b64 = j && ((j.images && j.images[0]) || (j.data && j.data[0] && (j.data[0].b64_json || j.data[0])));
  if (!b64) return { error: 'no image returned — try again' };
  return { image: 'data:image/png;base64,' + b64 };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // GET -> pricing/config for the client (so it can show the price + build payment)
  if (req.method === 'GET') {
    return send(res, 200, {
      ok: true, paid: PAID, priceSol: PRICE_SOL, priceLamports: PRICE_LAMPORTS,
      feeWallet: FEE_WALLET, burnWallet: BURN_WALLET, yieldWallet: YIELD_WALLET,
      feeLamports: FEE_LAMPORTS, burnLamports: BURN_LAMPORTS, yieldLamports: YIELD_LAMPORTS,
      burnBps: BURN_BPS, yieldBps: YIELD_LAMPORTS ? YIELD_BPS : 0,
    });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!KEY) return send(res, 503, { error: 'meme gen not configured yet' });

  const b = await readBody(req);
  const prompt = String(b.prompt || '').trim().slice(0, 600);
  if (prompt.length < 2) return send(res, 400, { error: 'type what you want to see' });
  const style = STYLES[b.style] != null ? b.style : 'none';

  let paidSig = null, paidAccount = null;
  if (PAID) {
    const sig = String(b.signature || '').trim();
    const account = String(b.account || '').trim();
    if (!sig) return send(res, 402, paymentInfo());           // client then pays + retries
    if (!G.isPubkey(account)) return send(res, 400, { error: 'connect a wallet' });
    if (await sigUsed(sig)) return send(res, 402, paymentInfo({ error: 'payment already used' }));
    const v = await verifyPayment(sig, account);
    if (!v.ok) return send(res, 402, paymentInfo({ error: 'payment not verified (' + v.reason + ')' }));
    paidSig = sig; paidAccount = account;            // valid — but DON'T consume until an image is delivered
  } else {
    // free mode — guard with a per-IP daily cap
    if (!(await underLimit(clientIp(req)))) {
      return send(res, 429, { error: 'daily limit reached — come back tomorrow 🔥' });
    }
  }

  try {
    const out = await generate(prompt, style);
    // generation failed: do NOT consume the payment — the user can retry the
    // SAME signature for free until it works (within the recency window).
    if (out.error) return send(res, 502, { error: out.error, retryable: PAID });
    if (paidSig) await markSig(paidSig, paidAccount);   // success -> spend the payment now
    return send(res, 200, out);
  } catch (e) {
    return send(res, 502, { error: 'gen failed: ' + ((e && e.message) || e), retryable: PAID });
  }
};
