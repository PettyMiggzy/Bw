// deploy-rewardsclaim.js — deploy RewardsClaim to Monad mainnet (chain 143)
//
// SETUP (once, in this folder):
//   npm i ethers solc@0.8.26
//   put the audited RewardsClaim.sol next to this file
//
// RUN (PowerShell):
//   $env:PRIVATE_KEY="0x_your_DEPLOYER_key"     # this wallet becomes OWNER
//   $env:SIGNER_ADDRESS="0xc7249e4ff274f0b246652481671a5ce55acd33b9"  # droplet signer (default below)
//   $env:MONAD_RPC="https://your-rpc"           # optional, defaults to public RPC
//   node deploy-rewardsclaim.js
//
// RUN (bash):
//   PRIVATE_KEY=0x... SIGNER_ADDRESS=0xc724... node deploy-rewardsclaim.js

const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

const SRC_FILE   = 'RewardsClaim.sol';
const CONTRACT   = 'RewardsClaim';
const RPC        = process.env.MONAD_RPC || 'https://rpc.monad.xyz';
const CHAIN_ID   = Number(process.env.CHAIN_ID || 143);
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const SIGNER     = process.env.SIGNER_ADDRESS || '0xc7249e4ff274f0b246652481671a5ce55acd33b9'; // droplet signer

async function main() {
  if (!PRIVATE_KEY) throw new Error('Set PRIVATE_KEY (deployer wallet -> becomes owner).');
  if (!ethers.isAddress(SIGNER)) throw new Error('SIGNER_ADDRESS is not a valid address: ' + SIGNER);

  const srcPath = path.resolve(__dirname, SRC_FILE);
  if (!fs.existsSync(srcPath)) throw new Error('Put ' + SRC_FILE + ' next to this script.');
  const source = fs.readFileSync(srcPath, 'utf8');

  // compile the audited source = single source of truth for bytecode + ABI
  const input = {
    language: 'Solidity',
    sources: { [SRC_FILE]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris', // conservative target for Monad EVM-equivalence
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const fatal = (out.errors || []).filter((e) => e.severity === 'error');
  if (fatal.length) { fatal.forEach((e) => console.error(e.formattedMessage)); throw new Error('compile failed'); }
  const art = out.contracts[SRC_FILE][CONTRACT];
  const abi = art.abi;
  const bytecode = '0x' + art.evm.bytecode.object;

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log('— RewardsClaim deploy —');
  console.log('deployer/owner :', wallet.address);
  console.log('signer         :', SIGNER);
  console.log('rpc / chain    :', RPC, '/', CHAIN_ID);
  const bal = await provider.getBalance(wallet.address);
  console.log('deployer MON   :', ethers.formatEther(bal));

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const c = await factory.deploy(SIGNER);
  const tx = c.deploymentTransaction();
  console.log('\ndeploy tx:', tx.hash, '\nwaiting for confirmation…');
  await c.waitForDeployment();
  const addr = await c.getAddress();

  // read back on-chain to confirm
  const live = new ethers.Contract(addr, abi, provider);
  console.log('\n✅ RewardsClaim deployed:', addr);
  console.log('   owner()  :', await live.owner());
  console.log('   signer() :', await live.signer());
  console.log('   paused() :', await live.paused());
  console.log('\nNEXT:');
  console.log('  1) nad.domains -> register rewardsbot.nad with your wallet');
  console.log('  2) Name Manager -> set its resolved address to ' + addr);
  console.log('  3) tell me the address (or just point rewardsbot.nad at it) and I wire the bot + claim page');
}

main().catch((e) => { console.error('\nERROR:', e.message || e); process.exit(1); });
