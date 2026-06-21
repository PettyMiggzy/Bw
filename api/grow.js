'use strict';
/*
 * /api/grow — $CHRONIC GROW backend dispatcher.
 *
 * Actions (via ?action= or JSON body {action}):
 *   GET  nonce       ?wallet=         -> challenge string to sign (login step 1)
 *   POST login       {wallet,signature}-> verify sig -> { token }   (step 2)
 *   GET  state       (auth)           -> player garden + season + your XP
 *   POST buy         (auth){sig,kind,item} -> verify on-chain burn -> grant item
 *   POST plant       (auth){strain}   -> plant an owned seed
 *   POST sell        (auth){idx}      -> sell a ripe plot -> credit XP
 *   GET  leaderboard ?limit=          -> public board + pool + countdown
 *   GET  season                       -> public current-season info
 *
 * Money integrity is on-chain: `buy` only grants after verifyBuyTx confirms the
 * tx burned 60% + pooled 40% of the item price, signed by the wallet. XP can
 * therefore only ever derive from real burns.
 */
const crypto = require('crypto');
const G = require('./_grow.js');

const OK_ORIGINS = ['burnchronic.xyz', 'localhost', 'vercel.app'];
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// ── tiny HMAC session token: base64url(wallet|exp).hex(hmac) ──
function secret() { return process.env.SUPABASE_SERVICE_KEY || 'dev-secret'; }
function signToken(wallet) {
  const body = `${wallet}|${Date.now() + TOKEN_TTL_MS}`;
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('hex');
  return `${Buffer.from(body).toString('base64url')}.${mac}`;
}
function verifyToken(token) {
  try {
    const [b64, mac] = String(token || '').split('.');
    if (!b64 || !mac) return null;
    const body = Buffer.from(b64, 'base64url').toString();
    const good = crypto.createHmac('sha256', secret()).update(body).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
    const [wallet, exp] = body.split('|');
    if (Date.now() > Number(exp)) return null;
    return wallet;
  } catch (_) { return null; }
}
function authWallet(req) {
  const h = req.headers.authorization || '';
  return verifyToken(h.replace(/^Bearer\s+/i, ''));
}

const json = (res, code, obj) => { res.status(code).json(obj); };

// total XP (+ player count) for a season — lets the client show each grower's
// pro-rata share of the pool ("pending yield"). Uses the SQL helper if present,
// else falls back to summing scores so it works before grow-yield.sql is run.
async function seasonTotals(seasonId) {
  try {
    const r = await G.sbRpc('grow_season_totals', { p_season_id: seasonId });
    const row = Array.isArray(r) ? r[0] : r;
    if (row && row.total_xp != null) return { totalXp: Number(row.total_xp), players: Number(row.players || 0) };
  } catch (_) { /* function not deployed yet — fall back */ }
  try {
    const rows = await G.sbSelect(`grow_scores?season_id=eq.${seasonId}&select=xp&limit=1000`);
    return { totalXp: rows.reduce((a, x) => a + Number(x.xp || 0), 0), players: rows.length };
  } catch (_) { return { totalXp: 0, players: 0 }; }
}

// the SOL yield pool = pool wallet's SOL minus a gas reserve (distributed
// pro-rata by XP at settle). Cached briefly so we don't RPC on every request.
let _solPool = { t: 0, v: 0 };
async function solYieldPool() {
  if (Date.now() - _solPool.t < 20000) return _solPool.v;
  const w = process.env.GROW_YIELD_WALLET || G.POOL_WALLET;
  const reserve = parseFloat(process.env.GROW_YIELD_RESERVE_SOL || '0.1');
  let sol = 0;
  if (w) {
    try {
      const r = await G.solRpc('getBalance', [w]);
      const lamports = (r && typeof r === 'object' && r.value != null) ? r.value : (typeof r === 'number' ? r : 0);
      sol = Math.max(0, lamports / 1e9 - reserve);
    } catch (_) { sol = 0; }
  }
  _solPool = { t: Date.now(), v: sol };
  return sol;
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
}

