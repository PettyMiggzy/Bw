'use strict';
/*
 * /api/curve?ca=<mint> — bonding-curve progress for a token (so the terminal
 * shows fill % in-layout, no need to leave). Reads the curve account on-chain
 * and returns { onCurve, progress, complete, solRaised }. Read-only.
 */
const G = require('./_grow.js');

const PROG = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const INIT_REAL_TOKENS = 793100000000000n; // tokens available on the curve at launch

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const ca = (req.query.ca || '').toString().trim();
  if (!G.isPubkey(ca)) return res.status(400).json({ error: 'bad ca' });

  try {
    const { PublicKey } = require('@solana/web3.js');
    const [curve] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(ca).toBuffer()], new PublicKey(PROG));
    const info = await G.solRpc('getAccountInfo', [curve.toBase58(), { encoding: 'base64' }]);
    if (!info || !info.value) return res.status(200).json({ onCurve: false }); // not a curve token / fully migrated
    const data = Buffer.from(info.value.data[0], 'base64');
    // layout: [8 disc][virtTok u64][virtSol u64][realTok u64][realSol u64][totalSupply u64][complete u8]
    const realTok = data.readBigUInt64LE(24);
    const realSol = data.readBigUInt64LE(32);
    const complete = data.readUInt8(48) === 1;
    let progress = complete ? 100 : Number(10000n - (realTok * 10000n) / INIT_REAL_TOKENS) / 100;
    progress = Math.max(0, Math.min(100, progress));
    return res.status(200).json({ onCurve: true, progress: Math.round(progress * 10) / 10, complete, solRaised: Math.round(Number(realSol) / 1e7) / 100 });
  } catch (e) {
    return res.status(200).json({ onCurve: false, error: String((e && e.message) || e) });
  }
};
