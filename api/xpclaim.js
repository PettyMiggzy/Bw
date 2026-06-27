'use strict';
/*
 * /api/xpclaim?wallet=0x… — server-side proxy to the XP bot's claim API on the
 * droplet. Why a proxy: the claim page is served over HTTPS, but the bot's API
 * is plain HTTP on an IP:port — the browser blocks that as mixed content. Fetching
 * it server-side here avoids that and keeps the droplet IP out of the client.
 *
 * Returns the bot's JSON verbatim:
 *   { found, xp, pool, entries:[{ token, symbol, decimals, cumulative, claimed,
 *     cooldown, cooldownDays, signature, floorNotMet? }] }
 *
 * Env: XP_API_URL — the bot's base, e.g. http://206.189.216.202:8645
 *      (the bot listens on API_PORT=8645; open that port or front it with a domain)
 */
const XP_API = (process.env.XP_API_URL || 'http://206.189.216.202:8645').replace(/\/$/, '');

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const wallet = (req.query.wallet || '').toString().trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return res.status(400).json({ error: 'bad wallet' });

  try {
    const r = await fetch(`${XP_API}/claim?wallet=${encodeURIComponent(wallet)}`, { signal: AbortSignal.timeout(12000) });
    const text = await r.text();
    res.status(r.status).send(text);
  } catch (e) {
    return res.status(502).json({ error: 'xp api unreachable: ' + ((e && e.message) || e) });
  }
};
