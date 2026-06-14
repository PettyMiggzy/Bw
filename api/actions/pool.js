'use strict';
/*
 * /api/actions/pool — Blink showing the live $CHRONIC GROW weekly pool, with
 * burn-to-climb buttons (delegating to /api/actions/burn) + a play link.
 * GET only.
 */
const G = require('../_grow.js');

const ICON = 'https://www.burnchronic.xyz/assets/og-chronic.jpg';
const SITE = 'https://www.burnchronic.xyz';

function fmt(n) { n = Math.floor(n); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'; return '' + n; }
function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Action-Version, X-Blockchain-Ids');
  res.setHeader('Access-Control-Expose-Headers', 'X-Action-Version, X-Blockchain-Ids');
  res.setHeader('X-Action-Version', '2.4');
  res.setHeader('X-Blockchain-Ids', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  res.setHeader('Content-Type', 'application/json');
}

module.exports = async (req, res) => {
  setHeaders(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ message: 'GET only' }); return; }

  let poolWhole = 0, endsTxt = 'soon';
  try {
    const s = await G.sbRpc('grow_current_season', {});
    const season = Array.isArray(s) ? s[0] : s;
    poolWhole = Math.floor(Number(season.pool_base) / Math.pow(10, G.DECIMALS));
    const ms = Math.max(0, new Date(season.ends_at).getTime() - Date.now());
    const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
    endsTxt = `${d}d ${h}h`;
  } catch (_) { /* show defaults if DB is unreachable */ }

  res.status(200).json({
    type: 'action',
    icon: ICON,
    title: '🏆 $CHRONIC GROW — Weekly Pool',
    description: `${fmt(poolWhole)} $CHRONIC in the pot · ends in ${endsTxt}. Top 3 growers split it by XP. Burn to climb the board. 💀`,
    label: 'Burn to climb',
    links: { actions: [
      { type: 'transaction', label: 'Burn 50K 🔥', href: '/api/actions/burn?amount=50000' },
      { type: 'transaction', label: 'Burn 250K 🔥', href: '/api/actions/burn?amount=250000' },
      { type: 'transaction', label: 'Burn 1M 🔥', href: '/api/actions/burn?amount=1000000' },
      { type: 'external-link', label: '🌱 Play $CHRONIC GROW', href: `${SITE}/grow` },
    ] },
  });
};
