#!/usr/bin/env node
'use strict';
/*
 * newmints-listener.js — the $CHRONIC terminal "New" firehose.
 *
 * Subscribes to brand-new pump.fun token creations in real time and upserts
 * each one into the `grow_newmints` Supabase table. The terminal reads that
 * table via /api/newmints and shows them on the "New" board seconds after they
 * mint — before Dexscreener has even indexed them.
 *
 * This is a LONG-RUNNING websocket process. Vercel functions are short-lived,
 * so run this on an always-on host (Railway / Render / Fly / a small VPS):
 *     cd tools && npm install && node newmints-listener.js
 *
 * Source (default = PumpPortal, zero key required):
 *     wss://pumpportal.fun/api/data  →  {method:'subscribeNewToken'}
 *
 * Alchemy alternative (set FEED=alchemy + ALCHEMY_WSS): subscribes to logs
 * mentioning the pump.fun program and pulls the mint from the create ix. The
 * PumpPortal feed already gives name/symbol/uri/creator for free, so it's the
 * default; Alchemy is there if you'd rather own the pipe end-to-end.
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY   (required — where mints are written)
 *   FEED=pumpportal|alchemy              (default: pumpportal)
 *   ALCHEMY_WSS                          (required when FEED=alchemy)
 *   META_FETCH=1                         (fetch token uri json for the image)
 *   RETENTION_HOURS=6                    (auto-delete mints older than this so
 *                                         the free-tier DB never fills up)
 */
const WebSocket = require('ws');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const FEED = (process.env.FEED || 'pumpportal').toLowerCase();
const ALCHEMY_WSS = process.env.ALCHEMY_WSS || '';
const META_FETCH = process.env.META_FETCH === '1';
const RETENTION_HOURS = Math.max(1, parseFloat(process.env.RETENTION_HOURS || '6'));
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

function die(m) { console.error('✗ ' + m); process.exit(1); }
if (!SB_URL || !SB_KEY) die('SUPABASE_URL / SUPABASE_SERVICE_KEY required');
if (FEED === 'alchemy' && !ALCHEMY_WSS) die('FEED=alchemy needs ALCHEMY_WSS');

const H = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' };
const seen = new Set(); // de-dupe within this process run

async function upsert(row) {
  if (!row || !row.mint || seen.has(row.mint)) return;
  seen.add(row.mint);
  if (seen.size > 5000) seen.clear(); // bound memory on long runs
  try {
    const r = await fetch(`${SB_URL}/rest/v1/grow_newmints?on_conflict=mint`, {
      method: 'POST',
      headers: Object.assign({}, H, { prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(row),
    });
    if (!r.ok) console.error('upsert', r.status, (await r.text()).slice(0, 160));
    else console.log('＋', row.symbol || '?', row.mint);
  } catch (e) { console.error('upsert err', e.message); }
}

// janitor: delete mints older than the retention window so the table stays
// tiny (a few thousand rows) and never eats the free-tier 500 MB. Runs at
// startup and every 10 min. Service key bypasses RLS, so the delete is allowed.
async function prune() {
  try {
    const cutoff = new Date(Date.now() - RETENTION_HOURS * 3600 * 1000).toISOString();
    const r = await fetch(`${SB_URL}/rest/v1/grow_newmints?created_at=lt.${encodeURIComponent(cutoff)}`, {
      method: 'DELETE',
      headers: Object.assign({}, H, { prefer: 'return=minimal' }),
    });
    if (r.ok) console.log(`🧹 pruned mints older than ${RETENTION_HOURS}h`);
    else console.error('prune', r.status, (await r.text()).slice(0, 120));
  } catch (e) { console.error('prune err', e.message); }
}

// best-effort: pull the image out of the token's metadata uri (ipfs json)
async function imageFor(uri) {
  if (!META_FETCH || !uri) return '';
  try {
    const ctl = AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined;
    const j = await (await fetch(uri, { signal: ctl })).json();
    return j.image || '';
  } catch (_) { return ''; }
}

// ── PumpPortal: clean, labelled new-token events (default) ──────────────────
function runPumpPortal() {
  let ws, alive;
  function open() {
    ws = new WebSocket('wss://pumpportal.fun/api/data');
    ws.on('open', () => { console.log('▶ pumpportal subscribeNewToken'); ws.send(JSON.stringify({ method: 'subscribeNewToken' })); });
    ws.on('message', async (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
      if (!m || !m.mint || (m.txType && m.txType !== 'create')) return;
      const image = m.image || await imageFor(m.uri);
      await upsert({
        mint: m.mint,
        name: m.name || null,
        symbol: m.symbol || null,
        image: image || null,
        uri: m.uri || null,
        creator: m.traderPublicKey || m.creator || null,
        sol: Number(m.solAmount || m.initialBuy || 0) || 0,
      });
    });
    ws.on('close', () => { console.error('… pumpportal closed, reconnecting in 3s'); setTimeout(open, 3000); });
    ws.on('error', (e) => { console.error('pumpportal err', e.message); try { ws.close(); } catch (_) {} });
    clearInterval(alive); alive = setInterval(() => { try { ws.ping(); } catch (_) {} }, 25000);
  }
  open();
}

// ── Alchemy: own the pipe. logsSubscribe on the pump.fun program ────────────
function runAlchemy() {
  let ws;
  function open() {
    ws = new WebSocket(ALCHEMY_WSS);
    ws.on('open', () => {
      console.log('▶ alchemy logsSubscribe', PUMP_PROGRAM);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'processed' }] }));
    });
    ws.on('message', async (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
      const v = m && m.params && m.params.result && m.params.result.value;
      if (!v || !v.logs || v.err) return;
      // only react to creation logs; resolve the mint from the tx
      if (!v.logs.some((l) => /InitializeMint2|Instruction: Create\b/.test(l))) return;
      const mint = await mintFromSig(v.signature);
      if (mint) await upsert({ mint, name: null, symbol: null, image: null, uri: null, creator: null, sol: 0 });
    });
    ws.on('close', () => { console.error('… alchemy closed, reconnecting in 3s'); setTimeout(open, 3000); });
    ws.on('error', (e) => { console.error('alchemy err', e.message); try { ws.close(); } catch (_) {} });
  }
  open();
}

// resolve the new SPL mint from a create tx (Alchemy path) via JSON-RPC
async function mintFromSig(sig) {
  try {
    const rpc = ALCHEMY_WSS.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction',
        params: [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }) });
    const j = await r.json();
    const tx = j && j.result; if (!tx || (tx.meta && tx.meta.err)) return null;
    const ixs = (tx.transaction.message.instructions || [])
      .concat(...((tx.meta.innerInstructions || []).map((g) => g.instructions || [])));
    for (const ix of ixs) {
      const p = ix.parsed;
      if (p && (p.type === 'initializeMint' || p.type === 'initializeMint2') && p.info && p.info.mint) return p.info.mint;
    }
    return null;
  } catch (_) { return null; }
}

console.log(`$CHRONIC new-mint listener — feed=${FEED}, meta=${META_FETCH ? 'on' : 'off'}, retention=${RETENTION_HOURS}h`);
prune();
setInterval(prune, 10 * 60 * 1000); // every 10 min
if (FEED === 'alchemy') runAlchemy(); else runPumpPortal();
