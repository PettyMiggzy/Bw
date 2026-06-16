#!/usr/bin/env node
'use strict';
/*
 * paperhands.js — $CHRONIC "Paperhands Patrol". Roasts every sell in Telegram.
 *
 * Subscribes to live $CHRONIC trades via PumpPortal (subscribeTokenTrade), and
 * when someone SELLS, it posts a savage little roast — bigger dumps get bigger
 * roasts. It also tracks each wallet's buy cost-basis (in memory) so it can call
 * out "sold at a -X% LOSS" when the seller bought after the bot started.
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
 */
const WebSocket = require('ws');

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

// in-memory cost basis per wallet (resets on restart; only sees post-start buys)
const cost = {};
function recordBuy(w, tok, sol) { const c = cost[w] || (cost[w] = { tok: 0, sol: 0 }); c.tok += tok; c.sol += sol; }
function pnlPct(w, sellPx) { const c = cost[w]; if (!c || c.tok <= 0) return null; const avg = c.sol / c.tok; if (avg <= 0) return null; return (sellPx / avg - 1) * 100; }

const ROASTS = ['ngmi 🦴', 'weak hands detected 🧻', 'the skeleton is disappointed 💀', 'fumbled the bag 🤡', 'couldn\'t hold 💅', 'paper everything 🧻', 'down bad behavior 📉', 'he folded 🃏', 'enjoy the bottom ser 📉', 'first time? 🤝'];
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
  const px = sol / tok;
  if (type === 'buy') { recordBuy(w, tok, sol); if (SHAME_BUYS) tg('🟢 <b>BUY</b> ' + fmt(tok) + ' $CHRONIC for ' + sol.toFixed(3) + ' SOL — diamond hands only 💎\n' + SITE); return; }
  if (type !== 'sell') return;
  if (sol < MIN_SELL_SOL) return; // ignore dust
  const pnl = pnlPct(w, px);
  let lossLine = '';
  if (pnl !== null) lossLine = pnl < 0 ? '\nsold at a <b>' + pnl.toFixed(0) + '% LOSS</b> 💀💀' : '\n(up ' + pnl.toFixed(0) + '%, still fumbled the future 🤡)';
  const sig = m.signature ? ('\n<a href="https://solscan.io/tx/' + m.signature + '">tx</a>') : '';
  tg(header(sol) + '\n\n<code>' + sh(w) + '</code> dumped <b>' + fmt(tok) + ' $CHRONIC</b> for ' + sol.toFixed(3) + ' SOL' + lossLine + '\n' + pick(ROASTS) + sig);
  console.log('roasted sell', sh(w), tok, sol);
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
