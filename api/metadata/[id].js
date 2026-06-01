// $CHRONIC Strains — NFT metadata endpoint
// GET /api/metadata/<tokenId>  ->  ERC721 metadata JSON
// Reads tierOf(tokenId) live from the deployed ChronicStrains contract, then
// assigns a specific artwork from that tier's image pool — deterministic per
// token id, so a given NFT's art is fixed forever (never reshuffles).

const STRAINS = "0x7779cd49760BDefa066D7707E7EA28A2A638CCEC";
const RPC = "https://rpc.monad.xyz";
const BASE = "https://burnchronic.xyz";

const TIERS = [
  { key: "mids",   name: "Mids",   rarity: "Common",     burn: "1,000,000",  cap: 10000, pool: 2 },
  { key: "loud",   name: "Loud",   rarity: "Uncommon",   burn: "2,000,000",  cap: 2500,  pool: 2 },
  { key: "exotic", name: "Exotic", rarity: "Rare",       burn: "5,000,000",  cap: 500,   pool: 1 },
  { key: "gas",    name: "Gas",    rarity: "Legendary",  burn: "10,000,000", cap: 100,   pool: 1 },
];

// selector for tierOf(uint256) = 0x53f96df2
function tierOfCalldata(id) {
  return "0x53f96df2" + BigInt(id).toString(16).padStart(64, "0");
}
async function readTier(id) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: STRAINS, data: tierOfCalldata(id) }, "latest"] }),
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

    let tierIdx;
    try { tierIdx = await readTier(id); }
    catch { res.status(404).json({ error: "token not minted" }); return; }

    const t = TIERS[tierIdx] || TIERS[0];
    // deterministic variant pick: (id-1) mod poolSize, +1 -> 1..pool
    const variant = (Number(BigInt(id) % BigInt(t.pool))) + 1;
    const image = `${BASE}/assets/strains/${t.key}-${variant}.png`;

    const body = {
      name: `$CHRONIC Strain #${id} — ${t.name}`,
      description:
        `A ${t.rarity} Chronic Strain. Minted by burning ${t.burn} $CHRONIC forever. ` +
        `Stake it at ${BASE}/stake to earn from the NFT reward pool — rarer tiers weigh more. Burn it, don't hoard it. 🔥`,
      image,
      external_url: `${BASE}/strains`,
      attributes: [
        { trait_type: "Tier", value: t.name },
        { trait_type: "Rarity", value: t.rarity },
        { trait_type: "Variant", value: variant },
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
