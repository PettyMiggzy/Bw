'use strict';
/*
 * POST /api/order — record a $CHRONIC shop order after the customer has paid
 * on-chain (SOL). The browser sends the cart + shipping + the payment tx
 * signature; we store it so orders can be fulfilled via the dropship supplier
 * (SmokeDrop / MHGP) and the customer gets a confirmation. Best-effort: if
 * Supabase isn't configured the order still returns ok so checkout never blocks
 * on a paid customer — the tx signature is the source of truth either way.
 *
 * Body: { tx, items:[{id,name,price,qty}], ship:{name,email,addr,city,state,zip,country},
 *         totalSol, totalUsd }
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

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return; }
  if (blocked(req, res)) return;

  const b = await readJson(req);
  const tx = S(b.tx, 100).trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(tx)) {
    res.statusCode = 400; res.end(JSON.stringify({ error: 'missing or invalid payment signature' })); return;
  }

  const items = Array.isArray(b.items) ? b.items.slice(0, 60).map((it) => ({
    id: S(it && it.id, 40), name: S(it && it.name, 120),
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
    total_sol: Number(b.totalSol) || 0,
    total_usd: Number(b.totalUsd) || 0,
    status: 'new',
    created_at: new Date().toISOString(),
  };

  // best-effort persist — a paid order is never lost on a DB hiccup; tx is on-chain
  try { if (G.sbEnabled()) await G.sbUpsert('grow_orders', row, 'id'); } catch (_) {}

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, id }));
};
