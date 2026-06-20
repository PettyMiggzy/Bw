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
const FEE_WALLET = process.env.MEME_FEE_WALLET || 'E7Cr2nad1SvBWF8vcGhNW575UVVPdTcgHEqSTMQzoUr5';
const BURN_WALLET = process.env.MEME_BURN_WALLET || '6869BJqsz86WYkQJtc2do5s97hoKXMF8YxZe3oWwzpva';
const PAID = PRICE_LAMPORTS > 0;
const BURN_LAMPORTS = Math.floor((PRICE_LAMPORTS * BURN_BPS) / 10000);
const FEE_LAMPORTS = PRICE_LAMPORTS - BURN_LAMPORTS;

function paymentInfo(extra) {
  return Object.assign({
    error: 'payment_required',
    priceSol: PRICE_SOL,
    priceLamports: PRICE_LAMPORTS,
    feeWallet: FEE_WALLET,
    burnWallet: BURN_WALLET,
    feeLamports: FEE_LAMPORTS,
    burnLamports: BURN_LAMPORTS,
    burnBps: BURN_BPS,
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
  if (tx.blockTime && (Date.now() / 1000 - tx.blockTime) > 300) return { ok: false, reason: 'too_old' };

  const akeys = tx.transaction.message.accountKeys || [];
  const signer = akeys.find((k) => k.signer);
  if (!signer || (signer.pubkey || signer) !== account) return { ok: false, reason: 'wrong_signer' };

  const keys = akeys.map((k) => k.pubkey || k);
  const pre = tx.meta.preBalances || [];
  const post = tx.meta.postBalances || [];
  const gain = (wallet) => { const i = keys.indexOf(wallet); return i < 0 ? 0n : BigInt(post[i] || 0) - BigInt(pre[i] || 0); };
  if (gain(FEE_WALLET) < BigInt(FEE_LAMPORTS)) return { ok: false, reason: 'fee_short' };
  if (gain(BURN_WALLET) < BigInt(BURN_LAMPORTS)) return { ok: false, reason: 'burn_short' };
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
      feeWallet: FEE_WALLET, burnWallet: BURN_WALLET,
      feeLamports: FEE_LAMPORTS, burnLamports: BURN_LAMPORTS, burnBps: BURN_BPS,
    });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!KEY) return send(res, 503, { error: 'meme gen not configured yet' });

  const b = await readBody(req);
  const prompt = String(b.prompt || '').trim().slice(0, 600);
  if (prompt.length < 2) return send(res, 400, { error: 'type what you want to see' });
  const style = STYLES[b.style] != null ? b.style : 'none';

  if (PAID) {
    const sig = String(b.signature || '').trim();
    const account = String(b.account || '').trim();
    if (!sig) return send(res, 402, paymentInfo());           // client then pays + retries
    if (!G.isPubkey(account)) return send(res, 400, { error: 'connect a wallet' });
    if (await sigUsed(sig)) return send(res, 402, paymentInfo({ error: 'payment already used' }));
    const v = await verifyPayment(sig, account);
    if (!v.ok) return send(res, 402, paymentInfo({ error: 'payment not verified (' + v.reason + ')' }));
    await markSig(sig, account);
  } else {
    // free mode — guard with a per-IP daily cap
    if (!(await underLimit(clientIp(req)))) {
      return send(res, 429, { error: 'daily limit reached — come back tomorrow 🔥' });
    }
  }

  try {
    const out = await generate(prompt, style);
    if (out.error) return send(res, 502, { error: out.error });
    return send(res, 200, out);
  } catch (e) {
    return send(res, 502, { error: 'gen failed: ' + ((e && e.message) || e) });
  }
};
