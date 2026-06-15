'use strict';
/*
 * POST /api/nft — record a community NFT mint in the gallery, AFTER verifying
 * the mint actually happened on-chain. Replaces the old open anon insert
 * (anyone could spam chronic_nfts). The contract emits
 *   event Minted(uint256 indexed id, address indexed creator, string uri)
 * so we pull token_id + creator straight from that event in the tx receipt —
 * the client can't forge them. Inserts via the service key (RLS now blocks anon
 * inserts). token_id/creator come from chain; name/description/image are the
 * submitter's, but bound to a real mint they paid for.
 *
 * Body: { contract, tx, name, description, image_url, metadata_url }
 * Env: MONAD_RPC, SUPABASE_URL, SUPABASE_SERVICE_KEY
 */
const MONAD_RPC = process.env.MONAD_RPC || 'https://rpc.monad.xyz';
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const MINTED_TOPIC = '0x3b8a974a6971dbe70c8718ec80406b2790d2aa5477b6a5bed3d94fa19e06d60d'; // keccak256("Minted(uint256,address,string)")
const isAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(s || '');
const isTx = (s) => /^0x[a-fA-F0-9]{64}$/.test(s || '');
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
}
async function rpc(method, params) {
  const r = await fetch(MONAD_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  return j.result;
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  // No origin guard here: the on-chain Minted-event check below is the real
  // gate (only genuine mints can be recorded), so the admin mint tool can call
  // this from anywhere.
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'storage not configured' });

  const b = await readBody(req);
  const contract = clip(b.contract, 42).toLowerCase();
  const tx = clip(b.tx, 66);
  if (!isAddr(contract)) return res.status(400).json({ error: 'bad contract' });
  if (!isTx(tx)) return res.status(400).json({ error: 'bad tx' });

  // verify the mint on-chain: receipt success + a Minted log from this contract
  let rcpt;
  try { rcpt = await rpc('eth_getTransactionReceipt', [tx]); } catch (_) { rcpt = null; }
  if (!rcpt) return res.status(400).json({ error: 'tx not found' });
  if (rcpt.status !== '0x1') return res.status(400).json({ error: 'tx failed' });
  const log = (rcpt.logs || []).find((l) =>
    l.address && l.address.toLowerCase() === contract &&
    l.topics && l.topics[0] && l.topics[0].toLowerCase() === MINTED_TOPIC);
  if (!log) return res.status(400).json({ error: 'no mint event in tx' });

  // token_id + creator come from the event, not the client
  const tokenId = BigInt(log.topics[1]).toString();
  const creator = ('0x' + log.topics[2].slice(26)).toLowerCase();

  const row = {
    contract, token_id: tokenId, creator,
    name: clip(b.name, 120) || 'Untitled',
    description: clip(b.description, 600),
    image_url: clip(b.image_url, 400),
    metadata_url: clip(b.metadata_url, 400),
    tx,
  };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/chronic_nfts?on_conflict=contract,token_id`, {
      method: 'POST',
      headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!r.ok && r.status !== 409) {
      const t = await r.text();
      return res.status(502).json({ error: 'save failed', detail: t.slice(0, 160) });
    }
    return res.status(200).json({ ok: true, token_id: tokenId, creator });
  } catch (e) {
    return res.status(502).json({ error: 'save failed: ' + ((e && e.message) || e) });
  }
};
