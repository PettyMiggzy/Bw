export const config = { runtime: 'edge' };
import { ImageResponse } from '@vercel/og';

/*
 * /api/og — dynamic share-card images (1200x630) for Twitter/X.
 *   ?type=burn&amount=250000   -> "TORCHED 250K $CHRONIC"
 *   ?type=rank&rank=3&xp=12000 -> "RANK #3 · 12K XP"
 *   ?type=pool[&pool=]         -> live weekly pool (fetched if omitted)
 */
function fmt(n) { n = Math.floor(Number(n) || 0); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'; return String(n); }
const node = (type, style, children) => ({ type, props: { style, children } });

export default async function handler(req) {
  try {
    const p = new URL(req.url).searchParams;
    const type = p.get('type') || 'burn';
    let kicker, big, sub, accent, bigColor;

    if (type === 'rank') {
      accent = '#52ff8f'; bigColor = '#52ff8f';
      kicker = '$CHRONIC GROW';
      big = 'RANK #' + (parseInt(p.get('rank'), 10) || '?');
      sub = fmt(p.get('xp')) + ' XP · climbing the leaderboard';
    } else if (type === 'pool' || type === 'grow') {
      accent = '#a85cff'; bigColor = '#f5cf57';
      let pool = p.get('pool');
      if (pool == null) {
        try { const r = await fetch('https://www.burnchronic.xyz/api/grow?action=leaderboard'); const j = await r.json(); pool = j.poolWhole; } catch (_) { pool = 0; }
      }
      kicker = '$CHRONIC GROW · WEEKLY POOL';
      big = fmt(pool) + ' $CHRONIC';
      sub = 'top 3 growers split it · resets weekly';
    } else {
      accent = '#ff6a2b'; bigColor = '#f5cf57';
      kicker = 'TORCHED FOREVER';
      big = fmt(p.get('amount')) + ' $CHRONIC';
      sub = 'gone forever · supply only goes down';
    }

    const el = node('div', {
      width: '1200px', height: '630px', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '90px',
      backgroundColor: '#070a07', color: '#e9ffe9',
      backgroundImage: 'radial-gradient(900px 520px at 50% -12%, rgba(255,106,43,.22), transparent), radial-gradient(700px 500px at 100% 120%, rgba(82,255,143,.12), transparent)',
    }, [
      node('div', { fontSize: '42px', letterSpacing: '12px', color: accent, fontWeight: 700, display: 'flex' }, kicker),
      node('div', { fontSize: '132px', fontWeight: 800, color: bigColor, lineHeight: '1', marginTop: '20px', display: 'flex' }, big),
      node('div', { fontSize: '40px', color: '#84a78d', marginTop: '26px', display: 'flex' }, sub),
      node('div', { display: 'flex', marginTop: '74px', fontSize: '33px' }, [
        node('div', { color: '#52ff8f', fontWeight: 700, display: 'flex' }, '$CHRONIC'),
        node('div', { color: '#84a78d', marginLeft: '16px', display: 'flex' }, '· burnchronic.xyz · burn it don’t hoard it'),
      ]),
    ]);

    return new ImageResponse(el, { width: 1200, height: 630, headers: { 'cache-control': 'public, max-age=300' } });
  } catch (e) {
    return new Response('og error: ' + (e && e.message), { status: 500 });
  }
}
