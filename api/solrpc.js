'use strict';
/*
 * /api/solrpc — server-side JSON-RPC proxy to Solana (your Alchemy endpoint).
 * The browser calls this; the real upstream (with the API key) lives in the
 * SOLANA_RPC env var so the key never ships to the client or the repo.
 * Set SOLANA_RPC in Vercel to your Alchemy Solana URL; falls back to public.
 * Method allowlist (covers building, sending & confirming a burn tx) + origin guard.
 */
const UPSTREAM = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const ALLOW = new Set([
  'getlatestblockhash', 'getfeeformessage', 'sendtransaction',
  'getsignaturestatuses', 'gettransaction', 'simulatetransaction',
  'getbalance', 'getaccountinfo', 'getmultipleaccounts',
  'gettokenaccountbalance', 'gettokenaccountsbyowner', 'gettokensupply',
  'getminimumbalanceforrentexemption', 'getepochinfo', 'getslot',
]);
const OK = ['burnchronic.xyz', 'localhost', 'vercel.app'];

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
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      body = raw ? JSON.parse(raw) : {};
    }
    const items = Array.isArray(body) ? body : [body];
    for (const it of items) {
      if (!it || !ALLOW.has(String(it.method || '').toLowerCase())) {
        res.status(400).json({ error: 'method not allowed: ' + (it && it.method) });
        return;
      }
    }
    const r = await fetch(UPSTREAM, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    res.status(200).json(j);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
