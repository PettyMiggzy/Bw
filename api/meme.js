'use strict';
/*
 * /api/meme — Venice AI image generation for the CHRONIC meme generator.
 * POST { prompt, style? }  ->  { image: "data:image/png;base64,..." }
 *
 * The Venice key NEVER leaves the server (VENICE_API_KEY). Generation costs a
 * fraction of a cent per image, so a best-effort per-IP daily cap (Supabase,
 * grow_meme_usage) keeps a public endpoint from being spammed into a bill.
 * If Supabase isn't configured the cap is skipped — trades/memes never break.
 *
 * Env:
 *   VENICE_API_KEY   - required (https://venice.ai → API keys)
 *   VENICE_MODEL     - optional, defaults to z-image-turbo (fastest/cheapest)
 *   MEME_DAILY_CAP   - optional, per-IP images/day (default 25)
 */
const G = require('./_grow.js');

const VENICE = 'https://api.venice.ai/api/v1/image/generate';
const KEY = process.env.VENICE_API_KEY || '';
const MODEL = process.env.VENICE_MODEL || 'z-image-turbo';
const DAILY_CAP = parseInt(process.env.MEME_DAILY_CAP || '25', 10);

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
function clientIp(req) {
  const h = req.headers || {};
  return String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim();
}

// best-effort per-IP daily cap — never blocks on infra errors
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

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!KEY) return send(res, 503, { error: 'meme gen not configured yet' });

  const b = await readBody(req);
  let prompt = String(b.prompt || '').trim().slice(0, 600);
  if (prompt.length < 2) return send(res, 400, { error: 'type what you want to see' });
  const style = STYLES[b.style] != null ? b.style : 'none';

  if (!(await underLimit(clientIp(req)))) {
    return send(res, 429, { error: 'daily limit reached — come back tomorrow 🔥' });
  }

  const fullPrompt = prompt + (STYLES[style] || '');
  try {
    const r = await fetch(VENICE, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt: fullPrompt,
        width: 1024, height: 1024,
        format: 'png',
        steps: 20,
        safe_mode: false,        // uncensored — memecoin culture
        hide_watermark: true,    // unbranded; we add our own caption
        return_binary: false,
      }),
    });
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch (_) { j = null; }
    if (!r.ok) {
      const msg = (j && (j.error || j.message)) || `venice ${r.status}`;
      return send(res, 502, { error: String(msg).slice(0, 180) });
    }
    const b64 = j && ((j.images && j.images[0]) || (j.data && j.data[0] && (j.data[0].b64_json || j.data[0])));
    if (!b64) return send(res, 502, { error: 'no image returned — try again' });
    return send(res, 200, { image: 'data:image/png;base64,' + b64 });
  } catch (e) {
    return send(res, 502, { error: 'gen failed: ' + ((e && e.message) || e) });
  }
};
