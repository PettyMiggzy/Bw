/* growcore.js — shared $CHRONIC grow economy (used by grow.html 2D + farm3d 3D).
 * Same backend (/api/grow), same token, same 60% burn / 40% weekly-pool buys,
 * same XP→pool payout. Headless: no DOM. Host pages provide toast/onChange.
 *
 * Rules (per design):
 *  - Price floor: nothing costs less than 100K $CHRONIC.
 *  - New plot costs 1M $CHRONIC (flat).
 *  - A wilted plot must be CLEANED for 100K $CHRONIC before replanting.
 *  - Every buy (seed / upgrade / plot / clean) burns 60% and sends 40% to the pool.
 */
(function (global) {
  'use strict';

  var API = '/api/grow';
  var FLOOR = 100000;         // nothing under 100K $CHRONIC
  var CLEAN_COST = 100000;    // clean a wilted plot
  var PLOT_COST = 1000000;    // 1M per new plot (flat)
  var MAXPLOTS = 12, STARTPLOTS = 1, SEASON_MS = 7 * 24 * 60 * 60 * 1000;
  var WATER_MAX = 5, WATER_PCT = 0.10, WATER_CD = 5000;

  // catalog defaults (overwritten by /api/grow?action=config, then floored)
  var SEEDS = {
    // slow base grow — grow-light + watering + nutrients are what speed it up
    mids:  { nm: 'Mids',   rar: 'mids',   cost: 100000,  grow: 90000,  xp: 50,   ds: 'cheap & quick' },
    loud:  { nm: 'Loud',   rar: 'loud',   cost: 250000,  grow: 210000, xp: 300,  ds: 'solid mid-shelf' },
    gas:   { nm: 'Gas',    rar: 'gas',    cost: 1000000, grow: 420000, xp: 1400, ds: 'top-shelf fire' },
    exotic:{ nm: 'Exotic', rar: 'exotic', cost: 5000000, grow: 720000, xp: 8000, ds: 'rare loud, max XP' }
  };
  var SEED_ORDER = ['mids', 'loud', 'gas', 'exotic'];
  var UPS = [
    { k: 'light', nm: 'GROW LIGHT',  ds: 'grow 15% faster',   base: 150000,  mul: 1.9,  max: 8 },
    { k: 'nutes', nm: 'NUTRIENTS',   ds: '+40% XP / sale',    base: 200000,  mul: 1.85, max: 10 },
    { k: 'plot',  nm: 'NEW PLOT',    ds: 'open another plot', base: PLOT_COST, mul: 1,  max: 8 },
    { k: 'auto',  nm: 'AUTO-TENDER', ds: 'auto-sells ripe',   base: 3000000, mul: 1,    max: 1 }
  ];
  var QUALITY = [{ name: 'common', mult: 1, w: 65 }, { name: 'fire', mult: 1.6, w: 25 }, { name: 'exotic', mult: 2.5, w: 10 }];
  var CFG = { mint: 'J5vR9wAwQEx29KNwSnv5hUx9gDyNeRZZE9XDEQeBpump', decimals: 6, poolOwner: '', rpcProxy: '/api/solrpc', ready: false };

  // ---- runtime state ----
  var MODE = 'demo';
  var DEMO_BANK = 50000000;
  var DEMO_DEF = { on: true, bal: DEMO_BANK, xp: 0, seeds: {}, lvl: { light: 0, nutes: 0, plot: 0, auto: 0 }, plots: [], seasonEnd: 0 };
  var D = null;
  var LIVE = { token: null, wallet: null, lvl: {}, seeds: {}, plots: [], xp: 0, poolWhole: 0, totalXp: 0, solPool: 0, endsAt: null, board: null, balance: null, lastWinners: null };
  var PUB = { poolWhole: 0, totalXp: 0, solPool: 0, endsAt: Date.now() + SEASON_MS, board: null, lastWinners: null };

  var HOOK = { toast: function () {}, onChange: function () {} };
  function toast(m, bad) { try { HOOK.toast(m, bad); } catch (e) {} }
  function emit() { try { HOOK.onChange(VM()); } catch (e) {} }

  // ---- demo persistence (own key so 3D plot states never corrupt the 2D save) ----
  function loadDemo() {
    try { D = JSON.parse(localStorage.getItem('cg3d')) || null; } catch (e) { D = null; }
    if (!D) D = JSON.parse(JSON.stringify(DEMO_DEF));
    for (var k in DEMO_DEF) if (typeof D[k] === 'undefined') D[k] = JSON.parse(JSON.stringify(DEMO_DEF[k]));
    if (!D.seasonEnd) D.seasonEnd = Date.now() + SEASON_MS;
    if (D.bal < FLOOR) D.bal = DEMO_BANK;
    if (Date.now() >= D.seasonEnd) { D.xp = 0; D.plots = []; D.seasonEnd = Date.now() + SEASON_MS; }
  }
  function saveDemo() { try { localStorage.setItem('cg3d', JSON.stringify(D)); } catch (e) {} }

  // ---- helpers ----
  function fmt(n) { n = Math.floor(n || 0); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return '' + n; }
  function shortW(w) { return w ? (w.slice(0, 4) + '…' + w.slice(-4)) : ''; }
  function floorCost(c) { return Math.max(FLOOR, Math.round(c || 0)); }
  function upCost(k, lvl) { var u = UPS.filter(function (x) { return x.k === k; })[0]; if (!u) return FLOOR; return floorCost(u.base * Math.pow(u.mul, lvl || 0)); }
  function seedCost(k) { return floorCost((SEEDS[k] || SEEDS.mids).cost); }
  function growMsOf(strain, lvl) { var s = SEEDS[strain] || SEEDS.mids; return Math.round(s.grow * Math.pow(0.85, (lvl && lvl.light) || 0)); }
  function xpOf(strain, lvl) { var s = SEEDS[strain] || SEEDS.mids; return Math.round(s.xp * Math.pow(1.4, (lvl && lvl.nutes) || 0)); }
  function bestOwnedSeed(V) { for (var i = SEED_ORDER.length - 1; i >= 0; i--) { var k = SEED_ORDER[i]; if ((V.seeds[k] || 0) > 0) return k; } return null; }
  function progressOf(p, lvl) { var gt = growMsOf(p.strain, lvl); var w = p.w || 0; return Math.min(1, ((Date.now() - p.at) + gt * WATER_PCT * w) / gt); }
  function plotCount(V) { return STARTPLOTS + ((V.lvl && V.lvl.plot) || 0); }
  function rollQ() { var r = Math.random() * 100, acc = 0; for (var i = 0; i < QUALITY.length; i++) { acc += QUALITY[i].w; if (r < acc) return QUALITY[i]; } return QUALITY[0]; }

  function VM() {
    if (MODE === 'live') {
      return { live: true, connected: true, wallet: LIVE.wallet, balance: LIVE.balance, xp: LIVE.xp,
        poolWhole: LIVE.poolWhole, totalXp: LIVE.totalXp || 0, solPool: LIVE.solPool || 0,
        endsAt: LIVE.endsAt ? new Date(LIVE.endsAt).getTime() : Date.now() + SEASON_MS,
        lvl: LIVE.lvl || {}, seeds: LIVE.seeds || {}, plots: LIVE.plots || [], board: LIVE.board, lastWinners: LIVE.lastWinners };
    }
    return { live: false, connected: true, wallet: null, balance: D.bal, xp: D.xp,
      poolWhole: PUB.poolWhole, totalXp: PUB.totalXp || 0, solPool: PUB.solPool || 0, endsAt: PUB.endsAt,
      lvl: D.lvl, seeds: D.seeds, plots: D.plots, board: PUB.board, lastWinners: PUB.lastWinners };
  }

  // ---- API ----
  function authH() { return LIVE.token ? { authorization: 'Bearer ' + LIVE.token } : {}; }
  function apiGet(action, params) { var q = new URLSearchParams(Object.assign({ action: action }, params || {}));
    return fetch(API + '?' + q.toString(), { headers: authH() }).then(function (r) { return r.json(); }); }
  function apiPost(action, body) { return fetch(API, { method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, authH()),
    body: JSON.stringify(Object.assign({ action: action }, body || {})) }).then(function (r) { return r.json(); }); }

  // ---- chain (Token-2022 burn 60% + pool 40%) ----
  var _w3, _spl;
  function chain() { if (_w3) return Promise.resolve({ w3: _w3, spl: _spl });
    return Promise.all([import('https://esm.sh/@solana/web3.js@1.95.3'), import('https://esm.sh/@solana/spl-token@0.4.8')])
      .then(function (m) { _w3 = m[0]; _spl = m[1]; return { w3: _w3, spl: _spl }; }); }
  function conn(w3) { return new w3.Connection(location.origin + (CFG.rpcProxy || '/api/solrpc'), 'confirmed'); }
  function getProvider() { var p = (window.phantom && window.phantom.solana) || window.solana; return (p && p.isPhantom) ? p : null; }
  function isMobile() { var ua = navigator.userAgent || ''; return /android|iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); }

  function fetchBalance() {
    return chain().then(function (c) {
      var owner = new c.w3.PublicKey(LIVE.wallet), mint = new c.w3.PublicKey(CFG.mint);
      var ata = c.spl.getAssociatedTokenAddressSync(mint, owner, false, c.spl.TOKEN_2022_PROGRAM_ID);
      return conn(c.w3).getTokenAccountBalance(ata).then(function (b) { return Math.floor(Number((b.value && b.value.uiAmount) || 0)); });
    }).catch(function () { return 0; });
  }
  function confirmSig(c, sig) {
    var tries = 0;
    return new Promise(function (resolve, reject) {
      (function poll() {
        conn(c.w3).getSignatureStatuses([sig]).then(function (st) {
          var s = st && st.value && st.value[0];
          if (s) { if (s.err) return reject(new Error('tx failed on-chain'));
            if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return resolve(true); }
          if (++tries >= 30) return resolve(false);
          setTimeout(poll, 1500);
        }).catch(function () { if (++tries >= 30) return resolve(false); setTimeout(poll, 1500); });
      })();
    });
  }
  // build + send the burn(60%)+pool(40%) tx, then have the server verify it
  function buyOnChain(costWhole, kind, item) {
    if (!CFG.ready || !CFG.poolOwner) { toast('on-chain buys not live yet', true); return Promise.resolve(false); }
    var prov = getProvider();
    if (!prov) { toast('wallet not found', true); return Promise.resolve(false); }
    toast('building burn… approve in wallet');
    return chain().then(function (c) {
      var owner = new c.w3.PublicKey(LIVE.wallet), mint = new c.w3.PublicKey(CFG.mint), poolOwner = new c.w3.PublicKey(CFG.poolOwner);
      var T22 = c.spl.TOKEN_2022_PROGRAM_ID;
      var fromAta = c.spl.getAssociatedTokenAddressSync(mint, owner, false, T22);
      var poolAta = c.spl.getAssociatedTokenAddressSync(mint, poolOwner, false, T22);
      var total = BigInt(Math.round(costWhole)) * (10n ** BigInt(CFG.decimals));
      var burn = total * 50n / 100n, poolAmt = total - burn; // 50% burned, 50% to the pool wallet (server credits 40% to winners, keeps 10% as treasury)
      var ixC = c.spl.createAssociatedTokenAccountIdempotentInstruction(owner, poolAta, poolOwner, mint, T22);
      var ixB = c.spl.createBurnCheckedInstruction(fromAta, mint, owner, burn, CFG.decimals, [], T22);
      var ixT = c.spl.createTransferCheckedInstruction(fromAta, mint, poolAta, owner, poolAmt, CFG.decimals, [], T22);
      var tx = new c.w3.Transaction().add(ixC, ixB, ixT); tx.feePayer = owner;
      return conn(c.w3).getLatestBlockhash().then(function (bh) {
        tx.recentBlockhash = bh.blockhash;
        var send = prov.signAndSendTransaction ? prov.signAndSendTransaction(tx).then(function (s) { return s.signature || s; })
          : prov.signTransaction(tx).then(function (signed) { return conn(c.w3).sendRawTransaction(signed.serialize()); });
        return send.then(function (sig) {
          toast('burning on-chain…');
          return confirmSig(c, sig).then(function () {
            return apiPost('buy', { sig: sig, kind: kind, item: item }).then(function (res) {
              if (res.error) { toast('rejected: ' + (res.reason || res.error), true); return false; }
              if (res.player) applyPlayer(res.player);
              return fetchBalance().then(function (b) { LIVE.balance = b; return refreshSeason().then(function () { emit(); return true; }); });
            });
          });
        });
      });
    }).catch(function (e) { toast((e && e.message && /User rejected|reject/i.test(e.message)) ? 'cancelled' : 'buy failed: ' + (e && e.message || e), true); return false; });
  }

  // ---- live sync ----
  function applyPlayer(p) { LIVE.lvl = p.lvl || {}; LIVE.seeds = p.seeds || {};
    LIVE.plots = (p.plots || []).map(function (x) { return { strain: x.strain, at: x.at, w: x.waters || 0 }; }); }
  function refreshState() {
    return apiGet('state').then(function (st) {
      if (st.error) { if (/auth/i.test(st.error)) { logout(); toast('session expired — reconnect', true); } return; }
      applyPlayer(st.player); LIVE.xp = st.xp; LIVE.poolWhole = st.season.poolWhole; LIVE.endsAt = st.season.endsAt;
      LIVE.totalXp = st.season.totalXp || 0; LIVE.solPool = st.season.solPool || 0;
    });
  }
  function refreshSeason() {
    return apiGet('leaderboard', { limit: 25 }).then(function (lb) {
      if (lb.error) return;
      LIVE.poolWhole = lb.poolWhole; LIVE.endsAt = lb.endsAt; LIVE.totalXp = lb.totalXp || 0; LIVE.solPool = lb.solPool || 0; LIVE.lastWinners = lb.lastWinners || null;
      LIVE.board = (lb.board || []).map(function (r) { return { who: shortW(r.wallet), xp: r.xp, you: r.wallet === LIVE.wallet }; });
    }).catch(function () {});
  }
  function refreshPublic() {
    return apiGet('leaderboard', { limit: 25 }).then(function (lb) {
      if (lb && !lb.error) { PUB.poolWhole = lb.poolWhole || 0; PUB.totalXp = lb.totalXp || 0; PUB.solPool = lb.solPool || 0;
        if (lb.endsAt) PUB.endsAt = new Date(lb.endsAt).getTime(); PUB.lastWinners = lb.lastWinners || null;
        PUB.board = (lb.board || []).map(function (r) { return { who: shortW(r.wallet), xp: r.xp, you: false }; }); }
    }).catch(function () {});
  }

  // ---- connect / login ----
  function connect() {
    var prov = getProvider();
    if (!prov) {
      if (isMobile()) { toast('opening in Phantom…');
        var tgt = location.href.replace('://burnchronic.xyz/', '://www.burnchronic.xyz/');
        var rf = location.origin.replace('://burnchronic.xyz', '://www.burnchronic.xyz');
        location.href = 'https://phantom.app/ul/browse/' + encodeURIComponent(tgt) + '?ref=' + encodeURIComponent(rf); return Promise.resolve(); }
      toast('Phantom not found — install it or play demo', true); return Promise.resolve();
    }
    if (!CFG.ready) { toast('on-chain not live yet — play demo', true); return Promise.resolve(); }
    return prov.connect().then(function (resp) {
      var wallet = resp.publicKey.toString();
      return apiGet('nonce', { wallet: wallet }).then(function (n) {
        if (n.error) { toast('login failed: ' + n.error, true); return; }
        return prov.signMessage(new TextEncoder().encode(n.message), 'utf8').then(function (sg) {
          var bytes = sg.signature || sg; var b64 = btoa(String.fromCharCode.apply(null, bytes));
          return apiPost('login', { wallet: wallet, signature: b64 }).then(function (lg) {
            if (lg.error || !lg.token) { toast('login failed: ' + (lg.error || 'no token'), true); return; }
            LIVE.token = lg.token; LIVE.wallet = wallet; MODE = 'live'; emit(); toast('connected — go burn');
            return refreshState().then(fetchBalance).then(function (b) { LIVE.balance = b; }).then(refreshSeason).then(emit);
          });
        });
      });
    }).catch(function (e) { toast((e && /reject/i.test(e.message)) ? 'cancelled' : 'connect failed', true); });
  }
  function logout() { MODE = 'demo'; LIVE.token = null; LIVE.wallet = null; LIVE.board = null;
    try { var p = window.solana; if (p && p.disconnect) p.disconnect(); } catch (e) {} emit(); }

  // ---- actions (route by MODE) ----  each returns a Promise<bool ok>
  function buySeed(strain) {
    var cost = seedCost(strain);
    if (MODE === 'live') return buyOnChain(cost, 'seed', strain);
    if (D.bal < cost) { D.bal = DEMO_BANK; toast('demo wallet topped up'); }
    D.bal -= cost; D.seeds[strain] = (D.seeds[strain] || 0) + 1; saveDemo(); emit();
    toast('bought ' + SEEDS[strain].nm + ' — plant it'); return Promise.resolve(true);
  }
  function buyUp(k) {
    var lvl = (VM().lvl[k]) || 0; var u = UPS.filter(function (x) { return x.k === k; })[0];
    if (!u || lvl >= u.max) { toast('maxed out'); return Promise.resolve(false); }
    var cost = upCost(k, lvl);
    if (MODE === 'live') return buyOnChain(cost, 'upgrade', k);
    if (D.bal < cost) { D.bal = DEMO_BANK; toast('demo wallet topped up'); }
    D.bal -= cost; D.lvl[k] = lvl + 1; saveDemo(); emit(); toast(u.nm + ' up!'); return Promise.resolve(true);
  }
  // plant a specific strain (must own it) into the given plot index
  function plant(strain) {
    var V = VM();
    if (!strain || !(V.seeds[strain] > 0)) { toast('buy a ' + ((SEEDS[strain] && SEEDS[strain].nm) || 'seed') + ' first', true); return Promise.resolve(false); }
    if (MODE === 'live') return apiPost('plant', { strain: strain }).then(function (r) { if (r.error) { toast(r.error, true); return false; } applyPlayer(r.player); emit(); return true; });
    D.seeds[strain] = (D.seeds[strain] || 0) - 1; D.plots.push({ strain: strain, at: Date.now(), w: 0 }); saveDemo(); emit(); return Promise.resolve(true);
  }
  function water(i) {
    var V = VM(); var p = V.plots[i]; if (!p) return Promise.resolve(false);
    if ((p.w || 0) >= WATER_MAX) { toast('fully watered'); return Promise.resolve(false); }
    var now = Date.now(); if (now - (p.lw || 0) < WATER_CD) { toast('let it soak…'); return Promise.resolve(false); }
    if (MODE === 'live') return apiPost('water', { idx: i }).then(function (res) { if (res.error) { toast(res.error === 'cooldown' ? 'let it soak…' : res.error, true); return false; } applyPlayer(res.player); emit(); return true; });
    p.w = (p.w || 0) + 1; p.lw = now; saveDemo(); emit(); return Promise.resolve(true);
  }
  function sell(i) {
    var V = VM(); var p = V.plots[i]; if (!p) return Promise.resolve(null);
    if (MODE === 'live') return apiPost('sell', { idx: i }).then(function (res) { if (res.error) { toast(res.error === 'not ripe' ? 'still growing…' : res.error, true); return null; } applyPlayer(res.player); LIVE.xp += res.xpAdded; return refreshSeason().then(function () { emit(); return { xp: res.xpAdded, quality: res.quality }; }); });
    var q = rollQ(); var gain = Math.max(1, Math.round(xpOf(p.strain, D.lvl) * q.mult)); D.plots.splice(i, 1); D.xp += gain; saveDemo(); emit();
    return Promise.resolve({ xp: gain, quality: q.name });
  }
  // pay to clean a wilted plot (removes the dead plant at index i)
  function clean(i) {
    if (MODE === 'live') return buyOnChain(CLEAN_COST, 'clean', String(i)).then(function (ok) {
      if (ok) { apiPost('clean', { idx: i }).then(function (r) { if (r && r.player) applyPlayer(r.player); emit(); }); } return ok; });
    if (D.bal < CLEAN_COST) { D.bal = DEMO_BANK; toast('demo wallet topped up'); }
    D.bal -= CLEAN_COST; if (D.plots[i]) D.plots.splice(i, 1); saveDemo(); emit(); toast('plot cleaned'); return Promise.resolve(true);
  }

  function loadConfig() {
    return apiGet('config').then(function (c) {
      if (c && !c.error) {
        CFG.mint = c.mint || CFG.mint; CFG.decimals = c.decimals || CFG.decimals;
        CFG.poolOwner = c.poolWallet || ''; CFG.rpcProxy = c.rpcProxy || CFG.rpcProxy; CFG.ready = !!c.ready;
        if (c.water) { WATER_MAX = c.water.max || WATER_MAX; WATER_PCT = c.water.pct || WATER_PCT; WATER_CD = c.water.cooldown || WATER_CD; }
        if (c.quality && c.quality.length) QUALITY = c.quality;
        if (c.seeds) for (var k in c.seeds) if (SEEDS[k]) { SEEDS[k].cost = c.seeds[k].cost; SEEDS[k].grow = c.seeds[k].grow; SEEDS[k].xp = c.seeds[k].xp; }
        if (c.upgrades) UPS.forEach(function (u) { if (c.upgrades[u.k]) { u.base = c.upgrades[u.k].base; u.mul = c.upgrades[u.k].mul; u.max = c.upgrades[u.k].max; } });
      }
    }).catch(function () {}).then(function () {
      // enforce design rules regardless of server config
      for (var s in SEEDS) SEEDS[s].cost = floorCost(SEEDS[s].cost);
      var plotU = UPS.filter(function (x) { return x.k === 'plot'; })[0]; if (plotU) { plotU.base = PLOT_COST; plotU.mul = 1; }
      UPS.forEach(function (u) { u.base = floorCost(u.base); });
    });
  }

  function init(hooks) {
    HOOK.toast = (hooks && hooks.toast) || HOOK.toast;
    HOOK.onChange = (hooks && hooks.onChange) || HOOK.onChange;
    loadDemo();
    return loadConfig().then(refreshPublic).then(function () { emit(); return VM(); });
  }

  global.GrowCore = {
    init: init, VM: VM, connect: connect, logout: logout,
    buySeed: buySeed, buyUp: buyUp, plant: plant, water: water, sell: sell, clean: clean,
    refreshSeason: refreshSeason, refreshPublic: refreshPublic,
    // read-only catalog + helpers
    SEEDS: SEEDS, SEED_ORDER: SEED_ORDER, UPS: UPS,
    seedCost: seedCost, upCost: upCost, growMsOf: growMsOf, xpOf: xpOf, progressOf: progressOf,
    plotCount: plotCount, bestOwnedSeed: bestOwnedSeed, fmt: fmt, shortW: shortW,
    consts: { FLOOR: FLOOR, CLEAN_COST: CLEAN_COST, PLOT_COST: PLOT_COST, MAXPLOTS: MAXPLOTS, STARTPLOTS: STARTPLOTS, WATER_MAX: WATER_MAX, SEASON_MS: SEASON_MS },
    isLive: function () { return MODE === 'live'; }
  };
})(window);
