#!/usr/bin/env node
'use strict';
/*
 * paperhands.js — $CHRONIC "Paperhands Patrol". Roasts every sell in Telegram.
 *
 * Subscribes to live $CHRONIC trades via PumpPortal (subscribeTokenTrade), and
 * when someone SELLS, it posts a savage, context-aware roast — bigger dumps get
 * bigger roasts, and losers get cooked harder than profit-takers. It tracks each
 * wallet's buy cost-basis (persisted to disk) so it can call out the seller's
 * realized PnL — "% LOSS (-X SOL)" or "+% and ran". Coverage grows over time as
 * it sees more buys; sellers it never saw buy just get a generic roast.
 *
 * Zero secrets in code. Run on the droplet with pm2 (needs the `ws` package):
 *   cd /root/chronic-burns && npm install ws
 *   TG_BOT_TOKEN=... TG_CHAT_ID=... pm2 start paperhands.js --name chronic-paperhands
 *
 * Env:
 *   TG_BOT_TOKEN, TG_CHAT_ID   (required — same bot/chat as the burn bot is fine)
 *   CHRONIC_MINT               (default = live mint)
 *   MIN_SELL_SOL               (default 0.01) ignore dust sells below this
 *   SHAME_BUYS=1               (optional) also post a small green note on buys
 *   PAPERHANDS_STORE           (optional) cost-basis file path (default ./paperhands-cost.json)
 */
const WebSocket = require('ws');
const fs = require('fs');

const MINT = process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump';
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;
const MIN_SELL_SOL = parseFloat(process.env.MIN_SELL_SOL || '0.01');
const SHAME_BUYS = process.env.SHAME_BUYS === '1';
const SITE = 'https://www.burnchronic.xyz';

function die(m) { console.error('x ' + m); process.exit(1); }
if (!TG_TOKEN || !TG_CHAT) die('TG_BOT_TOKEN + TG_CHAT_ID required');

const fmt = (n) => { n = Number(n) || 0; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return a < 1 ? n.toFixed(3) : n.toFixed(0); };
const sh = (w) => (w ? w.slice(0, 4) + '..' + w.slice(-4) : '?');
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function tg(text) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) console.error('tg', r.status, (await r.text()).slice(0, 160));
  } catch (e) { console.error('tg err', e.message); }
}

// Persistent cost basis per wallet — survives restarts and accumulates coverage
// so PnL actually shows. Tracks avg buy price; reduces the position as they sell.
const STORE = process.env.PAPERHANDS_STORE || './paperhands-cost.json';
let cost = {};
try { cost = JSON.parse(fs.readFileSync(STORE, 'utf8')) || {}; } catch (_) {}
let _saveT;
function save() { clearTimeout(_saveT); _saveT = setTimeout(() => { try { fs.writeFileSync(STORE, JSON.stringify(cost)); } catch (e) { console.error('save err', e.message); } }, 1500); }
function recordBuy(w, tok, sol) { const c = cost[w] || (cost[w] = { tok: 0, sol: 0 }); c.tok += tok; c.sol += sol; save(); }
function avgPx(w) { const c = cost[w]; if (!c || c.tok <= 0) return null; const a = c.sol / c.tok; return a > 0 ? a : null; }
// realize the sold portion against the avg basis; returns { pct, sol } or null
function realize(w, tok, sol) {
  const avg = avgPx(w); if (!avg) return null;
  const c = cost[w];
  const sold = Math.min(tok, c.tok);
  const pct = (sol / tok) / avg - 1;          // price-based %, whole sell
  const solPnl = (sol * (sold / tok)) - avg * sold; // SOL gained/lost on tracked portion
  c.sol -= avg * sold; c.tok -= sold;          // shrink the position
  if (c.tok < 1e-9) { delete cost[w]; }
  save();
  return { pct: pct * 100, sol: solPnl };
}

