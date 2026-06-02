'use strict';
/*
 * GET /api/funding?address=0x<wallet>&depth=6
 *
 * Funding lineage: trace a wallet back to its first funder, recursively, until
 * we hit a contract (exchange / bridge / router — a terminal source), run out
 * of inbound funding, hit a cycle, or reach the depth cap.
 *
 * Each hop = the earliest inbound native MON transfer (normal or internal).
 */

const L = require('./_lib.js');

// Earliest inbound native value transfer into `addr` (normal txns + internals).
async function firstFunder(addr) {
  const common = { address: addr, page: '1', offset: '100', sort: 'asc' };
  const [txs, internals] = await Promise.all([
    L.esCall({ module: 'account', action: 'txlist', ...common }),
    L.esCall({ module: 'account', action: 'txlistinternal', ...common }),
  ]);

  let best = null;
  const consider = (from, value, hash, block, ts, internal) => {
    if (L.lc(from) === addr) return;
    let v; try { v = BigInt(value || '0'); } catch (_) { return; }
    if (v <= 0n) return;
    const t = Number(ts) || 0;
    if (!best || t < best.ts) best = { from: L.lc(from), value: v.toString(), valueFmt: L.fmtUnits(v.toString(), L.NATIVE_DECIMALS), txHash: hash, block: Number(block) || null, ts: t, internal };
  };
  for (const t of txs) if (L.lc(t.to) === addr && t.isError !== '1') consider(t.from, t.value, t.hash, t.blockNumber, t.timeStamp, false);
  for (const t of internals) if (L.lc(t.to) === addr && t.isError !== '1') consider(t.from, t.value, t.hash, t.blockNumber, t.timeStamp, true);
  return best;
}

async function lineage(start, maxDepth) {
  start = L.lc(start);
  const chain = [];
  const visited = new Set([start]);
  let current = start;

  for (let d = 0; d < maxDepth; d++) {
    const f = await firstFunder(current);
    if (!f) { chain.push({ address: current, fundedBy: null, terminal: 'no inbound funding found' }); break; }

    const typed = await L.typeAddresses([f.from]);
    const funderType = typed[f.from] || 'wallet';
    chain.push({
      address: current,
      fundedBy: f.from,
      funderType,
      value: f.value, valueFmt: f.valueFmt,
      txHash: f.txHash, block: f.block, ts: f.ts, internal: f.internal,
    });

    if (funderType === 'contract') { chain.push({ address: f.from, type: 'contract', terminal: 'contract source (likely CEX / bridge / router)' }); break; }
    if (visited.has(f.from)) { chain.push({ address: f.from, terminal: 'cycle' }); break; }
    if (d === maxDepth - 1) { chain.push({ address: f.from, terminal: `depth cap (${maxDepth})` }); break; }
    visited.add(f.from);
    current = f.from;
  }
  return { start, hops: chain.length, lineage: chain };
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const address = L.lc((req.query && req.query.address) || '');
  if (!L.isAddress(address)) { res.status(400).json({ error: 'pass ?address=0x… (wallet)' }); return; }
  const depth = Math.min(Math.max(parseInt((req.query && req.query.depth) || '6', 10) || 6, 1), 12);

  try {
    res.status(200).json(await lineage(address, depth));
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};

module.exports.lineage = lineage;