// derived player view (water-aware ripeness per plot)
function decorate(player) {
  const lvl = player.lvl || {};
  const plots = (player.plots || []).map((p) => {
    const st = G.plotState(p, lvl);
    return { strain: p.strain, at: p.at, waters: st.waters, growMs: st.gt, ripe: st.ripe, xp: st.xp };
  });
  return { wallet: player.wallet, lvl, seeds: player.seeds || {}, plots,
    nugs: player.nugs || [], nfts: player.nfts || [] };
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type,authorization');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const o = req.headers.origin || req.headers.referer || '';
  if (o && !OK_ORIGINS.some((d) => o.includes(d))) return json(res, 403, { error: 'forbidden origin' });
  if (!G.sbEnabled()) return json(res, 500, { error: 'backend not configured' });

  const body = req.method === 'POST' ? await readBody(req) : {};
  const action = (req.query.action || body.action || '').toString();

  try {
    // ── public: client config (mint, pool, catalog) ────────────────────
    if (action === 'config') {
      return json(res, 200, {
        mint: G.MINT, decimals: G.DECIMALS, poolWallet: G.POOL_WALLET,
        rpcProxy: '/api/solrpc', burnBps: G.BURN_BPS, poolBps: G.POOL_BPS,
        seeds: G.SEEDS, upgrades: G.UPGRADES,
        water: { max: G.MAX_WATERS, pct: G.WATER_PCT, cooldown: G.WATER_COOLDOWN_MS },
        quality: G.QUALITY, marketFeeBps: G.MARKET_FEE_BPS,
        ready: Boolean(G.POOL_WALLET),
      });
    }

    // ── public: browse market listings ─────────────────────────────────
    if (action === 'listings') {
      const limit = Math.min(100, parseInt(req.query.limit || '50', 10) || 50);
      const rows = await G.sbSelect(
        `grow_listings?status=eq.active&select=id,seller,kind,item,price,created_at&order=created_at.desc&limit=${limit}`);
      return json(res, 200, { listings: rows });
    }

    // ── public: season + leaderboard ───────────────────────────────────
    if (action === 'season' || action === 'leaderboard') {
      const s = await G.sbRpc('grow_current_season', {});
      const season = Array.isArray(s) ? s[0] : s;
      const totals = await seasonTotals(season.id);
      const out = {
        season: season.id,
        endsAt: season.ends_at,
        poolBase: season.pool_base,
        poolWhole: Math.floor(Number(season.pool_base) / Math.pow(10, G.DECIMALS)),
        totalXp: totals.totalXp,
        players: totals.players,
        solPool: await solYieldPool(),
      };
      if (action === 'leaderboard') {
        const limit = Math.min(100, parseInt(req.query.limit || '25', 10) || 25);
        const rows = await G.sbSelect(
          `grow_scores?season_id=eq.${season.id}&select=wallet,xp&order=xp.desc&limit=${limit}`);
        out.board = rows.map((r, i) => ({ rank: i + 1, wallet: r.wallet, xp: Number(r.xp) }));
        // last settled season's winners, to show the loop closing
        const won = await G.sbSelect(
          'grow_seasons?settled=eq.true&order=id.desc&limit=1&select=id,winners,settled_at');
        if (won.length && Array.isArray(won[0].winners) && won[0].winners.length) {
          out.lastWinners = won[0].winners.map((w) => ({
            wallet: w.wallet, xp: Number(w.xp),
            whole: Math.floor(Number(w.amount_base) / Math.pow(10, G.DECIMALS)),
          }));
        }
      }
      return json(res, 200, out);
    }

    // ── login step 1: nonce ────────────────────────────────────────────
    if (action === 'nonce') {
      const wallet = (req.query.wallet || '').toString();
      if (!G.isPubkey(wallet)) return json(res, 400, { error: 'bad wallet' });
      const nonce = crypto.randomBytes(16).toString('hex');
      await G.sbUpsert('grow_nonces', { wallet, nonce, created_at: new Date().toISOString() }, 'wallet');
      const message = `Sign in to $CHRONIC GROW\nwallet: ${wallet}\nnonce: ${nonce}`;
      return json(res, 200, { message });
    }

    // ── login step 2: verify signature ─────────────────────────────────
    if (action === 'login') {
      const { wallet, signature } = body;
      if (!G.isPubkey(wallet) || !signature) return json(res, 400, { error: 'bad input' });
      const rows = await G.sbSelect(`grow_nonces?wallet=eq.${wallet}&select=nonce,created_at`);
      if (!rows.length) return json(res, 400, { error: 'no nonce — request one first' });
      if (Date.now() - new Date(rows[0].created_at).getTime() > 5 * 60 * 1000)
        return json(res, 400, { error: 'nonce expired' });
      const message = `Sign in to $CHRONIC GROW\nwallet: ${wallet}\nnonce: ${rows[0].nonce}`;
      if (!G.verifySignature(wallet, message, signature)) return json(res, 401, { error: 'bad signature' });
      await G.sbUpsert('grow_players', { wallet }, 'wallet'); // ensure row exists
      return json(res, 200, { token: signToken(wallet) });
    }

    // ── everything below requires a session ────────────────────────────
    const wallet = authWallet(req);
    if (!wallet) return json(res, 401, { error: 'not authenticated' });

    async function loadPlayer() {
      const rows = await G.sbSelect(
        `grow_players?wallet=eq.${wallet}&select=wallet,lvl,seeds,plots,nugs,nfts`);
      return rows[0] || { wallet, lvl: {}, seeds: {}, plots: [], nugs: [], nfts: [] };
    }
    async function myXp(seasonId) {
      const rows = await G.sbSelect(
        `grow_scores?season_id=eq.${seasonId}&wallet=eq.${wallet}&select=xp`);
      return rows.length ? Number(rows[0].xp) : 0;
    }

    if (action === 'state') {
      const s = await G.sbRpc('grow_current_season', {});
      const season = Array.isArray(s) ? s[0] : s;
      const player = await loadPlayer();
      const totals = await seasonTotals(season.id);
      return json(res, 200, {
        player: decorate(player),
        season: { id: season.id, endsAt: season.ends_at,
                  poolWhole: Math.floor(Number(season.pool_base) / Math.pow(10, G.DECIMALS)),
                  totalXp: totals.totalXp, players: totals.players,
                  solPool: await solYieldPool() },
        xp: await myXp(season.id),
      });
    }

    if (action === 'buy') {
      const { sig, kind, item } = body;
      if (!sig || !kind || !item) return json(res, 400, { error: 'missing sig/kind/item' });

      // resolve the expected price from the catalog (server-authoritative)
      let costWhole;
      if (kind === 'seed') {
        const seed = G.SEEDS[item]; if (!seed) return json(res, 400, { error: 'unknown seed' });
        costWhole = seed.cost;
      } else if (kind === 'upgrade') {
        const u = G.UPGRADES[item]; if (!u) return json(res, 400, { error: 'unknown upgrade' });
        const player = await loadPlayer();
        const lvl = (player.lvl && player.lvl[item]) || 0;
        if (lvl >= u.max) return json(res, 400, { error: 'upgrade maxed' });
        costWhole = G.upgradeCost(item, lvl);
      } else return json(res, 400, { error: 'bad kind' });

      const totalBase = G.base(costWhole);
      const v = await G.verifyBuyTx(sig, wallet, totalBase);
      if (!v.ok) return json(res, 400, { error: 'tx invalid', reason: v.reason });

      const { burn, pool } = G.splitOf(totalBase);
      const r = await G.sbRpc('grow_record_buy', {
        p_wallet: wallet, p_sig: sig, p_kind: kind, p_item: item,
        p_amount: totalBase.toString(), p_burn: burn.toString(), p_pool: pool.toString(),
      });
      if (!r || r.ok === false) return json(res, 400, { error: 'record failed', reason: r && r.reason });
      const player = await loadPlayer();
      return json(res, 200, { ok: true, dupe: !!r.dupe, player: decorate(player) });
    }

    if (action === 'plant') {
      const strain = (body.strain || '').toString();
      if (!G.SEEDS[strain]) return json(res, 400, { error: 'unknown strain' });
      const r = await G.sbRpc('grow_plant', { p_wallet: wallet, p_strain: strain });
      if (!r || r.ok === false) return json(res, 400, { error: r && r.reason || 'plant failed' });
      return json(res, 200, { ok: true, player: decorate(await loadPlayer()) });
    }

    if (action === 'water') {
      const idx = parseInt(body.idx, 10);
      if (!(idx >= 0)) return json(res, 400, { error: 'bad idx' });
      const r = await G.sbRpc('grow_water', {
        p_wallet: wallet, p_idx: idx, p_max: G.MAX_WATERS, p_cd: G.WATER_COOLDOWN_MS });
      if (!r || r.ok === false) return json(res, 400, { error: (r && r.reason) || 'water failed' });
      return json(res, 200, { ok: true, waters: r.waters, player: decorate(await loadPlayer()) });
    }

    if (action === 'sell') {
      const idx = parseInt(body.idx, 10);
      if (!(idx >= 0)) return json(res, 400, { error: 'bad idx' });
      const player = await loadPlayer();
      const plot = (player.plots || [])[idx];
      if (!plot) return json(res, 400, { error: 'no plot' });
      if (!G.SEEDS[plot.strain]) return json(res, 400, { error: 'bad plot' });
      const st = G.plotState(plot, player.lvl);
      if (!st.ripe) return json(res, 400, { error: 'not ripe' });
      const q = G.rollQuality();
      const xp = Math.max(1, Math.round(st.xp * q.mult));
      const r = await G.sbRpc('grow_sell', { p_wallet: wallet, p_idx: idx, p_xp: xp });
      if (!r || r.ok === false) return json(res, 400, { error: (r && r.reason) || 'sell failed' });
      // harvest drop: a tradeable nug, + a rare strain NFT on an exotic×exotic pop
      const nug = { id: crypto.randomUUID(), strain: plot.strain, quality: q.name };
      let nft = null;
      if (plot.strain === 'exotic' && q.name === 'exotic') {
        nft = { id: crypto.randomUUID(), strain: plot.strain, serial: Date.now().toString(36).toUpperCase() };
      }
      await G.sbRpc('grow_add_drop', { p_wallet: wallet, p_nug: nug, p_nft: nft });
      return json(res, 200, { ok: true, xpAdded: xp, quality: q.name, mult: q.mult, nft: !!nft, player: decorate(await loadPlayer()) });
    }

    // ── market: list / delist / reserve / buy ──────────────────────────
    if (action === 'market_list') {
      const { kind, iid } = body; const price = Math.floor(Number(body.price));
      if (!['seed', 'nug', 'nft'].includes(kind) || !iid) return json(res, 400, { error: 'bad item' });
      if (!(price >= 1)) return json(res, 400, { error: 'bad price' });
      const r = await G.sbRpc('grow_market_list', { p_wallet: wallet, p_kind: kind, p_iid: String(iid), p_price: price });
      if (!r || r.ok === false) return json(res, 400, { error: (r && r.reason) || 'list failed' });
      return json(res, 200, { ok: true, player: decorate(await loadPlayer()) });
    }

    if (action === 'market_delist') {
      const id = parseInt(body.id, 10); if (!(id >= 0)) return json(res, 400, { error: 'bad id' });
      const r = await G.sbRpc('grow_market_delist', { p_wallet: wallet, p_id: id });
      if (!r || r.ok === false) return json(res, 400, { error: (r && r.reason) || 'delist failed' });
      return json(res, 200, { ok: true, player: decorate(await loadPlayer()) });
    }

    if (action === 'market_reserve') {
      const id = parseInt(body.id, 10); if (!(id >= 0)) return json(res, 400, { error: 'bad id' });
      const r = await G.sbRpc('grow_market_reserve', { p_buyer: wallet, p_id: id });
      if (!r || r.ok === false) return json(res, 400, { error: (r && r.reason) || 'reserve failed' });
      const fee = Math.floor(Number(r.price) * G.MARKET_FEE_BPS / 10000);
      return json(res, 200, { ok: true, seller: r.seller, price: Number(r.price), burnFee: fee, toSeller: Number(r.price) - fee });
    }

    if (action === 'market_buy') {
      const id = parseInt(body.id, 10); const sig = body.sig;
      if (!(id >= 0) || !sig) return json(res, 400, { error: 'missing id/sig' });
      const rows = await G.sbSelect(`grow_listings?id=eq.${id}&select=seller,price,status,buyer`);
      const l = rows[0];
      if (!l) return json(res, 400, { error: 'no listing' });
      if (l.status !== 'reserved' || l.buyer !== wallet) return json(res, 400, { error: 'not reserved by you' });
      const v = await G.verifyMarketTx(sig, wallet, l.seller, G.base(l.price));
      if (!v.ok) return json(res, 400, { error: 'payment invalid', reason: v.reason });
      const r = await G.sbRpc('grow_market_complete', { p_buyer: wallet, p_id: id, p_sig: sig });
      if (!r || r.ok === false) return json(res, 400, { error: (r && r.reason) || 'buy failed' });
      return json(res, 200, { ok: true, player: decorate(await loadPlayer()) });
    }

    return json(res, 400, { error: 'unknown action' });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
};
