#!/usr/bin/env node
'use strict';
/*
 * ig-poster.js — auto-posts $CHRONIC events to Instagram. Mirror of poster.js
 * (the X auto-poster): same triggers, same Supabase state, same baseline-on-
 * first-run so it never dumps history. Use --dry to print only.
 *   - big burns (>= POST_BURN_THRESHOLD)
 *   - new weekly winners (when a season settles)
 *   - pool milestones (every POOL_STEP)
 *
 * IG differences vs X:
 *   - every IG feed post REQUIRES an image (no text-only). We point the Graph
 *     API at a public asset URL on the site — no upload needed.
 *   - captions can't have clickable links, so they end with "link in bio".
 *   - separate state key ('ig_main') so X and IG advance independently.
 *
 * Publish = 2-step Graph API: create media container -> media_publish.
 * (Images publish immediately; only Reels/video need status polling.)
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   IG_USER_ID        the Instagram *Business/Creator* account id (numeric)
 *   IG_ACCESS_TOKEN   long-lived Page access token with instagram_content_publish
 *   GRAPH_VERSION     optional, default v21.0
 *   IG_IMAGE          optional default post image URL (square/og works best)
 *   CHRONIC_DECIMALS=6
 *   POST_BURN_THRESHOLD=500000   (whole $CHRONIC)
 *   POOL_STEP=500000
 */
const DRY = process.argv.includes('--dry');
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEC = parseInt(process.env.CHRONIC_DECIMALS || '6', 10);
const BURN_THRESHOLD = parseInt(process.env.POST_BURN_THRESHOLD || '500000', 10);
const POOL_STEP = parseInt(process.env.POOL_STEP || '500000', 10);
const SITE = 'https://www.burnchronic.xyz';
const GRAPH = 'https://graph.facebook.com/' + (process.env.GRAPH_VERSION || 'v21.0');
const IG_USER_ID = process.env.IG_USER_ID;
const IG_TOKEN = process.env.IG_ACCESS_TOKEN;
// 1.91:1 OG image is the safest universal aspect ratio IG accepts. Swap per
// event with dedicated square art later via the *_IMG envs.
const DEFAULT_IMG = process.env.IG_IMAGE || SITE + '/assets/og-chronic.jpg';
const BURN_IMG = process.env.IG_IMG_BURN || DEFAULT_IMG;
const POOL_IMG = process.env.IG_IMG_POOL || DEFAULT_IMG;
const WINNER_IMG = process.env.IG_IMG_WINNER || DEFAULT_IMG;
const STATE_KEY = 'ig_main';   // distinct from poster.js ('main')
const TAGS = '\n\n#CHRONIC #Solana #memecoin #burn #weed #420';

function die(m) { console.error('✗ ' + m); process.exit(1); }
if (!SB_URL || !SB_KEY) die('SUPABASE_URL / SUPABASE_SERVICE_KEY required');

const H = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' };
const baseUnit = (whole) => BigInt(Math.round(whole)) * (10n ** BigInt(DEC));
const whole = (b) => Math.floor(Number(b) / Math.pow(10, DEC));
function fmt(n) { n = Math.floor(Number(n) || 0); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'; return String(n); }
const short = (w) => (w ? w.slice(0, 4) + '…' + w.slice(-4) : '');

async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H }); if (!r.ok) die(`GET ${path}: ${r.status}`); return r.json(); }
async function sbRpc(fn, args) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args || {}) }); const t = await r.text(); if (!r.ok) die(`RPC ${fn}: ${r.status} ${t}`); return t ? JSON.parse(t) : null; }
async function saveState(value) {
  await fetch(`${SB_URL}/rest/v1/grow_bot_state?on_conflict=key`, {
    method: 'POST', headers: Object.assign({}, H, { prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ key: STATE_KEY, value, updated_at: new Date().toISOString() }),
  });
}

// ── captions (skeleton voice; link is in bio, not clickable in caption) ──
function burnCaption(w) {
  return `🔥 someone just torched ${fmt(w)} $CHRONIC — gone forever, straight off the supply. 💀\n\nsupply only goes down. burn it, don't hoard it.\n👉 link in bio` + TAGS;
}
function poolCaption(poolWhole) {
  return `🏆 the $CHRONIC GROW pool just crossed ${fmt(poolWhole)} $CHRONIC.\n\ntop 3 growers split it. go grow. 🌱\n👉 link in bio` + TAGS;
}
function winnerCaption(id, winners) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = winners.slice(0, 3).map((x, i) => `${medals[i]} ${short(x.wallet)} — ${fmt(whole(x.amount_base))}`);
  return `SEASON ${id} OVER 🌱 top growers split the pot:\n${lines.join('\n')}\n\nnew season is LIVE.\n👉 link in bio` + TAGS;
}

