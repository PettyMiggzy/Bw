'use strict';
/*
 * /api/order
 *   POST — record a $CHRONIC shop order after the customer paid on-chain (SOL).
 *          Body: { tx, items:[{id,name,size?,price,qty}], ship:{...}, totalSol, totalUsd, ref? }
 *          Stores in Supabase (grow_orders), pings Telegram, returns { ok, id }.
 *   GET ?tx=<sig> — order tracking: returns { id, status, created_at, items, total_usd }
 *          (status only — no shipping PII). The tx signature is the lookup key.
 *
 * Best-effort persist: a paid order is never lost on a DB hiccup; the on-chain
 * tx is the source of truth either way.
 */
const G = require('./_grow.js');
const { blocked } = require('./_guard.js');

function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const S = (v, n) => (v == null ? '' : String(v)).slice(0, n || 200);

// fire a Telegram alert to the ops chat (best-effort, never blocks the response)
async function tgAlert(row) {
  const tok = process.env.TG_BOT_TOKEN, chat = process.env.TG_ORDER_CHAT;
  if (!tok || !chat) return;
  const items = row.items.map((i) => `• ${i.qty}× ${i.name}`).join('\n');
  const text = `🛒 NEW ORDER  ${row.id}\n${items}\n\n💵 $${row.total_usd}  (${row.total_sol} SOL)\n${row.discount_pct ? '🎁 ' + row.discount_pct + '% holder discount\n' : ''}${row.cashback_chronic ? '🪙 cashback owed: ' + row.cashback_chronic + ' $CHRONIC\n' : ''}📦 ${row.ship.name} — ${row.ship.city}, ${row.ship.state} ${row.ship.zip} ${row.ship.country}\n${row.ship.email ? '✉️ ' + row.ship.email + '\n' : ''}${row.ref ? '🔗 ref: ' + row.ref + '\n' : ''}🔎 https://solscan.io/tx/${row.tx}`;
  try {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (_) {}
}

const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// send the customer an order confirmation via Resend (best-effort; no-op until RESEND_API_KEY is set)
async function emailConfirm(row) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ORDER_FROM_EMAIL || 'Burn Chronic <team@burnchronic.xyz>';
  const to = row.ship && row.ship.email;
  if (!key || !to || !/.+@.+\..+/.test(to)) return;
  const items = row.items.map((i) => `<li>${i.qty}× ${esc(i.name)} — $${i.price}</li>`).join('');
  const cashback = row.cashback_chronic ? `<p style="color:#f5cf57">🪙 You earned ≈ <b>${row.cashback_chronic} $CHRONIC</b> cashback — it drops to your wallet.</p>` : '';
  const discount = row.discount_pct ? `<p style="color:#52ff8f">🎁 ${row.discount_pct}% holder discount applied.</p>` : '';
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;background:#0b130d;color:#e9ffe9;padding:26px;border-radius:14px;border:1px solid rgba(82,255,143,.18)">
    <h2 style="color:#52ff8f;margin:0 0 6px">🌿 Order confirmed — holders eat.</h2>
    <p>Thanks ${esc(row.ship.name || '')} — we got your order and it ships discreetly soon.</p>
    <ul style="line-height:1.7">${items}</ul>
    <p style="font-size:16px"><b>Total: $${row.total_usd}</b></p>
    ${discount}${cashback}
    <p><a href="https://burnchronic.store/track?tx=${esc(row.tx)}" style="display:inline-block;background:#52ff8f;color:#04140a;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px">📦 Track your order →</a></p>
    <p style="color:#84a78d;font-size:12px;margin-top:18px">40% of your order just dripped to $CHRONIC holders. 🌿<br>Questions? Just reply to this email.</p>
  </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: 'team@burnchronic.xyz', subject: `Order confirmed — Burn Chronic (${row.id})`, html }),
    });
  } catch (_) {}
}

