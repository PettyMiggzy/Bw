# 📸 Instagram auto-poster — setup (what to do today)

`tools/ig-poster.js` posts $CHRONIC burns / pool milestones / season winners to
Instagram automatically, mirroring the X poster. It runs on a GitHub Action
every 15 min (`.github/workflows/ig-poster.yml`). The **code is done** — this is
the Meta-side setup to switch it on.

## The order matters — do it in this sequence

1. **Make the IG account a Professional account.**
   IG app → Settings → Account type → **switch to Business** (or Creator).
   *A personal account cannot post via API — this is the hard requirement.*

2. **Create a Facebook Page** (if you don't have one) and **link it** to the IG
   account. IG Business settings → connect Page. The API reaches IG *through*
   the Page — no Page, no posting.

3. **Create a Meta app** at https://developers.facebook.com → My Apps → Create
   App → type **Business**. Add the **Instagram Graph API** product.

4. **Business verification** (Meta Business Suite → Security Center). Uses your
   entity / DBA. Can take a day or two — start it early today.

5. **App Review** for the permissions:
   - `instagram_basic`
   - `instagram_content_publish`  ← the one that lets it post
   - `pages_show_list`, `pages_read_engagement`
   *While the app is in Dev mode you can already post to accounts with a role on
   the app — so you can TEST before review fully clears.*

6. **Get the two secrets the script needs:**
   - **`IG_USER_ID`** — your Instagram Business account id (numeric). Get it via
     Graph API Explorer: `GET /me/accounts` → your Page → then
     `GET /{page-id}?fields=instagram_business_account`.
   - **`IG_ACCESS_TOKEN`** — a **long-lived Page access token** (~60 days).
     Generate a user token in Graph API Explorer with the permissions above,
     exchange it for a long-lived token, then get the Page token. (Re-issue
     before it expires — set a reminder, or we can add auto-refresh later.)

7. **Add repo secrets** (GitHub → Settings → Secrets and variables → Actions):
   ```
   SUPABASE_URL, SUPABASE_SERVICE_KEY   (same as the other tools)
   IG_USER_ID
   IG_ACCESS_TOKEN
   ```
   Optional: `GRAPH_VERSION`, `IG_IMAGE`, `POST_BURN_THRESHOLD`, `POOL_STEP`.

## Test it (no risk)

- **Dry run, prints only:** Actions → "$CHRONIC Instagram auto-poster" → Run
  workflow → check "Dry run". Or locally: `cd tools && npm i && npm run ig-post:dry`.
- **First real run sets a baseline and posts nothing** (so it never dumps
  history). The *next* new burn/milestone is the first thing it posts.

## Good to know

- **Every IG post needs an image** — the script points at
  `/assets/og-chronic.jpg` by default (1.91:1, the safest aspect ratio IG
  accepts). Swap in dedicated square skeleton art later via the `IG_IMG_*` envs.
- **No clickable links in captions** — captions end with "👉 link in bio", so
  set your IG **bio link to `/wallet`** (the seedless card buy) or `/buy`.
- **Limit: 25 API posts / 24h** — far more than the ritual needs.
- Runs fully independent of the X poster (separate state key `ig_main`), so one
  burn fires to both without them stepping on each other.

## Next (after this is live)

- The **4:20 daily burn ritual** post (a scheduled "the skeleton sparked one"
  every day at 4:20) — small add on top of this.
- **Reels** (video) instead of static images — more reach, needs clips + a
  status-poll step in the publish flow.
