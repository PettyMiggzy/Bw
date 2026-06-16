#!/usr/bin/env node
'use strict';
/*
 * gradtracker.js — $CHRONIC graduation hype bot for Telegram.
 *
 * Watches live trades (PumpPortal). On a BUY it checks the bonding-curve
 * progress (via the site's /api/curve, which reads the real on-chain curve) and
 * posts when it crosses a new milestone (10/25/50/75/90/95%), plus a big blast
 * when it GRADUATES to PumpSwap. Baselines on startup so it won't spam past
 * milestones. Throttled so frequent buys don't flood the chat.
 *
 * Run on the droplet with pm2 (needs `ws`, already installed in chronic-burns):
 *   TG_BOT_TOKEN=... TG_CHAT_ID=... pm2 start gradtracker.js --name chronic-grad
 *
 * Env:
 *   TG_BOT_TOKEN, TG_CHAT_ID   (required — same bot/chat as the others)
 *   CHRONIC_MINT               (default = live mint)
 *   SITE                       (default https://www.burnchronic.xyz) — for /api/curve
 *   GRAD_SOL                   (default 85) approx SOL in the curve at graduation
 */
const WebSocket = require('ws');

const MINT = process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump';
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;
const SITE = process.env.SITE || 'https://www.burnchronic.xyz';
const GRAD_SOL = parseFloat(process.env.GRAD_SOL || '85');

function die(m) { console.error('x ' + m); process.exit(1); }
if (!TG_TOKEN || !TG_CHAT) die('TG_BOT_TOKEN + TG_CHAT_ID required');

async function tg(text) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) console.error('tg', r.status, (await r.text()).slice(0, 160));
  } catch (e) { console.error('tg err', e.message); }
}
async function curve() { try { const r = await fetch(SITE + '/api/curve?ca=' + MINT); return await r.json(); } catch (e) { return null; } }

const MILESTONES = [10, 25, 50, 75, 90, 95];
let lastMilestone = 0, baselined = false, graduated = false, lastCheck = 0;

async function check() {
  const c = await curve();
  if (!c) return;
  if (c.complete || c.onCurve === false) {
    if (!graduated) { graduated = true; await tg('🎓🚀 <b>$CHRONIC HAS GRADUATED!</b> 🚀🎓\n\nthe bonding curve is complete — liquidity is locked on PumpSwap forever, no rug possible. the skeleton made it. 💀🔥\n\n' + SITE); }
    return;
  }
  const p = Number(c.progress) || 0;
  let crossed = 0; for (const m of MILESTONES) if (p >= m) crossed = m;
  if (!baselined) { baselined = true; lastMilestone = crossed; console.log('baseline progress', p, 'milestone', crossed); return; }
  if (crossed > lastMilestone) {
    lastMilestone = crossed;
    const remain = Math.max(0, GRAD_SOL - (Number(c.solRaised) || 0));
    await tg('🚀 <b>' + crossed + '% TO GRADUATION</b> 🚀\n\n$CHRONIC bonding curve is <b>' + p.toFixed(1) + '%</b> full — only ~<b>' + remain.toFixed(1) + ' SOL</b> to PumpSwap. 🔥\n\nsend it, we\'re close. ' + SITE);
    console.log('milestone posted', crossed, 'progress', p);
  }
}

let ws, alive;
function open() {
  ws = new WebSocket('wss://pumpportal.fun/api/data');
  ws.on('open', () => { console.log('grad tracker subscribed to trades'); ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [MINT] })); });
  ws.on('message', (buf) => { let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; } if (m && (m.txType || '').toLowerCase() === 'buy' && Date.now() - lastCheck > 30000) { lastCheck = Date.now(); check(); } });
  ws.on('close', () => { console.error('closed, reconnect 3s'); clearInterval(alive); setTimeout(open, 3000); });
  ws.on('error', (e) => { console.error('ws err', e.message); try { ws.close(); } catch (_) {} });
  clearInterval(alive); alive = setInterval(() => { try { ws.ping(); } catch (_) {} }, 25000);
}

console.log('$CHRONIC graduation tracker live');
check();                         // baseline (no post)
open();                          // post on buys crossing a milestone
setInterval(check, 10 * 60 * 1000); // safety net every 10 min
