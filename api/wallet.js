'use strict';
/*
 * GET /api/wallet?address=0xWALLET
 * What does this wallet hold? Returns its current token bags + native MON.
 * Uses Etherscan tokentx (which tokens it ever touched) + live balanceOf.
 * Token name/symbol/logo enrichment (nad.fun) happens client-side.
 */
const L = require('./_lib.js');

function hexBig(h) { try { return (h && h !== '0x') ? BigInt(h) : 0n; } catch (_) { return 0n; } }
async function rpcBatch(calls) {
  try {
    const r = await fetch(L.RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls) });
    const a = await r.json();
    return Array.isArray(a) ? a : [a];
  } catch (_) { return []; }
}
function fmtUnits(raw, dec) {
  try { const d = BigInt(dec || 18), v = BigInt(raw); const b = 10n ** d; const w = v / b;
    const f = (v % b).toString().padStart(Number(d), '0').slice(0, 4).replace(/0+$/, '');
    return f ? `${w}.${f}` : w.toString();
  } catch (_) { return '0'; }
}

async function buildWallet(addr) {
  addr = L.lc(addr);
  // tokens this wallet has touched
  let xfers = [];
  for (let p = 1; p <= 3; p++) {
    let r = [];
    try { r = await L.esCall({ module: 'account', action: 'tokentx', address: addr, page: String(p), offset: '1000', sort: 'desc' }); }
    catch (e) { break; }
    xfers = xfers.concat(r);
    if (r.length < 1000) break;
  }
  const meta = {};
  for (const t of xfers) {
    const ca = L.lc(t.contractAddress); if (!ca) continue;
    if (!meta[ca]) meta[ca] = { token: ca, symbol: t.tokenSymbol || '', name: t.tokenName || '', decimals: t.tokenDecimal || '18' };
  }
  const tokens = Object.keys(meta);
  // native MON + balances
  const calls = [{ jsonrpc: '2.0', id: 'native', method: 'eth_getBalance', params: [addr, 'latest'] }]
    .concat(tokens.map((ca, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: ca, data: '0x70a08231' + '0'.repeat(24) + addr.slice(2) }, 'latest'] })));
  const bals = {};
  for (let i = 0; i < calls.length; i += 80) {
    const res = await rpcBatch(calls.slice(i, i + 80));
    for (const c of res) bals[c.id] = c.result;
  }
  const native = fmtUnits(hexBig(bals.native).toString(), 18);
  const holdings = tokens
    .map((ca, i) => ({ ...meta[ca], balanceRaw: hexBig(bals[i]).toString(), amount: fmtUnits(hexBig(bals[i]).toString(), meta[ca].decimals) }))
    .filter((h) => { try { return BigInt(h.balanceRaw) > 0n; } catch (_) { return false; } });

  return { address: addr, native, count: holdings.length, holdings };
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (require('./_guard.js').blocked(req, res)) return;
  const address = L.lc((req.query && req.query.address) || '');
  if (!L.isAddress(address)) { res.status(400).json({ error: 'pass ?address=0x…' }); return; }
  try { res.status(200).json(await buildWallet(address)); }
  catch (err) { res.status(502).json({ error: String(err.message || err) }); }
};
