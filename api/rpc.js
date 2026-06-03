'use strict';
/*
 * /api/rpc — server-side JSON-RPC proxy to Monad.
 * Browser calls hit this; the real upstream (Alchemy) lives in the
 * MONAD_RPC env var so the key never ships to the browser or the repo.
 * Set MONAD_RPC in Vercel to your Alchemy URL; falls back to public RPC.
 * Read-only method allowlist + origin guard to protect the quota.
 */
const UPSTREAM = process.env.MONAD_RPC || 'https://rpc.monad.xyz';
const ALLOW = new Set([
  'eth_call', 'eth_getcode', 'eth_getbalance', 'eth_blocknumber', 'eth_chainid',
  'eth_getlogs', 'eth_gettransactionreceipt', 'eth_gettransactionbyhash',
  'eth_getblockbynumber', 'eth_gettransactioncount', 'net_version',
]);
const OK = ['burnchronic.xyz', 'dirtyjenny.xyz', 'localhost', 'vercel.app'];

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const o = req.headers.origin || req.headers.referer || '';
  if (o && !OK.some((d) => o.includes(d))) { res.status(403).json({ error: 'forbidden origin' }); return; }

  try {
    let body = req.body;
    if (body == null || typeof body === 'string') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString() || (typeof body === 'string' ? body : '');
      body = raw ? JSON.parse(raw) : {};
    }
    const items = Array.isArray(body) ? body : [body];
    for (const it of items) {
      if (!it || !ALLOW.has(String(it.method || '').toLowerCase())) {
        res.status(400).json({ error: 'method not allowed: ' + (it && it.method) });
        return;
      }
    }
    const r = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    res.status(200).json(j);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