// ── Instagram Graph API: create container then publish ──
async function igPublish(caption, imageUrl) {
  if (!IG_USER_ID || !IG_TOKEN) die('IG_USER_ID and IG_ACCESS_TOKEN required to post (or run with --dry)');
  // 1) create media container
  const cBody = new URLSearchParams({ image_url: imageUrl, caption, access_token: IG_TOKEN });
  const cRes = await fetch(`${GRAPH}/${IG_USER_ID}/media`, { method: 'POST', body: cBody });
  const cJson = await cRes.json();
  if (!cRes.ok || !cJson.id) throw new Error('container failed: ' + JSON.stringify(cJson.error || cJson));
  // 2) publish the container
  const pBody = new URLSearchParams({ creation_id: cJson.id, access_token: IG_TOKEN });
  const pRes = await fetch(`${GRAPH}/${IG_USER_ID}/media_publish`, { method: 'POST', body: pBody });
  const pJson = await pRes.json();
  if (!pRes.ok || !pJson.id) throw new Error('publish failed: ' + JSON.stringify(pJson.error || pJson));
  return pJson.id;
}

(async () => {
  const rows = await sbGet(`grow_bot_state?key=eq.${STATE_KEY}&select=value`);
  let st = rows.length ? rows[0].value : null;
  const cur = await sbRpc('grow_current_season', {});
  const curSeason = Array.isArray(cur) ? cur[0] : cur;
  const poolNow = whole(curSeason.pool_base);

  // first run: set a baseline, post nothing
  if (!st) {
    const settled = await sbGet(`grow_seasons?settled=eq.true&order=id.desc&limit=1&select=id`);
    st = { burnCursor: new Date().toISOString(), lastSeason: settled.length ? settled[0].id : 0,
      poolMilestone: Math.floor(poolNow / POOL_STEP) * POOL_STEP };
    await saveState(st);
    console.log('• baseline set (first run) — nothing posted.');
    return;
  }

  const posts = [];

  // 1) biggest new burn over threshold
  const thr = baseUnit(BURN_THRESHOLD).toString();
  const burns = await sbGet(`grow_purchases?burn_base=gte.${thr}&created_at=gt.${encodeURIComponent(st.burnCursor)}&order=burn_base.desc&limit=1&select=burn_base,created_at`);
  if (burns.length) posts.push({ caption: burnCaption(whole(burns[0].burn_base)), image: BURN_IMG });
  st.burnCursor = new Date().toISOString();

  // 2) newly settled season winners
  const seasons = await sbGet(`grow_seasons?settled=eq.true&id=gt.${st.lastSeason || 0}&order=id.asc&limit=1&select=id,winners`);
  if (seasons.length) {
    if (Array.isArray(seasons[0].winners) && seasons[0].winners.length) posts.push({ caption: winnerCaption(seasons[0].id, seasons[0].winners), image: WINNER_IMG });
    st.lastSeason = seasons[0].id;
  }

  // 3) pool milestone crossed
  const milestone = Math.floor(poolNow / POOL_STEP) * POOL_STEP;
  if (milestone > 0 && milestone > (st.poolMilestone || 0)) { posts.push({ caption: poolCaption(milestone), image: POOL_IMG }); st.poolMilestone = milestone; }

  if (!posts.length) { await saveState(st); console.log('• nothing to post.'); return; }

  if (DRY) {
    console.log(`— DRY RUN: ${posts.length} IG post(s) —`);
    posts.forEach((p, i) => console.log(`\n[${i + 1}] img=${p.image}\n${p.caption}`));
    console.log('\n• --dry: nothing posted, state NOT advanced.');
    return;
  }

  for (let i = 0; i < posts.length; i++) {
    try { const id = await igPublish(posts[i].caption, posts[i].image); console.log(`✓ posted ${id}`); }
    catch (e) { console.error('✗ IG post failed:', (e && e.message) || e); }
    if (i < posts.length - 1) await new Promise((r) => setTimeout(r, 3000));
  }
  await saveState(st);
  console.log('✓ done.');
})().catch((e) => die(e.stack || e.message || String(e)));
