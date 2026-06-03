'use strict';
/*
 * GET /api/insiders?address=0xTOKEN
 *
 * Classifies every wallet that touched a token by HOW it got its tokens —
 * the scam tell isn't who holds, it's who got tokens without ever buying.
 *   buyer   : bought from the pool (paid for it)            🟢
 *   loaded  : got tokens free (transfer in), still holding  🟡 insider sitting on a free bag
 *   dumper  : got free, never bought, then sold to the pool 🔴 dumped on the community
 *   mover   : got free, never bought, sent it onward        🔴 distributing free bags
 * Plus the deployer, the pool/AMM addresses, and a plain verdict.
 */
const L = require('./_lib.js');
const ZERO = '0x0000000000000000000000000000000000000000';

function hexBig(h) { try { return (h && h !== '0x') ? BigInt(h) : 0n; } catch (_) { return 0n; } }

async function rpcBatch(calls) {
  try {
    const r = await fetch(L.RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls),
    });
    const a = await r.json();
    return Array.isArray(a) ? a : [];
  } catch (_) { return []; }
}

async function buildInsiders(token) {
  token = L.lc(token);

  // 1) full-ish transfer history, oldest first (captures launch distribution)
  let xfers = [];
  let partial = false;
  for (let p = 1; p <= 4; p++) {
    let r = [];
    try { r = await L.esCall({ module: 'account', action: 'tokentx', contractaddress: token, page: String(p), offset: '1000', sort: 'asc' }); }
    catch (e) { partial = true; break; }
    xfers = xfers.concat(r);
    if (r.length < 1000) break;
    if (p === 4) partial = true;
  }
  if (!xfers.length) {
    const e = new Error('No token transfers found — is this a token contract address?');
    e.code = 'NOTOKEN'; throw e;
  }

  // 2) deployer
  let deployer = null;
  try {
    const cc = await L.esCall({ module: 'contract', action: 'getcontractcreation', contractaddresses: token });
    if (cc && cc[0] && cc[0].contractCreator) deployer = L.lc(cc[0].contractCreator);
  } catch (_) { /* best effort */ }

  // 3) identify pool/AMM: bidirectional, high-degree contracts
  const ins = {}, outs = {};
  for (const t of xfers) { const f = L.lc(t.from), to = L.lc(t.to); outs[f] = (outs[f] || 0) + 1; ins[to] = (ins[to] || 0) + 1; }
  let cand = [...new Set([...Object.keys(ins), ...Object.keys(outs)])]
    .filter((a) => (ins[a] || 0) > 3 && (outs[a] || 0) > 3 && a !== ZERO);
  cand.sort((a, b) => ((ins[b] || 0) + (outs[b] || 0)) - ((ins[a] || 0) + (outs[a] || 0)));
  const top = cand.slice(0, 6);
  const typed = await L.typeAddresses(top);
  const pools = new Set(top.filter((a) => typed[a] === 'contract'));
  const poolsAll = new Set([...pools, ZERO]);

  // 4) per-wallet aggregates
  const agg = {};
  const A = (w) => (agg[w] || (agg[w] = { inPool: 0, outPool: 0, inFree: 0, outFree: 0, firstFrom: null, firstTs: null }));
  for (const t of xfers) {
    const f = L.lc(t.from), to = L.lc(t.to), ts = Number(t.timeStamp) || 0;
    if (!poolsAll.has(to)) { const a = A(to); if (pools.has(f)) a.inPool++; else a.inFree++; if (a.firstTs === null) { a.firstFrom = f; a.firstTs = ts; } }
    if (!poolsAll.has(f)) { const a = A(f); if (pools.has(to)) a.outPool++; else a.outFree++; }
  }
  let wallets = Object.keys(agg).filter((w) => !poolsAll.has(w) && w !== deployer);

  // 5) supply + current balances
  const supRes = await rpcBatch([{ jsonrpc: '2.0', id: 0, method: 'eth_call', params: [{ to: token, data: '0x18160ddd' }, 'latest'] }]);
  const supply = hexBig(supRes[0] && supRes[0].result);
  const bal = {};
  for (let i = 0; i < wallets.length; i += 100) {
    const chunk = wallets.slice(i, i + 100);
    const res = await rpcBatch(chunk.map((w, j) => ({ jsonrpc: '2.0', id: j, method: 'eth_call', params: [{ to: token, data: '0x70a08231' + '0'.repeat(24) + w.slice(2) }, 'latest'] })));
    for (const c of res) bal[chunk[c.id]] = hexBig(c.result);
  }

  // 6) classify
  const pct = (b) => (supply > 0n ? Number(b * 1000000n / supply) / 10000 : 0);
  const rows = [];
  let buyers = 0;
  for (const w of wallets) {
    const a = agg[w]; const b = bal[w] || 0n;
    const bought = a.inPool > 0, sold = a.outPool > 0, free = a.inFree > 0;
    let cat;
    if (free && !bought) cat = sold ? 'dumper' : (b > 0n ? 'loaded' : 'mover');
    else if (bought) { buyers++; cat = (b > 0n ? 'buyer' : 'exited'); }
    else continue;
    rows.push({ address: w, cat, pct: pct(b), bal: b.toString(), boughtN: a.inPool, soldN: a.outPool, freeN: a.inFree, fromDeployer: a.firstFrom === deployer });
  }

  const side = rows.filter((r) => r.cat === 'dumper' || r.cat === 'loaded' || r.cat === 'mover');
  const loaded = side.filter((r) => r.cat === 'loaded');
  const dumpers = side.filter((r) => r.cat === 'dumper');
  const byPct = (arr) => arr.slice().sort((x, y) => y.pct - x.pct);
  const sidePct = side.reduce((s, r) => s + r.pct, 0);
  const loadedPct = loaded.reduce((s, r) => s + r.pct, 0);

  // risk driven by supply actually held by free-bag insiders (forward dump risk), not harmless historical movers
  let risk = 'low';
  if (loadedPct >= 8) risk = 'high';
  else if (loadedPct >= 2.5) risk = 'medium';
  if (risk === 'low' && dumpers.length >= 10) risk = 'medium';

  return {
    token, deployer, pools: [...pools], supply: supply.toString(),
    risk,
    stats: {
      wallets: wallets.length, buyers,
      side: side.length, sidePct: Math.round(sidePct * 100) / 100,
      loaded: loaded.length, loadedPct: Math.round(loadedPct * 100) / 100,
      dumped: dumpers.length,
      transfers: xfers.length, partial,
    },
    loaded: byPct(loaded).slice(0, 60),
    dumpers: byPct(dumpers).slice(0, 60),
    side: byPct(side).slice(0, 120),
  };
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const address = L.lc((req.query && req.query.address) || '');
  if (!L.isAddress(address)) { res.status(400).json({ error: 'pass ?address=0x… (token contract)' }); return; }
  try {
    const payload = await buildInsiders(address);
    res.status(200).json(payload);
  } catch (err) {
    res.status(err.code === 'NOTOKEN' ? 400 : 502).json({ error: String(err.message || err) });
  }
};

module.exports.buildInsiders = buildInsiders;
