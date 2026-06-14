'use strict';
/*
 * /api/flex (also /flex) — share-landing page with DYNAMIC OG tags so Twitter
 * shows a live card; humans get redirected to the real page.
 *   /flex?type=burn&amount=250000
 *   /flex?type=rank&rank=3&xp=12000
 *   /flex?type=pool&pool=1200000
 */
module.exports = (req, res) => {
  const q = req.query || {};
  const type = ['burn', 'rank', 'pool', 'grow'].includes(q.type) ? q.type : 'burn';
  const num = (v) => { const n = Math.floor(Number(v)); return isFinite(n) && n > 0 ? n : 0; };

  const params = new URLSearchParams(); params.set('type', type);
  ['amount', 'rank', 'xp', 'pool'].forEach((k) => { if (q[k] != null) params.set(k, String(num(q[k]))); });
  const og = 'https://www.burnchronic.xyz/api/og?' + params.toString();

  let title, dest;
  if (type === 'rank') { title = '🏆 Rank #' + num(q.rank) + ' on $CHRONIC GROW'; dest = '/grow'; }
  else if (type === 'pool' || type === 'grow') { title = '$CHRONIC GROW — Weekly Pool'; dest = '/grow'; }
  else { title = '🔥 Torched ' + num(q.amount) + ' $CHRONIC'; dest = '/burn'; }

  const esc = (s) => String(s).replace(/[<>"&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=300');
  res.status(200).send(
    '<!doctype html><html><head><meta charset="utf-8"/>' +
    '<meta property="og:title" content="' + esc(title) + '"/>' +
    '<meta property="og:description" content="burn it don’t hoard it · $CHRONIC on Solana"/>' +
    '<meta property="og:image" content="' + esc(og) + '"/>' +
    '<meta name="twitter:card" content="summary_large_image"/>' +
    '<meta name="twitter:title" content="' + esc(title) + '"/>' +
    '<meta name="twitter:image" content="' + esc(og) + '"/>' +
    '<meta http-equiv="refresh" content="0; url=' + dest + '"/>' +
    '<title>' + esc(title) + '</title></head>' +
    '<body style="background:#070a07;color:#52ff8f;font-family:monospace;padding:40px">redirecting to ' +
    '<a style="color:#52ff8f" href="' + dest + '">' + dest + '</a>…</body></html>');
};
