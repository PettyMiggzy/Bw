'use strict';
/*
 * /api/review — product reviews for the shop.
 *   GET ?summary=1        → { summary: { productId: {avg,count} } }  (for star badges + structured data)
 *   GET ?product=<id>     → { reviews:[{name,rating,body,created_at}], avg, count }
 *   POST { product, rating(1-5), name?, body? } → { ok }
 * Stored in Supabase grow_reviews (service key). Origin-guarded.
 */
const G = require('./_grow.js');
const { blocked } = require('./_guard.js');

function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const S = (v, n) => (v == null ? '' : String(v)).slice(0, n || 200);
const r1 = (n) => Math.round(n * 10) / 10;

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (blocked(req, res)) return;
  if (!G.sbEnabled()) { res.statusCode = 200; res.end(JSON.stringify({ reviews: [], avg: 0, count: 0, summary: {} })); return; }

  if (req.method === 'GET') {
    let u = null; try { u = new URL(req.url, 'http://x'); } catch (_) {}
    const summary = u && u.searchParams.get('summary');
    const product = u && (u.searchParams.get('product') || '').slice(0, 40);
    try {
      if (summary) {
        const rows = await G.sbSelect('grow_reviews?approved=eq.true&select=product_id,rating');
        const agg = {};
        (rows || []).forEach((r) => { const p = r.product_id; (agg[p] = agg[p] || { s: 0, c: 0 }); agg[p].s += r.rating; agg[p].c++; });
        const out = {}; Object.keys(agg).forEach((p) => { out[p] = { avg: r1(agg[p].s / agg[p].c), count: agg[p].c }; });
        res.statusCode = 200; res.end(JSON.stringify({ summary: out })); return;
      }
      if (product) {
        const rows = await G.sbSelect(`grow_reviews?approved=eq.true&product_id=eq.${encodeURIComponent(product)}&select=name,rating,body,created_at&order=created_at.desc&limit=50`);
        let sum = 0; (rows || []).forEach((r) => { sum += r.rating; });
        const count = (rows || []).length;
        res.statusCode = 200; res.end(JSON.stringify({ reviews: rows || [], avg: count ? r1(sum / count) : 0, count })); return;
      }
      res.statusCode = 400; res.end(JSON.stringify({ error: 'product or summary required' })); return;
    } catch (e) { res.statusCode = 200; res.end(JSON.stringify({ reviews: [], avg: 0, count: 0, summary: {} })); return; }
  }

  if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET or POST' })); return; }

  const b = await readJson(req);
  const product = S(b.product, 40).trim();
  const rating = Math.max(1, Math.min(5, parseInt(b.rating, 10) || 0));
  const name = S(b.name, 40).trim() || 'anon';
  const body = S(b.body, 600).trim();
  if (!product || !rating) { res.statusCode = 400; res.end(JSON.stringify({ error: 'product and rating required' })); return; }
  try {
    await G.sbUpsert('grow_reviews', { product_id: product, rating, name, body, approved: true, created_at: new Date().toISOString() });
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: 'could not save review' })); return; }
  res.statusCode = 200; res.end(JSON.stringify({ ok: true }));
};
