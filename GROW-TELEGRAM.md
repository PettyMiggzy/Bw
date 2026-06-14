# $CHRONIC GROW — Telegram Mini App

The game (`/grow`) doubles as a Telegram Mini App — same page, no separate build. The Telegram SDK is already loaded; when opened inside Telegram it calls `ready()` + `expand()` and themes the header.

## Set it up (BotFather)
1. Open **@BotFather** → `/newbot` (or reuse an existing bot).
2. `/newapp` → pick the bot → set:
   - **Web App URL:** `https://www.burnchronic.xyz/grow`
   - title / description / icon as you like.
3. (Optional) `/setmenubutton` → set the bot's menu button to open the Mini App.
4. Share the app link (`https://t.me/<bot>/<app>`) — it opens the game in Telegram.

## Wallet note (important)
$CHRONIC is on **Solana**, and Telegram's built-in wallet is TON — they're different chains. So inside Telegram, the **Connect** button deep-links out to **Phantom** to sign (the deep-link we already wired). Flow:
- Browse/demo works fully inside Telegram.
- Connecting + on-chain buys hand off to Phantom, then return.

If you later want a smoother in-Telegram Solana experience, options are a Solana wallet-adapter that supports Telegram, or a custodial in-app balance — both are larger follow-ups.

## What works in the Mini App
- Demo play, the live leaderboard, the weekly pool, and the **market** (browse) all render in-Telegram.
- Buys / listings / market purchases require the Phantom hand-off for signing.
