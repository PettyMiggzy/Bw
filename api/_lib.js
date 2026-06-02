'use strict';
/*
 * Shared helpers for the Monad interaction-graph forensics endpoints.
 * Zero npm deps — uses the global fetch available in the Vercel Node runtime.
 *
 * Underscore-prefixed files are excluded from Vercel routing, so this is a
 * plain module the routed handlers (graph.js / deployer.js / funding.js) require.
 *
 * Env (set in Vercel project settings, never commit):
 *   ETHERSCAN_API_KEY     - free key, works across all Etherscan V2 chains
 *   MONAD_RPC             - optional, defaults to the public Monad mainnet RPC
 *   SUPABASE_URL          - optional, enables the 24h cache
 *   SUPABASE_SERVICE_KEY  - optional, service_role key for the cache table
 */

const CHAIN_ID = 143; // Monad mainnet
const ES_BASE = 'https://api.etherscan.io/v2/api';
const RPC = process.env.MONAD_RPC || 'https://rpc.monad.xyz';
const ES_KEY = process.env.ETHERSCAN_API_KEY || '';

const NATIVE_DECIMALS = 18;
const DUST_WEI = 10n ** 13n;        // 0.00001 MON — below this a native edge is "dust"
const DEFAULT_FANOUT = 50;          // max counterparties kept per expanded node
const PAGE_OFFSET = 1000;           // recency window per Etherscan list call (v1 bound)
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const ZERO = '0x0000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// low-level fetch helpers
// ---------------------------------------------------------------------------

// Etherscan free tier is rate limited (~3 req/sec). Serialize Etherscan calls
// with a minimum gap so concurrent Promise.all() bursts can't trip it.
const ES_MIN_GAP_MS = 380;
let _esLastTs = 0;
let _esChain = Promise.resolve();
function esGate() {
  const p = _esChain.then(() => new Promise((resolve) => {
    const wait = Math.max(0, ES_MIN_GAP_MS - (Date.now() - _esLastTs));
    setTimeout(() => { _esLastTs = Date.now(); resolve(); }, wait);
  }));
  _esChain = p.catch(() => {});
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function esCall(params, attempt = 0) {
  if (!ES_KEY) throw new Error('ETHERSCAN_API_KEY is not set');
  await esGate();
  const qs = new URLSearchParams({ chainid: String(CHAIN_ID), apikey: ES_KEY, ...params });
  const url = `${ES_BASE}?${qs.toString()}`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  const j = await r.json();
  // Etherscan returns status "0" + "No transactions found" for empty result sets,
  // and status "0" + a message for genuine errors (rate limit, bad key, ...).
  if (j.status === '1') return Array.isArray(j.result) ? j.result : [j.result];
  const blob = `${j.message || ''} ${typeof j.result === 'string' ? j.result : ''}`;
  if (/no (transactions|records) found/i.test(blob)) return [];
  // Back off and retry transient rate-limit responses.
  if (/rate limit/i.test(blob) && attempt < 4) {
    await sleep(600 * (attempt + 1));
    return esCall(params, attempt + 1);
  }
  // Busy address timed out — shrink the result window and retry (down to a floor).
  if (/query timeout/i.test(blob) && params.offset && Number(params.offset) > 200) {
    const smaller = Math.max(200, Math.floor(Number(params.offset) / 2));
    return esCall({ ...params, offset: String(smaller) }, attempt);
  }
  throw new Error(`Etherscan: ${j.message || 'error'} — ${JSON.stringify(j.result).slice(0, 160)}`);
}

// Batched eth_getCode → { address: isContract }. One HTTP call for the whole set.
async function typeAddresses(addresses) {
  const out = {};
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => a && a !== ZERO);
  if (!list.length) return out;
  const body = list.map((addr, i) => ({
    jsonrpc: '2.0', id: i, method: 'eth_getCode', params: [addr, 'latest'],
  }));
  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const arr = await r.json();
    for (const item of Array.isArray(arr) ? arr : []) {
      const addr = list[item.id];
      const code = item.result || '0x';
      out[addr] = code && code !== '0x' ? 'contract' : 'wallet';
    }
  } catch (_) { /* typing is best-effort; unknown nodes default to wallet client-side */ }
  return out;
}

// ---------------------------------------------------------------------------
// Supabase cache (PostgREST). No-ops gracefully when env is absent.
// ---------------------------------------------------------------------------

function cacheEnabled() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

async function cacheGet(key) {
  if (!cacheEnabled()) return null;
  const url = `${process.env.SUPABASE_URL}/rest/v1/interactions?address=eq.${key}&select=payload,fetched_at`;
  try {
    const r = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows.length) return null;
    const age = Date.now() - new Date(rows[0].fetched_at).getTime();
    if (age > CACHE_TTL_MS) return null;
    return rows[0].payload;
  } catch (_) { return null; }
}

async function cacheSet(key, payload) {
  if (!cacheEnabled()) return;
  const url = `${process.env.SUPABASE_URL}/rest/v1/interactions`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates', // upsert on the address PK
      },
      body: JSON.stringify({ address: key, payload, fetched_at: new Date().toISOString() }),
    });
  } catch (_) { /* cache writes are best-effort */ }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const lc = (a) => (a || '').toLowerCase();
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

// Zero-width / bidi unicode in a token name is a classic spam/scam obfuscation.
const SPAMMY = /[​-‏‪-‮⁠﻿]/;
function fmtUnits(raw, decimals) {
  try {
    const d = BigInt(decimals || 0);
    const v = BigInt(raw || '0');
    if (d === 0n) return v.toString();
    const base = 10n ** d;
    const whole = v / base;
    const frac = (v % base).toString().padStart(Number(d), '0').slice(0, 6).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch (_) { return '0'; }
}

module.exports = {
  CHAIN_ID, RPC, ES_KEY, NATIVE_DECIMALS, DUST_WEI, DEFAULT_FANOUT, PAGE_OFFSET, ZERO,
  esCall, typeAddresses, cacheGet, cacheSet, cacheEnabled,
  isAddress, lc, short, SPAMMY, fmtUnits,
};
