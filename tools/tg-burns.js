#!/usr/bin/env node
'use strict';
/*
 * tg-burns.js — announce $CHRONIC burns in Telegram + answer /burns on demand.
 *
 *   1) BIG BURNS: reads the mint's total supply; when it drops by >= ANNOUNCE_MIN
 *      since the last announcement, posts "🔥 X $CHRONIC just burned". Watching
 *      SUPPLY catches every burn (engine, game, community sends). Sub-threshold
 *      burns accumulate until they cross the line.
 *   2) BURN REPORT: posts total burned + current supply every STATUS_HOURS.
 *   3) COMMANDS: anyone can type /burns (or /burn /stats /supply) in the chat
 *      and the bot replies with the live total. (Long-polls getUpdates — only
 *      run ONE bot per token doing this; the paperhands/grad bots only send.)
 *
 * Env: TG_BOT_TOKEN, TG_CHAT_ID, SOLANA_RPC, CHRONIC_MINT, CHRONIC_DECIMALS,
 *      INIT_SUPPLY (1000000000), ANNOUNCE_MIN (1000000), STATUS_HOURS (3),
 *      POLL_MIN (5)
 */
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MINT = process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump';
const INIT_SUPPLY = parseFloat(process.env.INIT_SUPPLY || '1000000000');
const ANNOUNCE_MIN = parseFloat(process.env.ANNOUNCE_MIN || '1000000');
const STATUS_MS = Math.max(0.25, parseFloat(process.env.STATUS_HOURS || '3')) * 3600 * 1000;
const POLL_MS = Math.max(1, parseFloat(process.env.POLL_MIN || '5')) * 60 * 1000;
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;
const SITE = 'https://www.burnchronic.xyz';

function die(m) { console.error('x ' + m); process.exit(1); }
if (!TG_TOKEN || !TG_CHAT) die('TG_BOT_TOKEN + TG_CHAT_ID required');
const API = 'https://api.telegram.org/bot' + TG_TOKEN;

const fmt = (n) => { n = Math.floor(Number(n) || 0); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(n); };
const pct = (burned) => (burned / INIT_SUPPLY * 100).toFixed(2);

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function supply() { const s = await rpc('getTokenSupply', [MINT]); return Number(s.value.uiAmount); }
async function tg(text, chat) {
  try {
    const r = await fetch(API + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat || TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }) });
    if (!r.ok) console.error('tg', r.status, (await r.text()).slice(0, 160));
  } catch (e) { console.error('tg err', e.message); }
}
async function report(chat) {
  let cur; try { cur = await supply(); } catch (e) { return; }
  const total = INIT_SUPPLY - cur;
  await tg('📊 <b>$CHRONIC BURN REPORT</b>\n\n🔥 total burned: <b>' + fmt(total) + '</b> (' + pct(total) + '%)\n🪙 circulating supply: <b>' + fmt(cur) + '</b>\n\nevery trade fee buys &amp; burns. supply only goes down. 🌿\n' + SITE, chat);
}

let lastAnnounced = null, lastStatus = 0;
async function tick() {
  let cur; try { cur = await supply(); } catch (e) { console.error('supply', e.message); return; }
  if (lastAnnounced === null) { lastAnnounced = cur; lastStatus = Date.now(); console.log('baseline supply', cur); return; }
  const burned = lastAnnounced - cur;
  if (burned >= ANNOUNCE_MIN) {
    const total = INIT_SUPPLY - cur;
    await tg('🔥 <b>' + fmt(burned) + ' $CHRONIC just burned</b>\n\ngone forever — supply only goes down. 💀\n\ntotal burned: <b>' + fmt(total) + '</b> (' + pct(total) + '%)\nsupply now: ' + fmt(cur) + '\n\n' + SITE);
    console.log('announced burn', burned); lastAnnounced = cur;
  }
  if (Date.now() - lastStatus >= STATUS_MS) { await report(); lastStatus = Date.now(); console.log('status posted'); }
}

// ---- command listener (/burns) ----
const CMDS = ['/burns', '/burn', '/stats', '/supply'];
let offset = 0;
async function initOffset() {
  try { const j = await (await fetch(API + '/getUpdates?offset=-1')).json(); if (j.ok && j.result.length) offset = j.result[j.result.length - 1].update_id + 1; } catch (_) {}
}
async function pollCommands() {
  try {
    const j = await (await fetch(API + '/getUpdates?timeout=25&offset=' + offset)).json();
    if (j.ok) for (const u of j.result) {
      offset = u.update_id + 1;
      const msg = u.message || u.channel_post; if (!msg || !msg.text) continue;
      const cmd = msg.text.trim().toLowerCase().split(/\s+/)[0].split('@')[0];
      if (CMDS.includes(cmd)) { console.log('cmd', cmd, 'from', msg.chat.id); report(msg.chat.id); }
    }
  } catch (e) { console.error('poll', e.message); }
  setTimeout(pollCommands, 800);
}

console.log('$CHRONIC TG burn announcer + /burns command — announce >= ' + fmt(ANNOUNCE_MIN) + ', report every ' + (STATUS_MS / 3600000) + 'h');
tick();
setInterval(tick, POLL_MS);
initOffset().then(pollCommands);
