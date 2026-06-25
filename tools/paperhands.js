#!/usr/bin/env node
'use strict';
/*
 * paperhands.js — $CHRONIC "Paperhands Patrol". Roasts every sell in Telegram.
 *
 * DETECTION (proven, venue-correct): subscribe to the POOL's logs through YOUR
 * Solana RPC (logsSubscribe), pull each tx, classify buy/sell from the pool's
 * native SOL balance delta, and read the trader's $CHRONIC token delta for size.
 *
 * ROAST + PnL: persistent cost-basis per wallet -> realized PnL on sells
 * ("% LOSS (-X SOL)" or "+% and ran"), context-aware roast pools (losers cooked
 * harder than profit-takers), and the jeets.json feed is preserved.
 *
 * Run on the droplet with pm2 (needs `ws`):
 *   cd /root/chronic-burns && npm install ws
 *   pm2 start paperhands.js --name chronic-paperhands   (env already set in pm2)
 *
 * Env: SOLANA_RPC (ws-capable), POOL_ADDRESS, CHRONIC_MINT, TG_BOT_TOKEN,
 *      TG_CHAT_ID, MIN_SELL_SOL (0.01), SHAME_BUYS (1=announce buys),
 *      TOKEN_SYMBOL (CHRONIC), PAPERHANDS_STORE, JEETS_FILE
 */
const WebSocket = require('ws');
const fs = require('fs');

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MINT = process.env.CHRONIC_MINT || 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump';
const POOL = process.env.POOL_ADDRESS || '8cP6yTEQUnzp4MLHEwFzhdGv7uUetxtW2cX25W4ozHx8';
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;
const MIN_SELL_SOL = parseFloat(process.env.MIN_SELL_SOL || '0.01');
const SHAME_BUYS = process.env.SHAME_BUYS === '1';
const SYM = process.env.TOKEN_SYMBOL || 'CHRONIC';
const JEETS = process.env.JEETS_FILE || '/root/chronic-burns/jeets.json';
const STORE = process.env.PAPERHANDS_STORE || '/root/chronic-burns/paperhands-cost.json';
if (!TG_TOKEN || !TG_CHAT) { console.error('TG_BOT_TOKEN + TG_CHAT_ID required'); process.exit(1); }

const WS_URL = RPC.replace(/^http/, 'ws');
const sh = (a) => (a ? a.slice(0, 4) + '..' + a.slice(-4) : '');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const fmt = (n) => { n = Number(n) || 0; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return a < 1 ? n.toFixed(3) : n.toFixed(0); };
const seen = new Set();

// persistent cost basis -> realized PnL (survives restarts, grows over time)
let cost = {};
try { cost = JSON.parse(fs.readFileSync(STORE, 'utf8')) || {}; } catch (_) {}
let _saveT;
function save() { clearTimeout(_saveT); _saveT = setTimeout(() => { try { fs.writeFileSync(STORE, JSON.stringify(cost)); } catch (e) { console.error('save err', e.message); } }, 1500); }
function recordBuy(w, tok, sol) { if (!(tok > 0) || !(sol > 0)) return; const c = cost[w] || (cost[w] = { tok: 0, sol: 0 }); c.tok += tok; c.sol += sol; save(); }
function avgPx(w) { const c = cost[w]; if (!c || c.tok <= 0) return null; const a = c.sol / c.tok; return a > 0 ? a : null; }
function realize(w, tok, sol) {
  const avg = avgPx(w); if (!avg || !(tok > 0)) return null;
  const c = cost[w]; const sold = Math.min(tok, c.tok);
  const pct = ((sol / tok) / avg - 1) * 100;
  const solPnl = (sol * (sold / tok)) - avg * sold;
  c.sol -= avg * sold; c.tok -= sold; if (c.tok < 1e-9) delete cost[w]; save();
  return { pct, sol: solPnl };
}

