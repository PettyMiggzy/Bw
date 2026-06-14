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
