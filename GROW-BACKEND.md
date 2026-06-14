# $CHRONIC GROW — backend

Burn-to-grow, grow-to-win. Spend $CHRONIC on seeds/upgrades → **60% burned, 40% into the weekly pool** → grow & sell for **XP** → at week's end the **top 3 split the pool by XP share**. No dev cut.

## Architecture (no custom on-chain program)

Runs entirely on what the site already uses: **Vercel serverless + Supabase + Solana RPC (Alchemy)**.

```
browser (Phantom)                 Vercel /api                     Solana / Supabase
─────────────────                 ───────────                     ─────────────────
connect + sign nonce  ───────────▶ /api/grow?action=login  ──────▶ verify ed25519 sig
build burn tx (60/40) ──Phantom──▶ Solana (via /api/solrpc) ─────▶ on-chain: burn + pool
send tx signature     ───────────▶ /api/grow?action=buy    ──────▶ verifyBuyTx (getTransaction)
                                                                    └▶ grant seed/upgrade, +pool
plant / sell          ───────────▶ /api/grow plant|sell    ──────▶ credit XP (from real burns)
leaderboard           ───────────▶ /api/grow?action=leaderboard   read grow_scores
weekly                            tools/settle-season.js   ──────▶ pay top-3, open next season
```

**Why the burn is trustworthy without a program:** a buy is ONE atomic Solana transaction the player signs — it *burns 60%* and *transfers 40%* to the pool account in the same tx. The server then re-reads that exact tx on-chain (`getTransaction`) and only grants the item if the burn + pool amounts and the mint and the signer all check out. You can't get credit without the burn actually happening, and XP only ever comes from verified buys — so the leaderboard can't be farmed for free.

**Custody / ownership:** the 40% pool collects in the pool wallet's token account (set `POOL_WALLET` to the plain wallet address) and payouts are signed by that wallet's key (`POOL_SECRET_KEY`, used only by the settle script, never on Vercel). This is the "deploy with a burner, transfer to my wallet" flow — see handover below.

## Files

| Path | What |
|---|---|
| `supabase/grow-schema.sql` | Tables + RPCs (players, seasons, scores, purchases, nonces). Run in Supabase SQL editor. |
| `api/_grow.js` | Shared lib: catalog, Supabase + Solana helpers, signature + tx verification. |
| `api/grow.js` | API: `nonce`, `login`, `state`, `buy`, `plant`, `sell`, `leaderboard`, `season`. |
| `api/solrpc.js` | Solana RPC proxy → hides your Alchemy key from the browser. |
| `tools/settle-season.js` | Weekly: pays top-3 by XP share, closes & reopens the season. |

## Player market ("The Plug")

Players trade **seeds / harvested nugs / rare strain NFTs** with each other. On each sale **5% of the price is burned**, 95% goes to the seller — verified on-chain by the API (same trust model as buys), items move in the game DB. Harvesting a plot drops a tradeable **nug** (by strain + quality); an **exotic×exotic** harvest also mints a rare **strain NFT** (in-game collectible). Schema: `supabase/grow-market.sql`. API actions: `listings` (public), `market_list`, `market_delist`, `market_reserve`, `market_buy`. Telegram Mini App: see `GROW-TELEGRAM.md`.

## Setup

1. **Supabase** — open the SQL editor, paste & run `supabase/grow-schema.sql`, then `supabase/grow-market.sql`.
2. **Pool wallet** — create the wallet that holds the pool (the burner for now). Use its plain address as `POOL_WALLET` — its $CHRONIC token account is auto-created on the first buy, so you don't need to derive one.
3. **Vercel env** (Project → Settings → Environment Variables):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `SOLANA_RPC` = your Alchemy Solana URL
   - `CHRONIC_MINT` (default already correct), `CHRONIC_DECIMALS=6`
   - `POOL_WALLET` (the pool wallet address; alias `POOL_TOKEN_ACCOUNT` also accepted)
   - Do **NOT** put `POOL_SECRET_KEY` on Vercel — it's only for the settle script.
4. **Deploy** — push; Vercel serves `/api/grow` and `/api/solrpc`.

## Weekly settlement

Run from anywhere that has the pool key (your machine, a cron box, or a GitHub Action with the secret):

```bash
cd tools && npm install
# dry run first — prints the payouts, sends nothing:
SOLANA_RPC=… SUPABASE_URL=… SUPABASE_SERVICE_KEY=… POOL_SECRET_KEY=… node settle-season.js --dry
# for real:
… node settle-season.js
```

It finds the most recent **ended, unsettled** season, computes the XP-weighted top-3 split (largest-remainder so it sums exactly to the pool), sends the $CHRONIC, records the winners, and opens the next 7-day season.

## Handover: burner → your wallet

The pool is just a wallet, so transferring "ownership" is a config swap — no contract migration:

1. Create your real treasury wallet + its $CHRONIC ATA.
2. Move any pooled $CHRONIC from the burner's ATA to the new ATA (one transfer).
3. Update `POOL_WALLET` in Vercel to the new wallet address and redeploy.
4. Use the new wallet's key as `POOL_SECRET_KEY` for the settle script. Retire the burner.

## Not done yet (next step)

The backend is complete; the **frontend is still the local simulation**. Wiring `grow.html` to it = Phantom connect + signed login, building the on-chain burn tx for buys, and reading the live shared leaderboard/pool. That's the next task once the env + pool wallet are in place so it can be tested end-to-end on mainnet.

> Untested against live mainnet from here (no keys/env in this environment). Do a `--dry` settle and a small test buy on a fresh season before going public.
