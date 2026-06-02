# SNITCH — Monad wallet-forensics graph

"Bubblemaps on steroids, Monad-only." Paste a wallet or contract → render a graph
of everyone it interacted with on Monad mainnet (chainId 143). Click a node to
expand another hop. Forensics-first: typed + timestamped edges, funding lineage,
deployer fingerprints.

UI: `/snitch` (or `/graph`). Static page + three Vercel serverless functions.

## Why this stack (research outcome)

The original plan was Alchemy `alchemy_getAssetTransfers`. **A live spike proved
that's unavailable on Monad** — Alchemy exposes only plain JSON-RPC on Monad, and
the public RPC caps `eth_getLogs` at a **100-block range**. Against ~78.7M blocks
that's ~787k calls to scan one address's history — a non-starter. So the data
layer is built on the **Etherscan V2 unified API** (`api.etherscan.io/v2`,
`chainid=143`, a.k.a. MonadScan), which returns pre-indexed, pre-typed transfers
in ~3–4 calls/address and is free.

| Need | Source |
|---|---|
| native + internal + ERC-20 + NFT edges | Etherscan V2 `txlist` / `txlistinternal` / `tokentx` / `tokennfttx` |
| deployer fingerprint | Etherscan V2 `contract/getcontractcreation` + deployer `txlist` |
| wallet-vs-contract typing | batched `eth_getCode` on the public Monad RPC |
| 24h cache | Supabase `interactions` table |

Envio HyperSync (`https://monad.hypersync.xyz`) is the future turbo tier for deep
historical sweeps — it has no range cap but now requires a free Envio token.

## Endpoints

- `GET /api/graph?address=0x…` → `{ root, nodes, edges, stats }`, 1 hop, cache-first.
- `GET /api/deployer?address=0x…` → contract → deployer → every contract that deployer made.
- `GET /api/funding?address=0x…&depth=6` → trace a wallet back to its first funder, recursively.

**Data model**
- node: `{ address, type: wallet|contract, label, isToken, spam, firstSeen }`
- edge: `{ from, to, kind: native|erc20|nft|call, asset, value, valueFmt, txCount, firstBlock, lastBlock, firstTs, lastTs, spam }`

**Cost controls**: fan-out capped to 50 counterparties/node (ranked by real-value
then recency then volume), dust native edges (< 1e-5 MON) and zero-width-unicode
spam tokens deprioritised, 2000-tx recency window per list call, 24h cache. On a
cache hit a lookup costs **zero** API calls.

## Environment

See `.env.example`. Only `ETHERSCAN_API_KEY` is required; Supabase is optional
(cache silently disabled if absent), RPC defaults to `https://rpc.monad.xyz`.

The free Etherscan key is rate-limited (~3 req/sec); `api/_lib.js` serialises
Etherscan calls (~380ms gap) and retries rate-limit responses with backoff.

## Supabase cache table

```sql
create table if not exists interactions (
  address     text primary key,
  payload     jsonb       not null,
  fetched_at  timestamptz not null default now()
);
-- The API reads/writes with the service_role key (server-side only), so RLS can
-- stay enabled with no public policies.
alter table interactions enable row level security;
```

## Local dev

```bash
cp .env.example .env.local   # add your ETHERSCAN_API_KEY
vercel dev                   # serves graph.html + /api/* together
```
Open http://localhost:3000/snitch and paste an address.
