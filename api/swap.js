'use strict';
/*
 * /api/swap — generic Jupiter swap builder for the Chronic Terminal.
 * POST { account, inputMint, outputMint, amount }  (amount = base units of inputMint, string)
 * -> { transaction (base64 versioned), outAmount, inAmount, fee }
 *
 * 1% platform fee, collected in SOL:
 *   - BUY  (input = SOL):  skim 1% of the SOL to SWAP_FEE_WALLET, swap the rest.
 *   - SELL (output = SOL): Jupiter platform fee on the SOL output (needs SWAP_REFERRAL_ACCOUNT).
 * Both paths fall back to a plain swap if fee setup isn't ready, so trades never break.
 */
const G = require('./_grow.js');

const JUP = 'https://lite-api.jup.ag/swap/v1';
const SOL = 'So11111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 500;
const FEE_BPS = parseInt(process.env.SWAP_FEE_BPS || '100', 10);           // 1%
const FEE_WALLET = process.env.SWAP_FEE_WALLET || 'E7Cr2nad1SvBWF8vcGhNW575UVVPdTcgHEqSTMQzoUr5';
const REFERRAL = process.env.SWAP_REFERRAL_ACCOUNT || '4HgJt8K66Nwu6wb8QCj8scojhmtDETCrAHJWZngHXjSE';
const REFERRAL_PROGRAM = 'REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3';

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('content-type', 'application/json');
}
const send = (res, code, obj) => res.status(code).json(obj);
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
}
async function jget(path) { return (await fetch(`${JUP}${path}`)).json(); }
async function jpost(path, body) { return (await fetch(`${JUP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); }

// SELL referral fee account (fee in the SOL output)
function feeAccountFor(mint) {
  if (!REFERRAL || !FEE_BPS) return null;
  try {
    const { PublicKey } = require('@solana/web3.js');
    const [ata] = PublicKey.findProgramAddressSync(
      [Buffer.from('referral_ata'), new PublicKey(REFERRAL).toBuffer(), new PublicKey(mint).toBuffer()],
      new PublicKey(REFERRAL_PROGRAM));
    return ata.toBase58();
  } catch (_) { return null; }
}

// BUY: skim 1% SOL upfront, then swap the rest — one versioned tx
async function buildBuyWithFee(account, outputMint, lamports) {
  const web3 = require('@solana/web3.js');
  const { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction, AddressLookupTableAccount } = web3;
  const fee = (BigInt(lamports) * BigInt(FEE_BPS)) / 10000n;
  const swapLamports = (BigInt(lamports) - fee).toString();
  const qp = new URLSearchParams({ inputMint: SOL, outputMint, amount: swapLamports, slippageBps: String(SLIPPAGE_BPS) });
  const quote = await jget(`/quote?${qp.toString()}`);
  if (!quote || quote.error || !quote.outAmount) return null;
  const si = await jpost('/swap-instructions', { quoteResponse: quote, userPublicKey: account, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true });
  if (!si || !si.swapInstruction) return null;

  const owner = new PublicKey(account);
  const de = (ix) => new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: (ix.accounts || []).map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, 'base64'),
  });
  const feeIx = SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(FEE_WALLET), lamports: Number(fee) });
  const ixs = [
    ...(si.computeBudgetInstructions || []).map(de),
    feeIx,
    ...(si.setupInstructions || []).map(de),
    de(si.swapInstruction),
    ...(si.cleanupInstruction ? [de(si.cleanupInstruction)] : []),
  ];
  // resolve address lookup tables
  let alts = [];
  const addrs = si.addressLookupTableAddresses || [];
  if (addrs.length) {
    const infos = await G.solRpc('getMultipleAccounts', [addrs, { encoding: 'base64' }]);
    (infos.value || []).forEach((acc, i) => {
      if (acc && acc.data) alts.push(new AddressLookupTableAccount({
        key: new PublicKey(addrs[i]),
        state: AddressLookupTableAccount.deserialize(Buffer.from(acc.data[0], 'base64')),
      }));
    });
  }
  const bh = await G.solRpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: bh.value.blockhash, instructions: ixs }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  return { transaction: Buffer.from(tx.serialize()).toString('base64'), outAmount: quote.outAmount, inAmount: lamports, fee: FEE_BPS };
}

// plain or referral-fee Jupiter swap (used for sells + fallback)
async function buildSwap(account, inputMint, outputMint, amount, withFee) {
  const qp = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: String(SLIPPAGE_BPS) });
  let feeAccount = null;
  if (withFee) { feeAccount = feeAccountFor(outputMint); if (feeAccount) qp.set('platformFeeBps', String(FEE_BPS)); }
  const quote = await jget(`/quote?${qp.toString()}`);
  if (!quote || quote.error || !quote.outAmount) return { quote: null };
  const body = { quoteResponse: quote, userPublicKey: account, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true };
  if (feeAccount) body.feeAccount = feeAccount;
  const swap = await jpost('/swap', body);
  return { quote, swap, feeApplied: !!feeAccount };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });

  const b = await readBody(req);
  const { account, inputMint, outputMint } = b;
  const amount = String(b.amount || '').replace(/[^0-9]/g, '');
  if (!G.isPubkey(account)) return send(res, 400, { error: 'connect a wallet' });
  if (!G.isPubkey(inputMint) || !G.isPubkey(outputMint)) return send(res, 400, { error: 'bad mints' });
  if (!amount || amount === '0') return send(res, 400, { error: 'bad amount' });

  try {
    // BUY (paying in SOL): skim the 1% in SOL, fall back to plain swap on any hiccup
    if (inputMint === SOL && FEE_BPS > 0) {
      try { const r = await buildBuyWithFee(account, outputMint, amount); if (r) return send(res, 200, r); } catch (_) { /* fall through */ }
    }
    // SELL / other: referral fee on output (SOL on sells), fallback to no fee
    let r = await buildSwap(account, inputMint, outputMint, amount, true);
    if ((!r.swap || !r.swap.swapTransaction)) r = await buildSwap(account, inputMint, outputMint, amount, false);
    if (!r.quote) return send(res, 400, { error: 'no route — try another amount' });
    if (!r.swap || !r.swap.swapTransaction) return send(res, 502, { error: 'swap build failed' });
    return send(res, 200, { transaction: r.swap.swapTransaction, outAmount: r.quote.outAmount, inAmount: r.quote.inAmount, fee: r.feeApplied ? FEE_BPS : 0 });
  } catch (e) {
    return send(res, 502, { error: 'swap failed: ' + ((e && e.message) || e) });
  }
};
