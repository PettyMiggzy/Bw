'use strict';
/*
 * /api/launch — $CHRONIC Launchpad (non-custodial, on pump.fun via PumpPortal).
 *   POST action=metadata { imageBase64, fileType, name, symbol, description, twitter?, telegram?, website? }
 *        -> uploads to pump.fun IPFS, returns { uri }
 *   POST action=create   { publicKey, mint, name, symbol, uri, image, devBuySol? }
 *        -> returns { transaction (base64) } for the user to sign (with the mint keypair + wallet),
 *           and records the launch so the dev earns 50% of terminal fees on their token.
 *
 * The user pays + signs everything (the mint keypair is generated client-side and
 * never leaves the browser). We never custody funds or keys.
 */
const G = require('./_grow.js');

const PUMP_IPFS = 'https://pump.fun/api/ipfs';
const PUMPPORTAL = 'https://pumpportal.fun/api/trade-local';

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

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = await readBody(req);
  const action = b.action;

  try {
    // ── upload image + metadata to pump.fun IPFS ──
    if (action === 'metadata') {
      if (!b.imageBase64 || !b.name || !b.symbol) return send(res, 400, { error: 'need image, name, symbol' });
      const bytes = Buffer.from(String(b.imageBase64).replace(/^data:[^,]+,/, ''), 'base64');
      if (bytes.length > 3_000_000) return send(res, 400, { error: 'image too big (max ~3MB)' });
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: b.fileType || 'image/png' }), 'image.png');
      form.append('name', String(b.name).slice(0, 32));
      form.append('symbol', String(b.symbol).slice(0, 10));
      form.append('description', String(b.description || '').slice(0, 500));
      form.append('twitter', String(b.twitter || ''));
      form.append('telegram', String(b.telegram || ''));
      form.append('website', String(b.website || ''));
      form.append('showName', 'true');
      const r = await fetch(PUMP_IPFS, { method: 'POST', body: form });
      if (!r.ok) return send(res, 502, { error: 'metadata upload failed (' + r.status + ')' });
      const j = await r.json();
      const uri = j.metadataUri || (j.metadata && j.metadata.uri);
      if (!uri) return send(res, 502, { error: 'no metadata uri' });
      return send(res, 200, { uri, image: (j.metadata && j.metadata.image) || '' });
    }

    // ── build the create transaction (PumpPortal local) ──
    if (action === 'create') {
      const { publicKey, mint, name, symbol, uri } = b;
      if (!G.isPubkey(publicKey) || !G.isPubkey(mint) || !name || !symbol || !uri) return send(res, 400, { error: 'missing create fields' });
      const devBuy = Math.max(0, Math.min(50, Number(b.devBuySol) || 0));
      const r = await fetch(PUMPPORTAL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publicKey, action: 'create',
          tokenMetadata: { name: String(name).slice(0, 32), symbol: String(symbol).slice(0, 10), uri },
          mint, denominatedInSol: 'true', amount: devBuy, slippage: 10, priorityFee: 0.0005, pool: 'pump',
        }),
      });
      if (!r.ok) { const t = await r.text(); return send(res, 502, { error: 'pumpportal: ' + r.status + ' ' + t.slice(0, 140) }); }
      const buf = Buffer.from(await r.arrayBuffer());
      // record the launch (best-effort) so the dev earns 50% of terminal fees
      try {
        if (G.sbEnabled()) await G.sbUpsert('grow_launches', {
          mint, dev_wallet: publicKey, name: String(name).slice(0, 32), symbol: String(symbol).slice(0, 10), uri, image: b.image || '',
        }, 'mint');
      } catch (_) { /* non-fatal */ }
      return send(res, 200, { transaction: buf.toString('base64'), mint });
    }

    // ── public: recent pad launches (the feed) ──
    if (action === 'feed') {
      if (!G.sbEnabled()) return send(res, 200, { launches: [] });
      const rows = await G.sbSelect('grow_launches?select=mint,name,symbol,image,dev_wallet,created_at&order=created_at.desc&limit=30');
      return send(res, 200, { launches: rows });
    }

    return send(res, 400, { error: 'unknown action' });
  } catch (e) {
    return send(res, 502, { error: 'launch failed: ' + ((e && e.message) || e) });
  }
};
