'use strict';
/*
 * GET /api/graph?address=0x...
 *
 * Returns a single-hop interaction graph for a Monad mainnet address:
 *   { root, nodes:[{address,type,label,firstSeen}], edges:[{from,to,kind,asset,value,...}], stats }
 *
 * Cache-first (Supabase, 24h TTL). On a miss it makes ~4 Etherscan V2 calls
 * (txlist, txlistinternal, tokentx, tokennfttx) + 1 batched eth_getCode, then
 * caps fan-out and drops dust. Click-to-expand on the client calls this again
 * for the clicked node — nothing is ever auto-crawled.
 */

const L = require('./_lib.js');

function addEdge(map, from, to, kind, asset, value, blockNumber, ts, extra) {
  from = L.lc(from); to = L.lc(to);
  if (!from || !to || from === to) return;
  const key = `${from}|${to}|${kind}|${asset}`;
  let e = map.get(key);
  if (!e) {
    e = {
      from, to, kind, asset,
      value: 0n, txCount: 0,
      firstBlock: Infinity, lastBlock: 0,
      firstTs: Infinity, lastTs: 0,
      ...extra,
    };
    map.set(key, e);
  }
  try { e.value += BigInt(value || '0'); } catch (_) { /* non-numeric value */ }
  e.txCount += 1;
  const bn = Number(blockNumber) || 0;
  const t = Number(ts) || 0;
  if (bn && bn < e.firstBlock) e.firstBlock = bn;
  if (bn > e.lastBlock) e.lastBlock = bn;
  if (t && t < e.firstTs) e.firstTs = t;
  if (t > e.lastTs) e.lastTs = t;
}

