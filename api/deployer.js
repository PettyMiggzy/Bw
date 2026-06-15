'use strict';
/*
 * GET /api/deployer?address=0x<contract>
 *
 * Deployer fingerprint: contract -> its deployer -> every other contract that
 * deployer has created (chronological). Uses Etherscan V2:
 *   contract/getcontractcreation  (creator + creation tx)
 *   account/txlist                (deployer's txns, filtered to contract creations)
 */

const L = require('./_lib.js');

async function deployerFingerprint(contract) {
  contract = L.lc(contract);

  const creation = (await L.esCall({
    module: 'contract', action: 'getcontractcreation', contractaddresses: contract,
  }))[0];

  if (!creation || !creation.contractCreator) {
    return { contract, deployer: null, note: 'no creation record (EOA, precompile, or unindexed)' };
  }
  const deployer = L.lc(creation.contractCreator);

  // Scan the deployer's transactions for contract-creation txns (to == empty).
  const txs = await L.esCall({
    module: 'account', action: 'txlist', address: deployer,
    page: '1', offset: String(L.PAGE_OFFSET), sort: 'asc',
  });

  const created = [];
  for (const t of txs) {
    const isCreation = (!t.to || t.to === '') && t.contractAddress;
    if (!isCreation) continue;
    created.push({
      address: L.lc(t.contractAddress),
      txHash: t.hash,
      block: Number(t.blockNumber) || null,
      ts: Number(t.timeStamp) || null,
      failed: t.isError === '1',
      isSubject: L.lc(t.contractAddress) === contract,
    });
  }

  return {
    contract,
    deployer,
    creationTx: creation.txHash,
    creationBlock: Number(creation.blockNumber) || null,
    creationTs: Number(creation.timestamp) || null,
    factory: creation.contractFactory || null,
    siblings: created,           // every contract this deployer made (incl. the subject)
    siblingCount: created.length,
    windowed: txs.length >= L.PAGE_OFFSET, // true => deployer busier than our scan window
  };
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (require('./_guard.js').blocked(req, res)) return;

  const address = L.lc((req.query && req.query.address) || '');
  if (!L.isAddress(address)) { res.status(400).json({ error: 'pass ?address=0x… (contract)' }); return; }

  try {
    res.status(200).json(await deployerFingerprint(address));
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};

module.exports.deployerFingerprint = deployerFingerprint;
