# Deploy the new-mint firehose on Railway

The `newmints-listener.js` worker is a long-running websocket process that
captures brand-new pump.fun mints and writes them to the `grow_newmints`
Supabase table. The $CHRONIC terminal's **New** board reads that table via
`/api/newmints`. Vercel can't run it (functions are short-lived) — Railway can.

## One-time setup (~3 min)

1. **railway.app → New Project → Deploy from GitHub repo** → pick this repo.
2. Open the service → **Settings**:
   - **Root Directory:** `tools`  ← important, the worker lives here
   - (Nixpacks auto-detects `package.json` and uses `railway.json`'s start
     command `node newmints-listener.js`. Nothing else to configure.)
3. **Variables** tab — add:
   ```
   SUPABASE_URL          = https://<your-project>.supabase.co
   SUPABASE_SERVICE_KEY  = <service_role key>   # server-only, never in the browser
   META_FETCH            = 1                     # fetch token image from its uri
   ```
   Optional — only if you want Alchemy instead of the free PumpPortal feed:
   ```
   FEED         = alchemy
   ALCHEMY_WSS  = wss://solana-mainnet.g.alchemy.com/v2/<key>
   ```
   Leave `FEED` unset to use **PumpPortal** (no key, and it includes
   name/symbol/uri/creator — richer than raw Alchemy logs).
4. **Deploy.** Logs should show `▶ pumpportal subscribeNewToken` then a stream
   of `＋ SYMBOL <mint>` lines. Each line is a row written to Supabase.

## Before first run
- Run `supabase/grow-newmints.sql` once (creates the table; idempotent).
- The worker auto-reconnects on disconnect and de-dupes within a run, so it's
  safe to leave running 24/7. It costs ~nothing (one idle websocket).

## Verify it's flowing
- `https://www.burnchronic.xyz/api/newmints?limit=5` should return recent mints
  with `"live": true`.
- The terminal **New** board will show them seconds after they mint, upgrading
  to live price/mcap once Dexscreener indexes each one.

---

# Deploy the buy-&-burn engine (feeburn.js)

`feeburn.js` is the worker that actually **burns** $CHRONIC. Every cycle it
SPL-burns the *entire* $CHRONIC balance of the burn wallet — so anything sent
to that wallet (manual sends, the meme generator's 40% routed as SOL+DCA, etc.)
gets burned forever. **If this worker isn't running, tokens sent to the wallet
just sit there — they do NOT auto-burn.**

## Setup (~3 min) — a SECOND Railway service in the same project

1. Railway project → **New → GitHub Repo** → same repo (a second service).
2. Service **Settings**:
   - **Root Directory:** `tools`
   - **Custom Start Command:** `node feeburn.js`
3. **Variables** tab — add:
   ```
   BURN_SECRET_KEY = <burn wallet keypair>   # base58 or [json]. SET HERE ONLY,
                                             # never paste it in chat or commit it.
   SOLANA_RPC      = https://solana-mainnet.g.alchemy.com/v2/<key>
   DCA_SOL         = 0        # 0 = burn-only. >0 also buys $CHRONIC with the
                             # wallet's SOL each cycle, then burns it (turns the
                             # meme-fee 40% SOL into real burns).
   DCA_INTERVAL_MIN = 60      # minutes between cycles
   RESERVE_SOL      = 0.05    # SOL kept for gas, never spent
   ```
   Optional — tweet every burn (free marketing):
   ```
   TWEET_BURNS = 1
   TWEET_MIN   = 1000
   X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET = <your X app keys>
   ```
4. **Deploy.** Logs print `$CHRONIC buy-&-burn engine`, the burn wallet address,
   then `🔥 burned N $CHRONIC — <sig>` on the **first cycle** (immediately) if the
   wallet holds any tokens. Your 6M will burn on that first cycle.

## Notes
- `BURN_SECRET_KEY` must be the keypair of the wallet that **holds** the tokens
  (the one you've been sending $CHRONIC to). Burning requires its signature.
- Keep ~`RESERVE_SOL` SOL in the wallet for gas (each burn tx is ~0.000005 SOL).
- Burn-only (`DCA_SOL=0`) is the simplest start; flip `DCA_SOL` up later to also
  convert incoming SOL into buy-&-burns.
