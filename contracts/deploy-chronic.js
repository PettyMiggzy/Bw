#!/usr/bin/env node
/*
 * Deploy ChronicMint + ChronicMarket to Monad mainnet (chainId 143).
 * Canonical droplet flow (no Remix).
 *
 * Usage on the droplet:
 *   PRIVATE_KEY=0x...   node deploy-chronic.js
 *   # or point at a key file:
 *   KEYFILE=/root/.monpad-deployer-key   node deploy-chronic.js
 *
 * Optional:
 *   FEE_RECIPIENT=0x...   (defaults to Chronic dev wallet)
 *
 * Needs: npm i ethers@6   (already present on the droplet)
 * Needs artifacts.json in the same dir (committed alongside this file).
 */
const fs = require("fs");
const { ethers } = require("ethers");

const RPC = "https://rpc.monad.xyz";
const CHAIN_ID = 143n;
const FEE_RECIPIENT =
  process.env.FEE_RECIPIENT || "0xe7a31fd91a6f2ab0c73db3b7d0954a6a3acc7ab5"; // Chronic dev

function loadKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY.trim();
  const f = process.env.KEYFILE || "/root/.monpad-deployer-key";
  return fs.readFileSync(f, "utf8").trim();
}

async function deploy(wallet, art, args, label) {
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  console.log(`\nDeploying ${label} ...`);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ${label}: ${addr}`);
  return addr;
}

(async () => {
  const art = JSON.parse(fs.readFileSync(__dirname + "/artifacts.json", "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID) throw new Error(`wrong chain ${net.chainId}, want ${CHAIN_ID}`);

  const wallet = new ethers.Wallet(loadKey(), provider);
  const bal = await provider.getBalance(wallet.address);
  console.log("Deployer:", wallet.address);
  console.log("Balance :", ethers.formatEther(bal), "MON");
  console.log("Fee recipient:", FEE_RECIPIENT);
  if (bal === 0n) throw new Error("deployer has 0 MON — fund it first");

  const mint = await deploy(wallet, art.ChronicMint, [FEE_RECIPIENT], "ChronicMint");
  const market = await deploy(wallet, art.ChronicMarket, [FEE_RECIPIENT], "ChronicMarket");

  console.log("\n=========== DONE — paste these back ===========");
  console.log(JSON.stringify({ ChronicMint: mint, ChronicMarket: market }, null, 2));
  console.log("\nDefaults baked in: mintFee=0 (free), creatorRoyalty=5%, platformFee=2.5%.");
  console.log("Owner = deployer. Change fees via setMintFee / setPlatformFee if wanted.");
})().catch((e) => { console.error("DEPLOY FAILED:", e.message || e); process.exit(1); });
