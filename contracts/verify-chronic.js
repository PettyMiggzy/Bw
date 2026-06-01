#!/usr/bin/env node
/*
 * Verify ChronicMint + ChronicMarket on Monad (chain 143) via Sourcify.
 * One Sourcify match covers MonadVision, Socialscan and Monadscan.
 *
 * Usage (after deploy):
 *   node verify-chronic.js <ChronicMint_addr> <ChronicMarket_addr>
 *
 * Needs node 18+ (global fetch) and chronic-std-input.json in this dir.
 * The std input is the exact compile that produced the deployed bytecode,
 * so Sourcify gets a full match (and pulls constructor args from chain).
 */
const fs = require("fs");
const ENDPOINT = process.env.SOURCIFY || "https://sourcify-api-monad.blockvision.org";
const COMPILER = "0.8.26+commit.8a97fa7a";
const CHAIN = 143;
const stdJsonInput = JSON.parse(fs.readFileSync(__dirname + "/chronic-std-input.json", "utf8"));

const targets = [
  { addr: process.argv[2], id: "ChronicMint.sol:ChronicMint" },
  { addr: process.argv[3], id: "ChronicMarket.sol:ChronicMarket" },
];

async function verify(t) {
  if (!t.addr) { console.log(`skip ${t.id} (no address)`); return; }
  const url = `${ENDPOINT}/v2/verify/${CHAIN}/${t.addr}`;
  const body = JSON.stringify({ stdJsonInput, compilerVersion: COMPILER, contractIdentifier: t.id });
  console.log(`\nVerifying ${t.id} @ ${t.addr} ...`);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const txt = await r.text();
    console.log(`  HTTP ${r.status}: ${txt.slice(0, 400)}`);
  } catch (e) { console.log("  ERROR:", e.message); }
}

(async () => { for (const t of targets) await verify(t); })();
