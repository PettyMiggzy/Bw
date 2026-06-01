// /api/pin — pins a file (image or metadata JSON) to Pinata IPFS.
// Keeps the Pinata JWT server-side; the browser never sees it.
// Client POSTs raw bytes; ?name= and ?type= describe the file.
// Returns { cid, uri: "ipfs://<cid>", gateway: "https://.../ipfs/<cid>" }.
//
// Vercel env vars required:
//   PINATA_JWT      — from app.pinata.cloud/developers/api-keys
//   PINATA_GATEWAY  — your gateway domain, e.g. mygw.mypinata.cloud (optional)

export const config = { api: { bodyParser: false } };

const PIN_URL = "https://uploads.pinata.cloud/v3/files";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const JWT = process.env.PINATA_JWT;
  if (!JWT) { res.status(500).json({ error: "PINATA_JWT not configured" }); return; }
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    if (!buf.length) { res.status(400).json({ error: "empty body" }); return; }

    const name = (req.query.name || "file").toString();
    const type = (req.query.type || "application/octet-stream").toString();

    const fd = new FormData();
    fd.append("network", "public");
    fd.append("file", new Blob([buf], { type }), name);

    const r = await fetch(PIN_URL, { method: "POST", headers: { Authorization: "Bearer " + JWT }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { res.status(r.status).json({ error: "pin failed", detail: j }); return; }

    const cid = j.data && j.data.cid;
    if (!cid) { res.status(502).json({ error: "no cid returned", detail: j }); return; }
    const gw = process.env.PINATA_GATEWAY;
    const gateway = gw ? `https://${gw}/ipfs/${cid}` : `https://gateway.pinata.cloud/ipfs/${cid}`;
    res.status(200).json({ cid, uri: `ipfs://${cid}`, gateway });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "pin error" });
  }
}
