// $CHRONIC Strains — NFT metadata endpoint
// GET /api/metadata/<tokenId>  ->  ERC721 metadata JSON
// Reads tierOf(tokenId) live from the deployed ChronicStrains contract so
// metadata always reflects on-chain truth (no DB to drift out of sync).

const STRAINS = "0x7779cd49760BDefa066D7707E7EA28A2A638CCEC";
const RPC = "https://rpc.monad.xyz";
const BASE = "https://burnchronic.xyz";

// tier index -> display data. Burn costs mirror the contract.
const TIERS = [
  { name: "Mids",   rarity: "Common",     burn: "1,000,000",  cap: 10000, img: "strain-mids.png",   color: "#52ff8f" },
  { name: "Loud",   rarity: "Uncommon",   burn: "2,000,000",  cap: 2500,  img: "strain-loud.png",   color: "#f5cf57" },
  { name: "Exotic", rarity: "Rare",       burn: "5,000,000",  cap: 500,   img: "strain-exotic.png", color: "#a85cff" },
  { name: "Gas",    rarity: "Legendary",  burn: "10,000,000", cap: 100,   img: "strain-gas.png",    color: "#ff6a2b" },
];

// selector for tierOf(uint256) = 0x53f96df2
function tierOfCalldata(id) {
  const hex = BigInt(id).toString(16).padStart(64, "0");
  return "0x53f96df2" + hex;
}

async function readTier(id) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: STRAINS, data: tierOfCalldata(id) }, "latest"],
    }),
  });
  const j = await res.json();
  if (j.error || !j.result || j.result === "0x") throw new Error("tierOf failed");
  return parseInt(j.result, 16); // 0..3
}

export default async function handler(req, res) {
  try {
    const raw = req.query.id || "";
    const id = String(raw).replace(/\.json$/i, "");
    if (!/^\d+$/.test(id)) { res.status(400).json({ error: "bad id" }); return; }

    let tier;
    try { tier = await readTier(id); }
    catch { res.status(404).json({ error: "token not minted" }); return; }

    const t = TIERS[tier] || TIERS[0];
    const body = {
      name: `$CHRONIC Strain #${id} — ${t.name}`,
      description:
        `A ${t.rarity} Chronic Strain. Minted by burning ${t.burn} $CHRONIC forever. ` +
        `Stake it at ${BASE}/stake to earn from the NFT reward pool — rarer tiers weigh more. Burn it, don't hoard it. 🔥`,
      image: `${BASE}/assets/${t.img}`,
      external_url: `${BASE}/strains`,
      attributes: [
        { trait_type: "Tier", value: t.name },
        { trait_type: "Rarity", value: t.rarity },
        { trait_type: "Burned to Mint", value: `${t.burn} $CHRONIC` },
        { trait_type: "Tier Supply Cap", value: t.cap },
      ],
    };
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    res.setHeader("Content-Type", "application/json");
    res.status(200).json(body);
  } catch (e) {
    res.status(500).json({ error: "metadata error" });
  }
}