const ROASTS = {
  loss: ['bought high, sold low — a true visionary 🤡', 'speedran poverty 💀', 'donated straight to the diamond hands. thank you for your service 🫡', 'sold the exact bottom. surgical 📉', 'paper hands, paper bag, paper future 🧻', 'you didnt get rugged — you rugged yourself 😭', 'held it all the way DOWN then sold. elite 🏆🤡', 'round trip to nowhere ✈️💀', 'the skeleton bought your bag and didnt even blink 🦴', 'ngmi, professionally 📉'],
  profit: ['sold for lunch money. the skeleton eats forever 🍽️', 'took the appetizer, missed the feast 🍽️', 'small green, generational regret loading ⏳', 'congrats — you sold the restaurant for a tip 💀', 'won the battle, fumbled the war 🏳️', 'profitable AND a jeet. impressively mid 🤡'],
  unknown: ['paper hands detected 🧻 the skeleton stays. 💀', 'folded — enjoy rebuying higher 🌿', 'tapped out. supply still only goes down 🔥', 'cant handle the smoke. ngmi 🧻', 'more for the real ones. burn it dont hoard it 💀', 'the skeleton is disappointed 💀', 'first time? 🤝'],
};
function header(sol) { if (sol >= 1) return '🚨🚨 MASSIVE PAPERHANDS 🚨🚨'; if (sol >= 0.25) return '🧻🧻 BIG FUMBLE 🧻🧻'; return '🧻 PAPERHANDS'; }

async function rpc(m, p) { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); return (await r.json()).result; }
async function tg(text) { try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }) }); } catch (e) { console.error('tg err', e.message); } }
function logJeet(who, sol, sig, pct) { try { let arr = []; try { arr = JSON.parse(fs.readFileSync(JEETS, 'utf8')); } catch (_) {} const e = { who, sol: +sol.toFixed(3), t: Date.now(), sig }; if (pct != null) e.pct = Math.round(pct); arr.unshift(e); fs.writeFileSync(JEETS, JSON.stringify(arr.slice(0, 50))); } catch (_) {} }

// trader's $CHRONIC balance change in this tx (UI units; + on buy, - on sell)
function tokenDelta(tx, trader) {
  const f = (arr) => (arr || []).filter((b) => b.mint === MINT && b.owner === trader).reduce((s, b) => s + (Number(b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0), 0);
  return f(tx.meta.postTokenBalances) - f(tx.meta.preTokenBalances);
}

async function handleSig(sig) {
  if (seen.has(sig)) return; seen.add(sig); if (seen.size > 5000) seen.clear();
  let tx; for (let i = 0; i < 5 && !tx; i++) { try { tx = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]); } catch (_) {} if (!tx) await new Promise((r) => setTimeout(r, 800)); }
  if (!tx || !tx.meta || tx.meta.err) return;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey || k);
  const idx = keys.indexOf(POOL); if (idx < 0) return;
  const delta = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9; // pool SOL change
  const solAmt = Math.abs(delta);
  const trader = keys[0];
  const tokAmt = Math.abs(tokenDelta(tx, trader));

  if (delta > 0) { // pool SOL up => BUY
    recordBuy(trader, tokAmt, solAmt);
    if (SHAME_BUYS && solAmt >= MIN_SELL_SOL) await tg('🟢 <b>' + sh(trader) + '</b> aped <b>' + solAmt.toFixed(3) + ' SOL</b> of $' + SYM + ' — diamond hands only 💎\n🔎 https://solscan.io/tx/' + sig);
    return;
  }
  // pool SOL down => SELL
  if (solAmt < MIN_SELL_SOL) return;
  const r = realize(trader, tokAmt, solAmt);
  let pnlLine = '', mood = 'unknown';
  if (r) {
    if (r.pct < 0) { mood = 'loss'; pnlLine = '\n💀 realized a <b>' + r.pct.toFixed(0) + '% LOSS</b> (' + r.sol.toFixed(3) + ' SOL) 💀'; }
    else { mood = 'profit'; pnlLine = '\n🤡 took <b>+' + r.pct.toFixed(0) + '%</b> (+' + r.sol.toFixed(3) + ' SOL) and ran'; }
  }
  const amtLine = '<code>' + sh(trader) + '</code> dumped ' + (tokAmt > 0 ? '<b>' + fmt(tokAmt) + ' $' + SYM + '</b> for ' : '') + '<b>' + solAmt.toFixed(3) + ' SOL</b>';
  await tg(header(solAmt) + '\n\n' + amtLine + pnlLine + '\n' + pick(ROASTS[mood]) + '\n🔎 https://solscan.io/tx/' + sig);
  logJeet(sh(trader), solAmt, sig, r ? r.pct : null);
  console.log('SELL', sh(trader), solAmt.toFixed(3), mood, r ? r.pct.toFixed(0) + '%' : 'no-basis');
}

