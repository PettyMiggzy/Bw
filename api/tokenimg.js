'use strict';
/*
 * GET /api/tokenimg?ca=<mint> — the token's real PFP from on-chain metadata.
 * DexScreener only has an image if the team paid, so for everything else we read
 * the metadata URI straight off the chain (Token-2022 metadata extension, or the
 * legacy Metaplex metadata account) and pull `image` from the JSON. This is the
 * same image pump.fun shows. Cached in-memory so the board doesn't refetch.
 */
const G = require('./_grow.js');

const META_PROG = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'; // Metaplex Token Metadata
const cache = new Map(); // ca -> { image, t }
const TTL = 6 * 3600 * 1000;       // cache a found image for 6h
const NEG_TTL = 2 * 60 * 1000;     // retry a miss after 2 min (don't cache timeouts long)

// persistent cache in Supabase (survives cold starts, shared across instances)
async function sbGet(ca) {
  try { if (!G.sbEnabled()) return undefined; const rows = await G.sbSelect(`grow_tokenimg?mint=eq.${encodeURIComponent(ca)}&select=image`); if (rows && rows.length) return rows[0].image || null; } catch (_) {}
  return undefined;
}
async function sbPut(ca, image) {
  try { if (G.sbEnabled() && image) await G.sbUpsert('grow_tokenimg', { mint: ca, image, updated_at: new Date().toISOString() }, 'mint'); } catch (_) {}
}

async function fetchJson(uri) {
  const tries = [uri];
  if (uri.indexOf('ipfs.io/ipfs/') >= 0) tries.push(uri.replace('ipfs.io/ipfs/', 'dweb.link/ipfs/'));
  for (const u of tries) {
    try { const ctl = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined; const r = await fetch(u, { signal: ctl }); if (r.ok) return await r.json(); } catch (_) {}
  }
  return null;
}

const ru32 = (b, o) => b.readUInt32LE(o);
// legacy Metaplex Data: key(1)+updateAuth(32)+mint(32) then borsh strings name,symbol,uri
function parseMetaplexUri(b) {
  try { let o = 1 + 32 + 32; const nl = ru32(b, o); o += 4 + nl; const sl = ru32(b, o); o += 4 + sl; const ul = ru32(b, o); o += 4; return b.slice(o, o + ul).toString('utf8').replace(/\0+$/, '').trim(); } catch (_) { return null; }
}

async function resolveUri(ca) {
  // Token-2022 metadata extension (in the mint account)
  try {
    const mi = await G.solRpc('getAccountInfo', [ca, { encoding: 'jsonParsed' }]);
    const v = mi && mi.value;
    const ext = v && v.data && v.data.parsed && v.data.parsed.info && v.data.parsed.info.extensions;
    if (Array.isArray(ext)) { const md = ext.find((e) => e.extension === 'tokenMetadata'); if (md && md.state && md.state.uri) return md.state.uri; }
  } catch (_) {}
  // legacy Metaplex metadata PDA
  try {
    const web3 = require('@solana/web3.js');
    const [pda] = web3.PublicKey.findProgramAddressSync([Buffer.from('metadata'), new web3.PublicKey(META_PROG).toBuffer(), new web3.PublicKey(ca).toBuffer()], new web3.PublicKey(META_PROG));
    const info = await G.solRpc('getAccountInfo', [pda.toBase58(), { encoding: 'base64' }]);
    if (info && info.value && info.value.data) { const uri = parseMetaplexUri(Buffer.from(info.value.data[0], 'base64')); if (uri) return uri; }
  } catch (_) {}
  return null;
}

// pump.fun launches (~90% of new coins) expose the image directly via their API —
// instant + reliable, even for brand-new mints whose on-chain metadata isn't readable yet.
async function pumpImage(ca) {
  try {
    const ctl = AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined;
    const r = await fetch('https://frontend-api-v3.pump.fun/coins/' + encodeURIComponent(ca), {
      signal: ctl, headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    });
    if (r.ok) { const j = await r.json(); if (j && j.image_uri) return j.image_uri; }
  } catch (_) {}
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, max-age=21600'); // 6h browser/edge cache
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (require('./_guard.js').blocked(req, res)) return;
  const ca = (req.query.ca || '').toString().trim();
  if (!G.isPubkey(ca)) return res.status(400).json({ error: 'bad ca' });

  const c = cache.get(ca);
  if (c && Date.now() - c.t < (c.image ? TTL : NEG_TTL)) return res.status(200).json({ image: c.image || null, cached: true });

  // persistent cache (only positive hits are stored)
  const db = await sbGet(ca);
  if (db) { cache.set(ca, { image: db, t: Date.now() }); return res.status(200).json({ image: db, cached: 'db' }); }

  try {
    let image = await pumpImage(ca);          // fast path: pump.fun API (most launches)
    if (!image) {                              // fallback: on-chain metadata -> IPFS json
      const uri = await resolveUri(ca);
      if (uri) { const j = await fetchJson(uri); if (j) image = j.image || (j.properties && j.properties.image) || null; }
    }
    cache.set(ca, { image, t: Date.now() });
    if (image) sbPut(ca, image);
    return res.status(200).json({ image: image || null });
  } catch (e) { return res.status(200).json({ image: null, error: String((e && e.message) || e) }); }
};
