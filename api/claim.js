// Proxies the claim page -> the XP bot's signing endpoint (server-to-server, avoids HTTPS->HTTP mixed-content block).
// Set BOT_CLAIM_URL in Vercel env to the bot endpoint (prefer https). No default — keep infra out of git.
const OK_ORIGINS = ['burnchronic.xyz', 'localhost', 'vercel.app'];
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const o = (req.headers && (req.headers.origin || req.headers.referer)) || '';
  if (o && !OK_ORIGINS.some((d) => o.includes(d))) { res.status(403).json({ error: 'forbidden origin' }); return; }
  const wallet = (req.query.wallet || '').toString().trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    res.status(400).json({ error: 'bad wallet' });
    return;
  }
  const base = process.env.BOT_CLAIM_URL;
  if (!base) { res.status(500).json({ error: 'claim backend not configured' }); return; }
  try {
    const r = await fetch(base + '?wallet=' + encodeURIComponent(wallet), { cache: 'no-store' });
    const text = await r.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(r.status).send(text);
  } catch (e) {
    res.status(502).json({ error: 'bot unreachable', detail: String(e && e.message || e) });
  }
}