let ws, backoff = 1000;
function connect() {
  ws = new WebSocket(WS_URL); let ka;
  ws.on('open', () => { backoff = 1000; console.log('connected, watching pool', POOL);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [POOL] }, { commitment: 'confirmed' }] }));
    ka = setInterval(() => { try { ws.ping(); } catch (_) {} }, 25000); });
  ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.method === 'logsNotification') { const v = m.params && m.params.result && m.params.result.value; if (v && v.signature && !v.err) handleSig(v.signature); } } catch (_) {} });
  ws.on('close', () => { clearInterval(ka); console.log('closed, reconnect in', backoff, 'ms'); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); });
  ws.on('error', (e) => { console.log('ws err', e.message); try { ws.close(); } catch (_) {} });
}
connect();
console.log('$' + SYM + ' Paperhands Patrol — pool feed, min sell ' + MIN_SELL_SOL + ' SOL, shame buys ' + (SHAME_BUYS ? 'on' : 'off'));

// ── daily "Biggest Jeet of the Day" recap to the chat ──────────────────
// Posts the worst loser in the window to TG_CHAT. Fires once on boot (so it
// shows immediately after deploy), then every SHAME_POST_HOURS. Skips quietly
// when nobody folded in the window. State persisted so restarts don't spam.
const SHAME_EVERY_H = parseFloat(process.env.SHAME_POST_HOURS || '24');
const SHAME_STATE = process.env.SHAME_STATE || '/root/chronic-burns/shame-state.json';
function _lastShame() { try { return JSON.parse(fs.readFileSync(SHAME_STATE, 'utf8')).t || 0; } catch (_) { return 0; } }
function _setShame(t) { try { fs.writeFileSync(SHAME_STATE, JSON.stringify({ t })); } catch (_) {} }
async function shameRecap() {
  const now = Date.now(); const last = _lastShame();
  if (now - last < SHAME_EVERY_H * 3600 * 1000) return;
  let arr = []; try { arr = JSON.parse(fs.readFileSync(JEETS, 'utf8')) || []; } catch (_) {}
  const cut = last === 0 ? 0 : now - SHAME_EVERY_H * 3600 * 1000; // first run = all-time
  const win = arr.filter((e) => (e.t || 0) >= cut);
  if (!win.length) { _setShame(now); return; }
  const losers = win.filter((e) => e.pct != null && e.pct < 0).sort((a, b) => a.pct - b.pct);
  const top = losers[0] || win.slice().sort((a, b) => (b.sol || 0) - (a.sol || 0))[0];
  let line;
  if (top.pct != null && top.pct < 0) {
    const lost = top.sol * (top.pct / 100) / (1 + top.pct / 100);
    line = '👑 <b>KING JEET</b> — <code>' + top.who + '</code>\nsold at <b>' + top.pct.toFixed(0) + '% LOSS</b> (~' + lost.toFixed(3) + ' SOL)';
  } else {
    line = '👑 <b>KING JEET</b> — <code>' + top.who + '</code>\ndumped <b>' + (Number(top.sol) || 0).toFixed(3) + ' SOL</b>';
  }
  await tg('🧻💀 <b>BIGGEST JEET OF THE DAY</b> 💀🧻\n\n' + line + '\n' + pick(ROASTS.loss) + '\n\nsupply only goes down. burn it dont hoard it 🔥');
  _setShame(now); console.log('posted daily shame recap');
}
setInterval(shameRecap, 3600 * 1000); // re-check hourly
setTimeout(shameRecap, 5000);         // and once shortly after boot
