# $CHRONIC — project conventions

burnchronic.xyz — a Solana meme-coin ecosystem ($CHRONIC) of static HTML pages
+ Vercel serverless functions that all funnel back to burning the token.

## Wallet signing — HARD RULE (Phantom warning avoidance)
Follow Phantom's domain-and-transaction-warning docs. Two cases:

- **Single-signer tx (the default):** submit via `provider.signAndSendTransaction`
  so Phantom/Blowfish gets full sign-and-submit context. Fall back to
  `signTransaction` + `sendRawTransaction` ONLY for wallets that lack it.
  Do NOT ship a bare `signTransaction` + `sendRawTransaction` flow — Phantom
  support confirmed it triggers the "this dApp could be malicious" warning even
  for benign txs. Used on terminal/buy/sell/burn/grow.
  ```js
  if (p.signAndSendTransaction) { var s = await p.signAndSendTransaction(tx); sig = s.signature || s; }
  else { var signed = await p.signTransaction(tx); sig = await conn(w3).sendRawTransaction(signed.serialize()); }
  ```
- **Multi-signer tx (e.g. the launchpad: new mint keypair + user):** do the
  OPPOSITE — Phantom signs via `signTransaction`, then submit yourself. Never
  `signAndSendTransaction` a multi-signer tx. Used on launch.html.

Other requirements: keep ONE signer per tx where possible; use Address Lookup
Tables if near the size limit; and **simulate with `sigVerify:false` before
asking the user to sign** (`assets/wallet.js` → `chronicSimulate(conn, tx)`,
best-effort — only blocks on a definite execution error).

Canonical helpers in `assets/wallet.js`: `chronicSignAndSend`, `chronicSimulate`.
Load with `<script src="/assets/wallet.js"></script>`.

## Architecture
- Frontend: standalone `*.html` pages with inline scripts; web3 via
  `esm.sh/@solana/web3.js`. No bundler. Shared utils go in `/assets/*.js`.
- Backend: `api/*.js` Vercel serverless (CommonJS `module.exports = (req,res)`).
  Underscore-prefixed files (`api/_grow.js`) are shared libs, not routes.
- DB: Supabase (PostgREST + SECURITY DEFINER RPCs + RLS). SQL in `supabase/`.
- Non-custodial everywhere: we never take custody. Swaps route through Jupiter;
  burns are SPL Burn on the user's own ATA. No approve/delegate/setAuthority.

## Economics
- Game: 50% burn / 40% weekly pool / 10% treasury. (Buy tx burns 50% + sends 50% to the pool wallet as ONE transfer; server credits 40% to the prize pool, the 10% accrues in the pool wallet as treasury.)
- Terminal/swaps: flat 1% fee in SOL. Pad-launched tokens split that 1% so the
  dev earns 50% of trade fees forever.

## Workflow
- Dev on branch `claude/weed-game-concept-v70pfv`; merge to `main` to deploy
  (Vercel tracks `main`; Railway worker tracks `main` too).
- Never commit secrets. Env vars live in Vercel / Railway / Supabase, not git.

## Live services
- Site → Vercel (`main`). New-mint firehose worker → Railway
  (`tools/newmints-listener.js`, root dir `tools`), writes `grow_newmints`.
