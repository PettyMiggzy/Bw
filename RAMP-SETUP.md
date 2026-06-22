# Fiat on/off ramp + seedless wallet — setup

The pieces that let normies go **card → $CHRONIC** (and cash out again) without
already owning a Solana wallet. We stay non-custodial: MoonPay is the licensed
party that KYCs users and handles fiat; Privy holds keys for the user. We only
hand MoonPay a signed, pre-filled URL and route the token leg through Jupiter.

## Flow

```
NEW USER:  /wallet → email login (Privy) → embedded Solana wallet
ON-RAMP:   card → MoonPay → SOL into wallet → Jupiter swap → $CHRONIC   (/buy)
OFF-RAMP:  $CHRONIC → Jupiter swap → SOL → MoonPay → bank/card          (/sell)
```

Everything routes through SOL — no ramp sells a micro-cap directly. The Jupiter
swap (existing `/api/swap`, `/api/actions/*`) is the bridge on both sides.

## What's wired

| Piece | File | Notes |
|---|---|---|
| Signed MoonPay URL builder | `api/moonpay.js` | `GET /api/moonpay?intent=buy\|sell&address=<pubkey>` → `{url}` |
| On-ramp button | `buy.html` | "💳 No SOL? Buy with card" |
| Off-ramp button | `sell.html` | "💵 Cash out to bank" |
| Seedless wallet | `wallet.html` | Privy email login → embedded Solana wallet |

Until keys are set, every card button shows a friendly "unlocks soon" message —
nothing breaks, the SOL-based flows keep working.

## Turn it on (after MoonPay KYB on the entity clears)

Set in **Vercel project env** (not git):

```
MOONPAY_KEY=pk_test_…      # publishable
MOONPAY_SECRET=sk_test_…   # secret — server only, NEVER ship to client
MOONPAY_ENV=sandbox        # flip to 'live' once approved for production
```

For the seedless wallet (public id, safe in client):

```
PRIVY_APP_ID=…             # Privy dashboard → App settings
```

Then either inject `window.PRIVY_APP_ID` or hard-set the constant at the top of
`wallet.html`'s module script.

## Test checklist

1. **Sandbox MoonPay:** test keys + `MOONPAY_ENV=sandbox`. Buy on `/buy` →
   MoonPay test card → SOL arrives → swap to $CHRONIC.
2. **Off-ramp:** `/sell` → "Cash out to bank" → MoonPay sell sandbox.
3. **Privy:** set `PRIVY_APP_ID`, open `/wallet`, email login, confirm an
   embedded Solana wallet address appears, then card-buy into it.
4. Flip `MOONPAY_ENV=live` + live keys only after MoonPay approves production.

## Notes / still to decide

- **MoonPay signature** is computed server-side over the exact query string
  (`api/moonpay.js`). Required — it locks the wallet address so the URL can't be
  rewritten to redirect funds.
- **Privy** (`wallet.html`) is the one piece needing a live App ID + a real
  browser pass — it loads React via `esm.sh` (no bundler), so verify the embedded
  Solana wallet mounts before launch. Pinned: `@privy-io/react-auth@1.92.0`.
- **Fee share / off-ramp limits** come with MoonPay *partner* tier (the KYB
  account), not the consumer flow.