async function buildGraph(root) {
  root = L.lc(root);
  const common = { address: root, page: '1', offset: String(L.PAGE_OFFSET), sort: 'desc' };

  // Degrade gracefully: a single list timing out (hot address) shouldn't sink the
  // whole graph. Render what we got and report which feeds failed.
  const partial = [];
  const settled = await Promise.allSettled([
    L.esCall({ module: 'account', action: 'txlist', ...common }),
    L.esCall({ module: 'account', action: 'txlistinternal', ...common }),
    L.esCall({ module: 'account', action: 'tokentx', ...common }),
    L.esCall({ module: 'account', action: 'tokennfttx', ...common }),
    L.esCall({ module: 'account', action: 'tokentx', contractaddress: root, page: '1', offset: String(L.PAGE_OFFSET), sort: 'desc' }),
  ]);
  const names = ['txlist', 'internal', 'erc20', 'nft', 'holders'];
  const [txs, internals, erc20, nfts, holders] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    partial.push(names[i]);
    return [];
  });
  if (partial.length === names.length) {
    throw new Error(`all transfer feeds failed (likely rate-limit or timeout): ${settled[0].reason?.message || ''}`);
  }

  const edges = new Map();
  const assetMeta = new Map(); // contractAddress -> {symbol, spam}

  // Native value transfers + contract calls + deployments
  for (const t of txs) {
    const to = t.to || t.contractAddress; // creation txns carry the new contract in contractAddress
    if (!to) continue;
    const isCreation = !t.to && t.contractAddress;
    const value = t.isError === '1' ? '0' : t.value;
    const kind = isCreation ? 'call' : (BigInt(value || '0') > 0n ? 'native' : 'call');
    const asset = kind === 'native' ? 'MON' : (isCreation ? 'deploy' : 'call');
    addEdge(edges, t.from, to, kind, asset, value, t.blockNumber, t.timeStamp,
      isCreation ? { deploy: true } : undefined);
  }

  // Internal value movements (contract-driven sends — funding often hides here)
  for (const t of internals) {
    const value = t.isError === '1' ? '0' : t.value;
    const kind = BigInt(value || '0') > 0n ? 'native' : 'call';
    addEdge(edges, t.from, t.to, kind, kind === 'native' ? 'MON' : 'call',
      value, t.blockNumber, t.timeStamp, { internal: true });
  }

  // ERC-20 transfers
  for (const t of erc20) {
    const ca = L.lc(t.contractAddress);
    const spam = L.SPAMMY.test(t.tokenName || '') || L.SPAMMY.test(t.tokenSymbol || '');
    if (!assetMeta.has(ca)) assetMeta.set(ca, { symbol: t.tokenSymbol || L.short(ca), decimals: t.tokenDecimal, spam });
    addEdge(edges, t.from, t.to, 'erc20', ca, t.value, t.blockNumber, t.timeStamp, { spam });
  }

  // ERC-721 / 1155 transfers
  for (const t of nfts) {
    const ca = L.lc(t.contractAddress);
    const spam = L.SPAMMY.test(t.tokenName || '') || L.SPAMMY.test(t.tokenSymbol || '');
    if (!assetMeta.has(ca)) assetMeta.set(ca, { symbol: t.tokenSymbol || L.short(ca), decimals: '0', spam });
    addEdge(edges, t.from, t.to, 'nft', ca, '1', t.blockNumber, t.timeStamp, { spam });
  }

  // When root itself is a token: pull its transfers so holders link to each other (real mesh)
  for (const t of holders) {
    const ca = L.lc(t.contractAddress);
    const spam = L.SPAMMY.test(t.tokenName || '') || L.SPAMMY.test(t.tokenSymbol || '');
    if (!assetMeta.has(ca)) assetMeta.set(ca, { symbol: t.tokenSymbol || L.short(ca), decimals: t.tokenDecimal, spam });
    addEdge(edges, t.from, t.to, 'erc20', ca, t.value, t.blockNumber, t.timeStamp, { spam });
  }

  // ---- rank counterparties & cap fan-out -------------------------------------
  const partyStat = new Map(); // address -> {lastTs, txCount, hasValue, firstTs}
  for (const e of edges.values()) {
    for (const addr of [e.from, e.to]) {
      if (addr === root) continue;
      let s = partyStat.get(addr);
      if (!s) { s = { lastTs: 0, firstTs: Infinity, txCount: 0, hasValue: false }; partyStat.set(addr, s); }
      s.txCount += e.txCount;
      s.lastTs = Math.max(s.lastTs, e.lastTs);
      s.firstTs = Math.min(s.firstTs, e.firstTs);
      const meaningful = (e.kind === 'native' && e.value > L.DUST_WEI) ||
        (e.kind === 'erc20' && e.value > 0n && !e.spam) || e.kind === 'nft' && !e.spam || e.kind === 'call';
      if (meaningful) s.hasValue = true;
    }
  }

  const ranked = [...partyStat.entries()].sort((a, b) => {
    if (a[1].hasValue !== b[1].hasValue) return a[1].hasValue ? -1 : 1; // real interactions first
    if (b[1].lastTs !== a[1].lastTs) return b[1].lastTs - a[1].lastTs;   // then recency
    return b[1].txCount - a[1].txCount;                                  // then volume
  });
  const kept = new Set(ranked.slice(0, L.DEFAULT_FANOUT).map((x) => x[0]));
  const truncated = ranked.length > L.DEFAULT_FANOUT;

  // ---- materialise nodes -----------------------------------------------------
  const typed = await L.typeAddresses([root, ...kept]);
  const firstSeen = new Map();
  for (const [addr, s] of partyStat) firstSeen.set(addr, s.firstTs === Infinity ? null : s.firstTs);

  const nodes = [root, ...kept].map((addr) => {
    const meta = assetMeta.get(addr);
    return {
      address: addr,
      type: addr === root ? (typed[addr] || 'wallet') : (typed[addr] || 'wallet'),
      label: meta ? meta.symbol : L.short(addr),
      isToken: Boolean(meta),
      spam: meta ? meta.spam : false,
      firstSeen: addr === root ? null : firstSeen.get(addr) || null,
    };
  });

  const outEdges = [...edges.values()]
    .filter((e) => (e.from === root || kept.has(e.from)) && (e.to === root || kept.has(e.to)))
    .map((e) => ({
      from: e.from, to: e.to, kind: e.kind,
      asset: e.kind === 'erc20' || e.kind === 'nft'
        ? (assetMeta.get(e.asset)?.symbol || L.short(e.asset)) : e.asset,
      assetAddress: e.kind === 'erc20' || e.kind === 'nft' ? e.asset : null,
      value: e.value.toString(),
      valueFmt: e.kind === 'native'
        ? L.fmtUnits(e.value.toString(), L.NATIVE_DECIMALS)
        : e.kind === 'erc20'
          ? L.fmtUnits(e.value.toString(), assetMeta.get(e.asset)?.decimals || 18)
          : e.value.toString(),
      txCount: e.txCount,
      firstBlock: e.firstBlock === Infinity ? null : e.firstBlock,
      lastBlock: e.lastBlock || null,
      firstTs: e.firstTs === Infinity ? null : e.firstTs,
      lastTs: e.lastTs || null,
      internal: Boolean(e.internal),
      deploy: Boolean(e.deploy),
      spam: Boolean(e.spam),
    }));

  return {
    root,
    generatedAt: Date.now(),
    nodes,
    edges: outEdges,
    stats: {
      counterparties: partyStat.size,
      kept: kept.size,
      truncated,
      window: L.PAGE_OFFSET,
      partialFeeds: partial,   // feeds that timed out / errored (graph still usable)
      rawCounts: { txlist: txs.length, internal: internals.length, erc20: erc20.length, nft: nfts.length, holders: holders.length },
    },
  };
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const address = L.lc((req.query && req.query.address) || '');
  if (!L.isAddress(address)) {
    res.status(400).json({ error: 'pass ?address=0x… (40 hex chars)' });
    return;
  }

  try {
    const cached = await L.cacheGet(address);
    if (cached) {
      res.setHeader('x-cache', 'HIT');
      res.status(200).json(cached);
      return;
    }
    const payload = await buildGraph(address);
    await L.cacheSet(address, payload);
    res.setHeader('x-cache', 'MISS');
    res.status(200).json(payload);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};

module.exports.buildGraph = buildGraph;
