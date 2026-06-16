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
  const text = `🛒 NEW ORDER  ${row.id}\n${items}\n\n💵 $${row.total_usd}  (${row.total_sol} SOL)\n📦 ${row.ship.name} — ${row.ship.city}, ${row.ship.state} ${row.ship.zip} ${row.ship.country}\n${row.ship.email ? '✉️ ' + row.ship.email + '\n' : ''}${row.ref ? '🔗 ref: ' + row.ref + '\n' : ''}🔎 https://solscan.io/tx/${row.tx}`;
  try {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
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
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: 'lookup failed' })); return; }
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
  const row = {
    id, tx, items, ship,
    ref: S(b.ref, 80).trim() || null,
    total_sol: Number(b.totalSol) || 0,
    total_usd: Number(b.totalUsd) || 0,
    status: 'new',
    created_at: new Date().toISOString(),
  };

  try { if (G.sbEnabled()) await G.sbUpsert('grow_orders', row, 'id'); } catch (_) {}
  await tgAlert(row);

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, id }));
};
