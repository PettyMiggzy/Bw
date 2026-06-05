// Proxies the claim page -> the XP bot's signing endpoint (server-to-server, avoids HTTPS->HTTP mixed-content block).
// Set BOT_CLAIM_URL in Vercel env to the bot endpoint, e.g. http://206.189.216.202:8645/claim
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const wallet = (req.query.wallet || '').toString().trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    res.status(400).json({ error: 'bad wallet' });
    return;
  }
  const base = process.env.BOT_CLAIM_URL || 'http://206.189.216.202:8645/claim';
  try {
    const r = await fetch(base + '?wallet=' + encodeURIComponent(wallet), { cache: 'no-store' });
    const text = await r.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(r.status).send(text);
  } catch (e) {
    res.status(502).json({ error: 'bot unreachable', detail: String(e && e.message || e) });
  }
}
