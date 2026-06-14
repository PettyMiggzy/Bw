#!/usr/bin/env node
'use strict';
/*
 * poster.js — auto-tweets $CHRONIC events from your @account.
 *   - big burns (>= POST_BURN_THRESHOLD)
 *   - new weekly winners (when a season settles)
 *   - pool milestones (every POOL_STEP)
 *
 * Runs on a schedule (see .github/workflows/poster.yml). First run just sets a
 * baseline (posts nothing) so it never dumps history. Use --dry to print only.
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET   (post auth)
 *   CHRONIC_DECIMALS=6
 *   POST_BURN_THRESHOLD=500000     (whole $CHRONIC)
 *   POOL_STEP=500000               (announce each time the pool crosses this)
 */
const DRY = process.argv.includes('--dry');
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEC = parseInt(process.env.CHRONIC_DECIMALS || '6', 10);
const BURN_THRESHOLD = parseInt(process.env.POST_BURN_THRESHOLD || '500000', 10);
const POOL_STEP = parseInt(process.env.POOL_STEP || '500000', 10);
const SITE = 'https://www.burnchronic.xyz';

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
    body: JSON.stringify({ key: 'main', value, updated_at: new Date().toISOString() }),
  });
}

function burnTweet(w) {
  return `🔥 someone just torched ${fmt(w)} $CHRONIC — gone forever, straight off the supply. 💀\n\nburn it don't hoard it 👇 ${SITE}/burn`;
}
function poolTweet(poolWhole) {
  return `🏆 the $CHRONIC GROW pool just crossed ${fmt(poolWhole)} $CHRONIC.\ntop 3 growers split it — go grow 👇 ${SITE}/grow`;
}
function winnerTweet(id, winners) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = winners.slice(0, 3).map((x, i) => `${medals[i]} ${short(x.wallet)} — ${fmt(whole(x.amount_base))}`);
  return `SEASON ${id} OVER 🌱 top growers split the pot:\n${lines.join('\n')}\n\nnew season is LIVE → ${SITE}/grow`;
}

async function getClient() {
  const { TwitterApi } = require('twitter-api-v2');
  const need = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
  for (const k of need) if (!process.env[k]) die(`${k} required to post (or run with --dry)`);
  return new TwitterApi({
    appKey: process.env.X_API_KEY, appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET,
  });
}

(async () => {
  const rows = await sbGet(`grow_bot_state?key=eq.main&select=value`);
  let st = rows.length ? rows[0].value : null;
  const season = (() => null); // placeholder
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
  if (burns.length) posts.push(burnTweet(whole(burns[0].burn_base)));
  st.burnCursor = new Date().toISOString();

  // 2) newly settled season winners
  const seasons = await sbGet(`grow_seasons?settled=eq.true&id=gt.${st.lastSeason || 0}&order=id.asc&limit=1&select=id,winners`);
  if (seasons.length) {
    if (Array.isArray(seasons[0].winners) && seasons[0].winners.length) posts.push(winnerTweet(seasons[0].id, seasons[0].winners));
    st.lastSeason = seasons[0].id;
  }

  // 3) pool milestone crossed
  const milestone = Math.floor(poolNow / POOL_STEP) * POOL_STEP;
  if (milestone > 0 && milestone > (st.poolMilestone || 0)) { posts.push(poolTweet(milestone)); st.poolMilestone = milestone; }

  if (!posts.length) { await saveState(st); console.log('• nothing to post.'); return; }

  if (DRY) {
    console.log(`— DRY RUN: ${posts.length} tweet(s) —`);
    posts.forEach((t, i) => console.log(`\n[${i + 1}]\n${t}`));
    console.log('\n• --dry: nothing posted, state NOT advanced.');
    return;
  }

  const client = await getClient();
  for (let i = 0; i < posts.length; i++) {
    try { const r = await client.v2.tweet(posts[i]); console.log(`✓ posted ${r.data && r.data.id}`); }
    catch (e) { console.error('✗ tweet failed:', (e && e.message) || e); }
    if (i < posts.length - 1) await new Promise((r) => setTimeout(r, 3000));
  }
  await saveState(st);
  console.log('✓ done.');
})().catch((e) => die(e.stack || e.message || String(e)));
