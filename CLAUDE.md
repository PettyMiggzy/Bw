# $CHRONIC — project conventions

burnchronic.xyz — a Solana meme-coin ecosystem ($CHRONIC) of static HTML pages
+ Vercel serverless functions that all funnel back to burning the token.

## Wallet signing — HARD RULE
Every on-chain transaction submission MUST use `provider.signAndSendTransaction`
(so Phantom/Blowfish gets full sign-and-submit context), falling back to
`signTransaction` + `sendRawTransaction` ONLY for wallets that lack it.

- Do NOT introduce a bare `signTransaction()` + `sendRawTransaction()` flow.
  Phantom support confirmed that pattern triggers the "this dApp could be
  malicious" warning even for benign txs.
- Canonical helper: `assets/wallet.js` → `chronicSignAndSend(provider, tx, conn)`.
  New pages should use it. Existing pages inline the same
  `if (provider.signAndSendTransaction) {…} else {…}` pattern — keep it.
- Pattern reference (used on terminal/buy/sell/burn/grow/launch):
  ```js
  if (p.signAndSendTransaction) { var s = await p.signAndSendTransaction(tx); sig = s.signature || s; }
  else { var signed = await p.signTransaction(tx); sig = await conn(w3).sendRawTransaction(signed.serialize()); }
  ```

## Architecture
- Frontend: standalone `*.html` pages with inline scripts; web3 via
  `esm.sh/@solana/web3.js`. No bundler. Shared utils go in `/assets/*.js`.
- Backend: `api/*.js` Vercel serverless (CommonJS `module.exports = (req,res)`).
  Underscore-prefixed files (`api/_grow.js`) are shared libs, not routes.
- DB: Supabase (PostgREST + SECURITY DEFINER RPCs + RLS). SQL in `supabase/`.
- Non-custodial everywhere: we never take custody. Swaps route through Jupiter;
  burns are SPL Burn on the user's own ATA. No approve/delegate/setAuthority.

## Economics
- Game: 60% burn / 40% weekly pool, no dev cut.
- Terminal/swaps: flat 1% fee in SOL. Pad-launched tokens split that 1% so the
  dev earns 50% of trade fees forever.

## Workflow
- Dev on branch `claude/weed-game-concept-v70pfv`; merge to `main` to deploy
  (Vercel tracks `main`; Railway worker tracks `main` too).
- Never commit secrets. Env vars live in Vercel / Railway / Supabase, not git.

## Live services
- Site → Vercel (`main`). New-mint firehose worker → Railway
  (`tools/newmints-listener.js`, root dir `tools`), writes `grow_newmints`.