// context-aware roast pools — the worse the trade, the harder the smoke
const ROASTS = {
  loss: ['bought high, sold low — a true visionary 🤡', 'speedran poverty 💀', 'donated straight to the diamond hands. thank you for your service 🫡', 'sold the exact bottom. surgical 📉🔬', 'paper hands, paper bag, paper future 🧻', 'you didn’t get rugged — you rugged yourself 😭', 'held it all the way DOWN, then sold. elite 🏆🤡', 'round trip to nowhere ✈️💀', 'the skeleton bought your bag and didn’t even blink 🦴', 'ngmi, professionally 📉'],
  profit: ['sold for lunch money. the skeleton eats forever 🍽️🦴', 'took the appetizer, missed the feast 🍽️', 'small green, generational regret loading… ⏳', 'congrats — you sold the restaurant for a tip 💀', 'won the battle, fumbled the war 🏳️', 'profitable AND a jeet. impressively mid 🤡'],
  unknown: ['weak hands detected 🧻', 'the skeleton is disappointed 💀', 'fumbled the bag 🤡', 'couldn’t hold 💅', 'down bad behavior 📉', 'he folded 🃏', 'enjoy the exit liquidity ser — something strong just bought your bag 🦴', 'first time? 🤝'],
};
function header(sol) {
  if (sol >= 1) return '🚨🚨 MASSIVE PAPERHANDS 🚨🚨';
  if (sol >= 0.25) return '🧻🧻 BIG FUMBLE 🧻🧻';
  return '🧻 PAPERHANDS';
}

function handle(m) {
  const type = (m.txType || '').toLowerCase();
  const tok = Number(m.tokenAmount || m.token_amount || 0);
  const sol = Number(m.solAmount || m.sol_amount || 0);
  const w = m.traderPublicKey || m.trader || '';
  if (!tok || !sol) return;
  if (type === 'buy') { recordBuy(w, tok, sol); if (SHAME_BUYS) tg('🟢 <b>BUY</b> ' + fmt(tok) + ' $CHRONIC for ' + sol.toFixed(3) + ' SOL — diamond hands only 💎\n' + SITE); return; }
  if (type !== 'sell') return;
  if (sol < MIN_SELL_SOL) return; // ignore dust

  const r = realize(w, tok, sol);     // { pct, sol } or null if we never saw them buy
  let pnlLine = '', mood = 'unknown';
  if (r) {
    if (r.pct < 0) { mood = 'loss'; pnlLine = '\n💀 realized a <b>' + r.pct.toFixed(0) + '% LOSS</b> (' + r.sol.toFixed(3) + ' SOL) 💀'; }
    else { mood = 'profit'; pnlLine = '\n🤡 took <b>+' + r.pct.toFixed(0) + '%</b> (+' + r.sol.toFixed(3) + ' SOL) and ran'; }
  }
  const sig = m.signature ? ('\n<a href="https://solscan.io/tx/' + m.signature + '">tx</a>') : '';
  tg(header(sol) + '\n\n<code>' + sh(w) + '</code> dumped <b>' + fmt(tok) + ' $CHRONIC</b> for ' + sol.toFixed(3) + ' SOL' + pnlLine + '\n' + pick(ROASTS[mood]) + sig);
  console.log('roasted sell', sh(w), tok, sol, mood, r ? r.pct.toFixed(0) + '%' : 'no-basis');
}

let ws, alive;
function open() {
  ws = new WebSocket('wss://pumpportal.fun/api/data');
  ws.on('open', () => { console.log('subscribed to $CHRONIC trades'); ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [MINT] })); });
  ws.on('message', (buf) => { let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; } if (m && m.txType) handle(m); });
  ws.on('close', () => { console.error('closed, reconnecting in 3s'); clearInterval(alive); setTimeout(open, 3000); });
  ws.on('error', (e) => { console.error('ws err', e.message); try { ws.close(); } catch (_) {} });
  clearInterval(alive); alive = setInterval(() => { try { ws.ping(); } catch (_) {} }, 25000);
}

console.log('$CHRONIC Paperhands Patrol — min sell ' + MIN_SELL_SOL + ' SOL, shame buys ' + (SHAME_BUYS ? 'on' : 'off'));
open();
