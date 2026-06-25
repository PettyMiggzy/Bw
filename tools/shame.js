#!/usr/bin/env node
'use strict';
/*
 * shame.js — $CHRONIC HALL OF SHAME. Reads the jeets the paperhands bot caught
 * (jeets.json) and ranks the worst, with a roast for each. Prints to the screen,
 * or --post drops the leaderboard straight into Telegram.
 *
 *   node shame.js                 print the all-time hall of shame
 *   node shame.js --today         only the last 24h
 *   node shame.js --top 10        show more entries (default 5)
 *   node shame.js --post          also post it to Telegram (needs TG env)
 *
 * Env: JEETS_FILE (default /root/chronic-burns/jeets.json), TOKEN_SYMBOL,
 *      TG_BOT_TOKEN + TG_CHAT_ID (only needed for --post)
 */
const fs = require('fs');

const POST = process.argv.includes('--post');
const TODAY = process.argv.includes('--today');
const ti = process.argv.indexOf('--top');
const TOP = ti >= 0 ? Math.max(1, parseInt(process.argv[ti + 1] || '5', 10)) : 5;
const JEETS = process.env.JEETS_FILE || '/root/chronic-burns/jeets.json';
const SYM = process.env.TOKEN_SYMBOL || 'CHRONIC';
const SITE = 'https://www.burnchronic.xyz';
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const ROASTS = [
  'bought high, sold low — a true visionary 🤡',
  'speedran poverty 💀',
  'sold the exact bottom. surgical 📉',
  'held it all the way DOWN then sold. elite 🏆🤡',
  'the skeleton bought this bag and didnt even blink 🦴',
  'round trip to nowhere ✈️💀',
  'donated to the diamond hands. thank you for your service 🫡',
  'ngmi, professionally 📉',
  'paper hands, paper bag, paper future 🧻',
  'enjoy rebuying higher 🌿',
];
// approx SOL lost/made from the realized % and the sell size
function solPnl(sol, pct) { return (Number(sol) || 0) * (pct / 100) / (1 + pct / 100); }

function load() { try { return JSON.parse(fs.readFileSync(JEETS, 'utf8')) || []; } catch (_) { return []; } }

function build() {
  let arr = load();
  if (TODAY) { const cut = Date.now() - 86400000; arr = arr.filter((e) => (e.t || 0) >= cut); }
  const scope = TODAY ? 'last 24h' : 'all-time';

  if (!arr.length) {
    return '🧻💀 $' + SYM + ' HALL OF SHAME 💀🧻\n(' + scope + ')\n\nempty. nobody folded. respect to the diamond hands. 🦴\n\nsupply only goes down. burn it, dont hoard it 🔥';
  }

  const losers = arr.filter((e) => e.pct != null && e.pct < 0).sort((a, b) => a.pct - b.pct);
  const biggest = arr.slice().sort((a, b) => (b.sol || 0) - (a.sol || 0))[0];
  const medals = ['👑', '🥈', '🥉', '🤡', '🧻', '💀', '📉', '🪦', '🚪', '😭'];

  let out = '🧻💀 $' + SYM + ' HALL OF SHAME 💀🧻\n(' + scope + ')\n';

  if (losers.length) {
    out += '\n— biggest losses —\n';
    losers.slice(0, TOP).forEach((e, i) => {
      const crown = i === 0 ? ' KING JEET' : '';
      const lost = solPnl(e.sol, e.pct);
      out += '\n' + (medals[i] || '•') + crown + ' ' + e.who + ' — ' + e.pct.toFixed(0) + '% (~' + lost.toFixed(3) + ' SOL)\n   "' + pick(ROASTS) + '"';
    });
  } else {
    out += '\n(no PnL yet — the bot needs to watch these wallets buy first. ranking by dump size for now.)\n';
    arr.slice().sort((a, b) => (b.sol || 0) - (a.sol || 0)).slice(0, TOP).forEach((e, i) => {
      out += '\n' + (medals[i] || '•') + ' ' + e.who + ' — dumped ' + (Number(e.sol) || 0).toFixed(3) + ' SOL\n   "' + pick(ROASTS) + '"';
    });
  }

  if (biggest) out += '\n\n💰 BIGGEST BAG FUMBLED: ' + biggest.who + ' dumped ' + (Number(biggest.sol) || 0).toFixed(3) + ' SOL\n   "' + pick(ROASTS) + '"';
  out += '\n\nsupply only goes down. burn it, dont hoard it 🔥\n' + SITE;
  return out;
}

async function tgPost(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.error('✗ --post needs TG_BOT_TOKEN + TG_CHAT_ID'); return; }
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
    console.log(r.ok ? '✓ posted to Telegram' : '✗ TG ' + r.status + ' ' + (await r.text()).slice(0, 160));
  } catch (e) { console.error('✗ tg err', e.message); }
}

(async () => {
  const text = build();
  console.log('\n' + text + '\n');
  if (POST) await tgPost(text);
})();