// email YOU the full order (incl. shipping) — the safe, private alternative to a Telegram chat
async function emailAdmin(row) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const to = process.env.ADMIN_EMAIL || 'team@burnchronic.xyz';
  const from = process.env.ORDER_FROM_EMAIL || 'Burn Chronic <team@burnchronic.xyz>';
  const s = row.ship || {};
  const items = row.items.map((i) => `<li>${i.qty}× ${esc(i.name)} — $${i.price}</li>`).join('');
  const line = (label, val) => val ? `<tr><td style="color:#84a78d;padding:2px 10px 2px 0">${label}</td><td><b>${esc(val)}</b></td></tr>` : '';
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;color:#0b130d">
    <h2 style="margin:0 0 4px">🛒 NEW ORDER — ${esc(row.id)}</h2>
    <p style="font-size:18px;margin:0 0 10px"><b>$${row.total_usd}</b> ${row.total_sol ? '(' + row.total_sol + ' SOL)' : '(USDC)'}${row.discount_pct ? ' · 🎁 ' + row.discount_pct + '% holder discount' : ''}</p>
    <ul style="line-height:1.7">${items}</ul>
    ${row.cashback_chronic ? `<p style="color:#b8860b">🪙 Cashback owed: <b>${row.cashback_chronic} $CHRONIC</b>${row.buyer_wallet ? ' → ' + esc(row.buyer_wallet) : ''}</p>` : ''}
    <h3 style="margin:16px 0 4px">📦 Ship to</h3>
    <table style="font-size:13px;border-collapse:collapse">
      ${line('Name', s.name)}${line('Address', s.addr)}${line('City', s.city)}${line('State', s.state)}${line('ZIP', s.zip)}${line('Country', s.country)}${line('Email', s.email)}${line('Referral', row.ref)}
    </table>
    <p style="margin-top:14px"><a href="https://solscan.io/tx/${esc(row.tx)}">View payment on Solscan ↗</a></p>
  </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: `🛒 NEW ORDER ${row.id} — $${row.total_usd}`, html }),
    });
  } catch (_) {}
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (blocked(req, res)) return;

  // ── order tracking ──
  if (req.method === 'GET') {
    let tx = '';
    try { tx = (new URL(req.url, 'http://x').searchParams.get('tx') || '').trim(); } catch (_) {}
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(tx)) { res.statusCode = 400; res.end(JSON.stringify({ error: 'provide a valid payment signature' })); return; }
    try {
      if (!G.sbEnabled()) { res.statusCode = 503; res.end(JSON.stringify({ error: 'tracking unavailable' })); return; }
      const rows = await G.sbSelect(`grow_orders?tx=eq.${encodeURIComponent(tx)}&select=id,status,created_at,items,total_usd`);
      if (!rows || !rows.length) { res.statusCode = 404; res.end(JSON.stringify({ error: 'order not found' })); return; }
      res.statusCode = 200; res.end(JSON.stringify(rows[0])); return;
    } catch (e) { res.statusCode = 404; res.end(JSON.stringify({ error: 'order not found' })); return; }
  }

  if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST or GET' })); return; }

  const b = await readJson(req);
  const tx = S(b.tx, 100).trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(tx)) {
    res.statusCode = 400; res.end(JSON.stringify({ error: 'missing or invalid payment signature' })); return;
  }

  const items = Array.isArray(b.items) ? b.items.slice(0, 60).map((it) => ({
    id: S(it && it.id, 40), name: S(it && it.name, 140), size: S(it && it.size, 16),
    price: Number(it && it.price) || 0, qty: Math.max(1, Math.min(99, parseInt(it && it.qty, 10) || 1)),
  })) : [];
  if (!items.length) { res.statusCode = 400; res.end(JSON.stringify({ error: 'empty cart' })); return; }

  const s = b.ship || {};
  const ship = {
    name: S(s.name, 120), email: S(s.email, 160), addr: S(s.addr, 240),
    city: S(s.city, 80), state: S(s.state, 60), zip: S(s.zip, 24), country: S(s.country, 60) || 'US',
  };
  if (!ship.name || !ship.addr || !ship.city || !ship.zip) {
    res.statusCode = 400; res.end(JSON.stringify({ error: 'incomplete shipping address' })); return;
  }

  const id = tx.slice(0, 16);
  const buyerWallet = S(b.buyer, 50).trim();
  const row = {
    id, tx, items, ship,
    buyer_wallet: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(buyerWallet) ? buyerWallet : null,
    ref: S(b.ref, 80).trim() || null,
    total_sol: Number(b.totalSol) || 0,
    total_usd: Number(b.totalUsd) || 0,       // net charged (after holder discount)
    gross_usd: Number(b.grossUsd) || Number(b.totalUsd) || 0,
    discount_pct: Number(b.discountPct) || 0,
    cashback_chronic: Number(b.cashback) || 0, // $CHRONIC owed to buyer (paid out by worker)
    holder_bal: Number(b.holderBal) || 0,
    status: 'new',
    created_at: new Date().toISOString(),
  };

  try { if (G.sbEnabled()) await G.sbUpsert('grow_orders', row, 'id'); } catch (_) {}
  await tgAlert(row);          // optional — only if TG vars set
  await emailAdmin(row);       // emails YOU the full order (safest) — only if RESEND_API_KEY set
  await emailConfirm(row);     // emails the customer their confirmation

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, id }));
};
