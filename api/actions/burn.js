'use strict';
/*
 * /api/actions/burn — Solana Action ("Blink") to burn $CHRONIC from a tweet/link.
 *
 *   GET   -> the Action card (preset + custom burn amounts)
 *   POST  -> builds an unsigned burn transaction for the user's wallet
 *   POST ?confirm=1 (action-chaining "next") -> after the tx confirms, the client
 *           sends { account, signature }; we verify the burn on-chain and credit
 *           XP toward the $CHRONIC GROW weekly leaderboard.
 *
 * Only @solana/web3.js is used, lazily, inside the POST path (so the GET card
 * never depends on it and any load error surfaces as JSON, not a hard crash).
 * The SPL burnChecked instruction + associated-token address are built by hand.
 */
const G = require('../_grow.js');

const ICON = 'https://www.burnchronic.xyz/assets/og-chronic.jpg';
const SITE = 'https://www.burnchronic.xyz';
const MIN_BURN = 1;
const MAX_BURN = 1e12;
// $CHRONIC is a Token-2022 mint, so the token program (and the ATA seed) must
// be Token-2022, not the legacy SPL Token program.
const TOKEN_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

function fmt(n) { n = Math.floor(n); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'; return '' + n; }

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Action-Version, X-Blockchain-Ids');
  res.setHeader('Access-Control-Expose-Headers', 'X-Action-Version, X-Blockchain-Ids');
  res.setHeader('X-Action-Version', '2.4');
  res.setHeader('X-Blockchain-Ids', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'); // Solana mainnet
  res.setHeader('Content-Type', 'application/json');
}
const send = (res, code, obj) => { res.status(code).json(obj); };

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
}

// build an SPL Token burnChecked transaction by hand (web3.js only)
function buildBurnTx(web3, account, amountWhole, blockhash) {
  const { PublicKey, Transaction, TransactionInstruction } = web3;
  const owner = new PublicKey(account);
  const mint = new PublicKey(G.MINT);
  const tokenProg = new PublicKey(TOKEN_PROGRAM);
  const ataProg = new PublicKey(ATA_PROGRAM);
  const [ata] = PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProg.toBuffer(), mint.toBuffer()], ataProg);
  const amt = BigInt(amountWhole) * (10n ** BigInt(G.DECIMALS));
  const data = Buffer.alloc(10);
  data.writeUInt8(15, 0);            // BurnChecked
  data.writeBigUInt64LE(amt, 1);     // amount
  data.writeUInt8(G.DECIMALS, 9);    // decimals
  const ix = new TransactionInstruction({
    programId: tokenProg,
    keys: [
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = owner;
  tx.recentBlockhash = blockhash;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

// confirm a burn actually happened on-chain for `wallet`
async function verifyBurn(sig, wallet, needBase) {
  const tx = await G.solRpc('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  if (!tx || (tx.meta && tx.meta.err)) return false;
  let burned = 0n;
  const scan = (ixs) => { for (const ix of ixs || []) {
    if ((ix.program === 'spl-token' || ix.program === 'spl-token-2022') && ix.parsed) {
      const t = ix.parsed.type, info = ix.parsed.info || {};
      if ((t === 'burn' || t === 'burnChecked') && info.authority === wallet && (!info.mint || info.mint === G.MINT)) {
        burned += info.tokenAmount ? BigInt(info.tokenAmount.amount) : (info.amount ? BigInt(info.amount) : 0n);
      }
    } } };
  scan(tx.transaction.message.instructions);
  (tx.meta && tx.meta.innerInstructions || []).forEach((g) => scan(g.instructions));
  return burned >= needBase;
}

module.exports = async (req, res) => {
  setHeaders(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // ---- GET: the Action card (no chain deps) ----
  if (req.method === 'GET') {
    const mk = (label, amt) => ({ type: 'transaction', label, href: `/api/actions/burn?amount=${amt}` });
    return send(res, 200, {
      type: 'action',
      icon: ICON,
      title: '🔥 Burn $CHRONIC',
      description: 'Feed the fire — $CHRONIC sent here is gone forever, straight off the supply. Burns also stack XP on the $CHRONIC GROW leaderboard. burn it, don’t hoard it. 💀',
      label: 'Burn $CHRONIC',
      links: { actions: [
        mk('Burn 50K 🔥', 50000),
        mk('Burn 250K 🔥', 250000),
        mk('Burn 1M 🔥', 1000000),
        { type: 'transaction', label: 'Burn 🔥', href: '/api/actions/burn?amount={amount}',
          parameters: [{ name: 'amount', label: 'how much $CHRONIC?', type: 'number', required: true, min: MIN_BURN }] },
      ] },
    });
  }

  if (req.method !== 'POST') return send(res, 405, { message: 'POST only' });

  const body = await readBody(req);
  const account = body.account;
  const amountWhole = Math.floor(Number(req.query.amount));
  if (!(amountWhole >= MIN_BURN) || amountWhole > MAX_BURN) return send(res, 400, { message: 'Enter a valid amount.' });
  if (!account || !G.isPubkey(account)) return send(res, 400, { message: 'Connect a Solana wallet.' });

  // ---- POST ?confirm=1: action-chaining callback (credit XP after confirm) ----
  if (req.query.confirm) {
    const sig = body.signature;
    let xpMsg = '';
    if (sig) {
      try {
        const needBase = G.base(amountWhole);
        if (await verifyBurn(sig, account, needBase) && G.sbEnabled()) {
          const xp = Math.max(1, Math.round(amountWhole / 1000));
          await G.sbRpc('grow_credit_burn', { p_wallet: account, p_sig: sig, p_xp: xp, p_amount: needBase.toString() });
          xpMsg = ` +${fmt(xp)} XP on the GROW leaderboard.`;
        }
      } catch (_) { /* best-effort credit */ }
    }
    return send(res, 200, {
      type: 'completed', icon: ICON, label: 'Burned 🔥',
      title: `🔥 Burned ${fmt(amountWhole)} $CHRONIC`,
      description: `Gone forever — supply only goes down.${xpMsg} Play at ${SITE}/grow`,
    });
  }

  // ---- POST: build the burn transaction (lazy web3 + readable errors) ----
  try {
    const web3 = require('@solana/web3.js');
    // fetch blockhash via our RPC proxy (avoids web3's Connection/websocket path)
    const bh = await G.solRpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const blockhash = bh && bh.value && bh.value.blockhash;
    if (!blockhash) throw new Error('no blockhash');
    const serialized = buildBurnTx(web3, account, amountWhole, blockhash);
    return send(res, 200, {
      type: 'transaction',
      transaction: serialized,
      message: `Burn ${fmt(amountWhole)} $CHRONIC 🔥`,
      links: { next: { type: 'post', href: `/api/actions/burn?confirm=1&amount=${amountWhole}` } },
    });
  } catch (e) {
    return send(res, 500, { message: 'Could not build the burn: ' + ((e && e.message) || e) });
  }
};
