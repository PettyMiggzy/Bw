#!/usr/bin/env node
'use strict';
/*
 * tg-burns.js — announce $CHRONIC burns in Telegram.
 *
 *   1) BIG BURNS: every poll it reads the mint's total supply. When the supply
 *      has dropped by >= ANNOUNCE_MIN since the last announcement, it posts
 *      "🔥 X $CHRONIC just burned". Watching SUPPLY (not one wallet) means it
 *      catches every burn — the buy-&-burn engine, the game (60% per seed),
 *      and anyone who sends $CHRONIC to the burn wallet. Sub-threshold burns
 *      accumulate until they cross the line, so nothing is missed.
 *   2) BURN REPORT: every STATUS_HOURS it posts total burned + current supply.
 *
 * Long-running — host on Railway. The Dockerfile/handoff runs it when APP is set:
 *     Service var:  APP = tg-burns.js
 *
 * Env:
 *   TG_BOT_TOKEN   (required) from @BotFather
 *   TG_CHAT_ID     (required) channel/group id or @handle; the bot must be an
 *                  admin/member that can post there
 *   SOLANA_RPC     your Alchemy RPC
 *   CHRONIC_MINT   (default = live mint)
 *   INIT_SUPPLY    (default 1000000000) the original supply, for "% burned"
 *   ANNOUNCE_MIN   (default 1000000) only announce burns of >= this many tokens
 *   STATUS_HOURS   (default 3) burn-report cadence
 *   POLL_MIN       (default 5) how often to check supply
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

function die(m) { console.error('✗ ' + m); process.exit(1); }
if (!TG_TOKEN || !TG_CHAT) die('TG_BOT_TOKEN + TG_CHAT_ID required');

const fmt = (n) => { n = Math.floor(Number(n) || 0); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(n); };
const pct = (burned) => (burned / INIT_SUPPLY * 100).toFixed(2);

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function supply() { const s = await rpc('getTokenSupply', [MINT]); return Number(s.value.uiAmount); }
async function tg(text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) console.error('tg', r.status, (await r.text()).slice(0, 160));
  } catch (e) { console.error('tg err', e.message); }
}

let lastAnnounced = null;   // supply at the last burn announcement (or baseline)
let lastStatus = 0;

async function tick() {
  let cur; try { cur = await supply(); } catch (e) { console.error('supply', e.message); return; }
  if (lastAnnounced === null) { lastAnnounced = cur; lastStatus = Date.now(); console.log('baseline supply', cur); return; }

  const burned = lastAnnounced - cur;           // cumulative since last announcement
  if (burned >= ANNOUNCE_MIN) {
    const total = INIT_SUPPLY - cur;
    await tg(`🔥 <b>${fmt(burned)} $CHRONIC just burned</b>\n\ngone forever — supply only goes down. 💀\n\ntotal burned: <b>${fmt(total)}</b> (${pct(total)}%)\nsupply now: ${fmt(cur)}\n\n${SITE}`);
    console.log('announced burn', burned);
    lastAnnounced = cur;                          // reset baseline only after announcing
  }

  if (Date.now() - lastStatus >= STATUS_MS) {
    const total = INIT_SUPPLY - cur;
    await tg(`📊 <b>$CHRONIC BURN REPORT</b>\n\n🔥 total burned: <b>${fmt(total)}</b> (${pct(total)}%)\n🪙 circulating supply: <b>${fmt(cur)}</b>\n\nevery trade fee buys &amp; burns. supply only goes down. 🌿\n${SITE}`);
    console.log('status posted');
    lastStatus = Date.now();
  }
}

console.log(`$CHRONIC TG burn announcer — announce >= ${fmt(ANNOUNCE_MIN)}, report every ${STATUS_MS / 3600000}h, poll ${POLL_MS / 60000}m`);
tick();
setInterval(tick, POLL_MS);
