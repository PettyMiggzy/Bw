'use strict';
/*
 * /api/actions/plant — Blink to cop a $CHRONIC GROW seed from a tweet/link.
 *   GET   -> card with the four strains
 *   POST  -> buy tx: create pool ATA (idempotent) + burn 60% + pool 40% of the seed price
 *   POST ?confirm=1 -> verify the on-chain buy, grant the seed to the wallet's stash
 *
 * The seed lands in your stash; plant + grow it at burnchronic.xyz/grow.
 * web3.js is lazy-required inside POST; instructions are built by hand
 * (byte-verified against @solana/spl-token).
 */
const G = require('../_grow.js');

const ICON = 'https://www.burnchronic.xyz/assets/og-chronic.jpg';
const SITE = 'https://www.burnchronic.xyz';
// $CHRONIC is a Token-2022 mint — token program + ATA seed must be Token-2022.
const TOKEN_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const NAMES = { mids: 'Mids', loud: 'Loud', gas: 'Gas', exotic: 'Exotic' };

function fmt(n) { n = Math.floor(n); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'; return '' + n; }
function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Action-Version, X-Blockchain-Ids');
  res.setHeader('Access-Control-Expose-Headers', 'X-Action-Version, X-Blockchain-Ids');
  res.setHeader('X-Action-Version', '2.4');
  res.setHeader('X-Blockchain-Ids', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  res.setHeader('Content-Type', 'application/json');
}
const send = (res, code, obj) => { res.status(code).json(obj); };
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
}

function buildBuyTx(web3, account, totalBase, blockhash) {
  const { PublicKey, Transaction, TransactionInstruction, SystemProgram } = web3;
  const owner = new PublicKey(account);
  const mint = new PublicKey(G.MINT);
  const poolOwner = new PublicKey(G.POOL_WALLET);
  const tokenProg = new PublicKey(TOKEN_PROGRAM);
  const ataProg = new PublicKey(ATA_PROGRAM);
  const ata = (m, o) => PublicKey.findProgramAddressSync([o.toBuffer(), tokenProg.toBuffer(), m.toBuffer()], ataProg)[0];
  const fromAta = ata(mint, owner);
  const poolAta = ata(mint, poolOwner);

  const total = BigInt(totalBase);
  const burn = (total * 60n) / 100n;
  const pool = total - burn;

  // 1) create pool ATA if missing (idempotent, payer = buyer)
  const ixCreate = new TransactionInstruction({
    programId: ataProg,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: poolAta, isSigner: false, isWritable: true },
      { pubkey: poolOwner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProg, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  // 2) burn 60%
  const bd = Buffer.alloc(10); bd.writeUInt8(15, 0); bd.writeBigUInt64LE(burn, 1); bd.writeUInt8(G.DECIMALS, 9);
  const ixBurn = new TransactionInstruction({ programId: tokenProg, keys: [
    { pubkey: fromAta, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ], data: bd });
  // 3) transfer 40% to pool
  const td = Buffer.alloc(10); td.writeUInt8(12, 0); td.writeBigUInt64LE(pool, 1); td.writeUInt8(G.DECIMALS, 9);
  const ixXfer = new TransactionInstruction({ programId: tokenProg, keys: [
    { pubkey: fromAta, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: poolAta, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ], data: td });

  const tx = new Transaction().add(ixCreate, ixBurn, ixXfer);
  tx.feePayer = owner;
  tx.recentBlockhash = blockhash;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

module.exports = async (req, res) => {
  setHeaders(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method === 'GET') {
    const mk = (k) => ({ type: 'transaction', label: `${NAMES[k]} — ${fmt(G.SEEDS[k].cost)} 🔥`, href: `/api/actions/plant?strain=${k}` });
    return send(res, 200, {
      type: 'action', icon: ICON,
      title: '🌱 Cop a $CHRONIC seed',
      description: 'Buy a seed straight from here — 60% of the cost burns, 40% feeds the weekly pool. It lands in your stash; plant & grow it at burnchronic.xyz/grow. 💀',
      label: 'Buy seed',
      links: { actions: ['mids', 'loud', 'gas', 'exotic'].map(mk) },
    });
  }
  if (req.method !== 'POST') return send(res, 405, { message: 'POST only' });

  const body = await readBody(req);
  const account = body.account;
  const strain = String(req.query.strain || '');
  const seed = G.SEEDS[strain];
  if (!seed) return send(res, 400, { message: 'Unknown strain.' });
  if (!account || !G.isPubkey(account)) return send(res, 400, { message: 'Connect a Solana wallet.' });
  if (!G.POOL_WALLET) return send(res, 400, { message: 'Pool not configured.' });

  const totalBase = G.base(seed.cost);

  // confirm: verify the buy + grant the seed
  if (req.query.confirm) {
    const sig = body.signature;
    let ok = false;
    if (sig) {
      try {
        const v = await G.verifyBuyTx(sig, account, totalBase);
        if (v.ok && G.sbEnabled()) {
          const burn = (totalBase * 60n) / 100n; const pool = totalBase - burn;
          await G.sbRpc('grow_record_buy', { p_wallet: account, p_sig: sig, p_kind: 'seed', p_item: strain,
            p_amount: totalBase.toString(), p_burn: burn.toString(), p_pool: pool.toString() });
          ok = true;
        }
      } catch (_) { /* best effort */ }
    }
    return send(res, 200, {
      type: 'completed', icon: ICON, label: 'Seed secured 🌱',
      title: ok ? `🌱 Got a ${NAMES[strain]} seed!` : `🌱 ${NAMES[strain]} purchase`,
      description: ok ? `In your stash — plant & grow it at ${SITE}/grow` : `If it doesn't show, plant from ${SITE}/grow`,
    });
  }

  // build the buy tx
  try {
    const web3 = require('@solana/web3.js');
    const bh = await G.solRpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const blockhash = bh && bh.value && bh.value.blockhash;
    if (!blockhash) throw new Error('no blockhash');
    const serialized = buildBuyTx(web3, account, totalBase, blockhash);
    return send(res, 200, {
      type: 'transaction', transaction: serialized,
      message: `Cop a ${NAMES[strain]} seed — burn ${fmt(seed.cost * 0.6)} + ${fmt(seed.cost * 0.4)} to pool`,
      links: { next: { type: 'post', href: `/api/actions/plant?confirm=1&strain=${strain}` } },
    });
  } catch (e) {
    return send(res, 500, { message: 'Could not build the buy: ' + ((e && e.message) || e) });
  }
};
