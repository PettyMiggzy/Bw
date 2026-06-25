#!/usr/bin/env node
'use strict';
/*
 * paperhands.js — $CHRONIC "Paperhands Patrol". Roasts every sell in Telegram.
 *
 * DETECTION: subscribe to the POOL's logs through YOUR Solana RPC (logsSubscribe),
 * pull each tx, classify buy/sell from the pool's native SOL balance delta.
 *
 * PnL: on each sell we ask the Solana Tracker Data API for that wallet's REAL
 * realized PnL on $CHRONIC (USD) — works for ANY wallet, even ones we never saw
 * buy. Plus a daily "Biggest Jeet of the Day" crown with the same real PnL.
 *
 * Env: SOLANA_RPC (ws-capable), POOL_ADDRESS, CHRONIC_MINT, TG_BOT_TOKEN,
 *      TG_CHAT_ID, MIN_SELL_SOL (0.01), SHAME_BUYS, TOKEN_SYMBOL,
 *      STRACKER_KEY (Solana Tracker Data API x-api-key), STRACKER_BASE,
 *      SHAME_POST_HOURS (24), JEETS_FILE, SHAME_STATE
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
const SHAME_STATE = process.env.SHAME_STATE || '/root/chronic-burns/shame-state.json';
const STRACKER_BASE = process.env.STRACKER_BASE || 'https://data.solanatracker.io';
const STRACKER_KEY = process.env.STRACKER_KEY || ''; // set in env (or hardcoded on the droplet)
if (!TG_TOKEN || !TG_CHAT) { console.error('TG_BOT_TOKEN + TG_CHAT_ID required'); process.exit(1); }

const WS_URL = RPC.replace(/^http/, 'ws');
const sh = (a) => (a ? a.slice(0, 4) + '..' + a.slice(-4) : '');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const fmt = (n) => { n = Number(n) || 0; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return a < 1 ? n.toFixed(3) : n.toFixed(0); };
const usd = (n) => { n = Math.abs(Number(n) || 0); return n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : '$' + n.toFixed(2); };
const seen = new Set();

const ROASTS = {
  loss: ['bought high, sold low — a true visionary 🤡', 'speedran poverty 💀', 'donated straight to the diamond hands. thank you for your service 🫡', 'sold the exact bottom. surgical 📉', 'paper hands, paper bag, paper future 🧻', 'you didnt get rugged — you rugged yourself 😭', 'held it all the way DOWN then sold. elite 🏆🤡', 'round trip to nowhere ✈️💀', 'the skeleton bought your bag and didnt even blink 🦴', 'ngmi, professionally 📉'],
  profit: ['sold for lunch money. the skeleton eats forever 🍽️', 'took the appetizer, missed the feast 🍽️', 'small green, generational regret loading ⏳', 'congrats — you sold the restaurant for a tip 💀', 'won the battle, fumbled the war 🏳️', 'profitable AND a jeet. impressively mid 🤡'],
  unknown: ['paper hands detected 🧻 the skeleton stays. 💀', 'folded — enjoy rebuying higher 🌿', 'tapped out. supply still only goes down 🔥', 'cant handle the smoke. ngmi 🧻', 'more for the real ones. burn it dont hoard it 💀', 'the skeleton is disappointed 💀', 'first time? 🤝'],
};
function header(sol) { if (sol >= 1) return '🚨🚨 MASSIVE PAPERHANDS 🚨🚨'; if (sol >= 0.25) return '🧻🧻 BIG FUMBLE 🧻🧻'; return '🧻 PAPERHANDS'; }

async function rpc(m, p) { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); return (await r.json()).result; }
async function tg(text) { try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }) }); } catch (e) { console.error('tg err', e.message); } }
function logJeet(addr, who, sol, sig) { try { let arr = []; try { arr = JSON.parse(fs.readFileSync(JEETS, 'utf8')); } catch (_) {} arr.unshift({ addr, who, sol: +sol.toFixed(3), t: Date.now(), sig }); fs.writeFileSync(JEETS, JSON.stringify(arr.slice(0, 50))); } catch (_) {} }

// Solana Tracker: a wallet's realized $CHRONIC PnL (USD). Cached 60s, best-effort.
const _pnlCache = {};
async function strackerPnl(wallet) {
  if (!STRACKER_KEY || !wallet) return null;
  const c = _pnlCache[wallet]; if (c && Date.now() - c.t < 60000) return c.v;
  let v = null;
  try {
    const r = await fetch(STRACKER_BASE + '/pnl/' + wallet, { headers: { 'x-api-key': STRACKER_KEY } });
    if (r.ok) { const j = await r.json(); const t = j && j.tokens && j.tokens[MINT]; if (t) v = { realized: Number(t.realized) || 0, holding: Number(t.holding) || 0 }; }
  } catch (_) {}
  _pnlCache[wallet] = { t: Date.now(), v };
  return v;
}
function pnlLineFor(p) {
  if (!p) return { line: '', mood: 'unknown' };
  if (p.realized < -0.01) return { mood: 'loss', line: '\n💀 realized <b>-' + usd(p.realized) + '</b> on $' + SYM + (p.holding > 0 ? ' (still bagholding 🎒)' : '') + ' 💀' };
  if (p.realized > 0.01) return { mood: 'profit', line: '\n🤡 banked <b>+' + usd(p.realized) + '</b> and ran' };
  return { line: '', mood: 'unknown' };
}

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
  const delta = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
  const solAmt = Math.abs(delta);
  const trader = keys[0];
  const tokAmt = Math.abs(tokenDelta(tx, trader));

  if (delta > 0) { // BUY
    if (SHAME_BUYS && solAmt >= MIN_SELL_SOL) await tg('🟢 <b>' + sh(trader) + '</b> aped <b>' + solAmt.toFixed(3) + ' SOL</b> of $' + SYM + ' — diamond hands only 💎\n🔎 https://solscan.io/tx/' + sig);
    return;
  }
  // SELL
  if (solAmt < MIN_SELL_SOL) return;
  const p = await strackerPnl(trader);
  const { line: pnlLine, mood } = pnlLineFor(p);
  const amtLine = '<code>' + sh(trader) + '</code> dumped <b>' + fmt(tokAmt) + ' $' + SYM + '</b>';
  await tg(header(solAmt) + '\n\n' + amtLine + pnlLine + '\n' + pick(ROASTS[mood]) + '\n🔎 https://solscan.io/tx/' + sig);
  logJeet(trader, sh(trader), solAmt, sig);
  console.log('SELL', sh(trader), solAmt.toFixed(3), mood);
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
console.log('$' + SYM + ' Paperhands Patrol — pool feed, PnL ' + (STRACKER_KEY ? 'ON' : 'OFF') + ', min sell ' + MIN_SELL_SOL + ' SOL');

// ── daily "Biggest Jeet of the Day" crown to the chat ──
const SHAME_EVERY_H = parseFloat(process.env.SHAME_POST_HOURS || '24');
function _lastShame() { try { return JSON.parse(fs.readFileSync(SHAME_STATE, 'utf8')).t || 0; } catch (_) { return 0; } }
function _setShame(t) { try { fs.writeFileSync(SHAME_STATE, JSON.stringify({ t })); } catch (_) {} }
async function shameRecap() {
  const now = Date.now(); const last = _lastShame();
  if (now - last < SHAME_EVERY_H * 3600 * 1000) return;
  let arr = []; try { arr = JSON.parse(fs.readFileSync(JEETS, 'utf8')) || []; } catch (_) {}
  const cut = last === 0 ? 0 : now - SHAME_EVERY_H * 3600 * 1000;
  const win = arr.filter((e) => (e.t || 0) >= cut);
  if (!win.length) { _setShame(now); return; }
  const top = win.slice().sort((a, b) => (b.sol || 0) - (a.sol || 0))[0];
  const { line: pnlLine } = pnlLineFor(top.addr ? await strackerPnl(top.addr) : null);
  await tg('🧻💀 <b>BIGGEST JEET OF THE DAY</b> 💀🧻\n\n👑 <b>KING JEET</b> — <code>' + top.who + '</code>' + pnlLine + '\n' + pick(ROASTS.loss) + '\n\nsupply only goes down. burn it dont hoard it 🔥');
  _setShame(now); console.log('posted daily shame recap');
}
setInterval(shameRecap, 3600 * 1000);
setTimeout(shameRecap, 5000);
