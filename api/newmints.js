'use strict';
/*
 * GET /api/newmints  — the live new-mint firehose.
 *
 * Returns the most recent mints captured by tools/newmints-listener.js into the
 * `grow_newmints` table. Brand-new tokens won't be on Dexscreener for a minute
 * or two, so the terminal seeds its "New" board straight from this metadata
 * (name/symbol/image/creator/sol) and upgrades each row with live price/mcap as
 * Dexscreener indexes it.
 *
 * Query: ?limit=50 (max 100). No auth — read-only, anon-safe (RLS select=true).
 */
const { sbEnabled, sbSelect } = require('./_grow.js');

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (!sbEnabled()) return res.status(200).json({ mints: [], live: false });

  let limit = parseInt((req.query && req.query.limit) || '50', 10);
  if (!(limit > 0)) limit = 50;
  if (limit > 100) limit = 100;

  try {
    const rows = await sbSelect(
      `grow_newmints?select=mint,name,symbol,image,uri,creator,sol,created_at` +
      `&order=created_at.desc&limit=${limit}`
    );
    const mints = (rows || []).map((r) => ({
      mint: r.mint, name: r.name, symbol: r.symbol, image: r.image,
      uri: r.uri, creator: r.creator, sol: Number(r.sol) || 0,
      createdAt: r.created_at ? Date.parse(r.created_at) : 0,
    }));
    return res.status(200).json({ mints, live: true });
  } catch (e) {
    return res.status(200).json({ mints: [], live: false });
  }
};
