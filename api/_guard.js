'use strict';
/*
 * Tiny origin guard for read-only proxy endpoints that spend metered upstream
 * quota (Alchemy / Pinata). Blocks browser requests coming from
 * other websites (they carry an Origin/Referer header) while still allowing our
 * own pages and server-to-server calls (no Origin). Same lenient model as
 * api/solrpc.js. Underscore-prefixed => not routed.
 */
const OK = ['burnchronic.xyz', 'burnchronic.store', 'localhost', 'vercel.app'];

// Returns true (and writes a 403) when the request's Origin/Referer is present
// but not on the allowlist. No Origin (curl / server-to-server) is allowed.
function blocked(req, res) {
  const h = req.headers || {};
  const o = h.origin || h.referer || '';
  if (o && !OK.some((d) => o.includes(d))) {
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'forbidden origin' }));
    return true;
  }
  return false;
}

module.exports = { blocked, OK };
