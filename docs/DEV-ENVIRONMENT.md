# The isolated development environment

Owner decision, 2026-11-08: set up a fully isolated dev environment so Group
Buy (and later work) can be exercised end to end without production data,
production money or production customers.

**Nothing in this environment can reach production, and nothing in production
points at it.**

---

## Why a separate Shopify app was the load-bearing part

The obvious reading of "isolated environment" is a separate server and a
separate database. Those were necessary and they were not sufficient.

A Shopify **app record carries one set of URLs** no matter how many stores it
is installed on. The app `caratforus-development` has its `application_url`
and its **App Proxy** pointed at `https://caratforus.fly.dev` — production —
and it was installed on *both* stores. So every storefront request to
`/apps/carat/...` on `caratforus-dev.myshopify.com` was being answered by the
**production backend against the production database**. The dev store was
showing production campaigns.

A second app record, `caratforus-dev`, is what actually moves that traffic.
Without it, a separate Fly app and Postgres isolate the parts nobody was
looking at and leave the storefront pointed at production.

---

## What exists

| Piece | Development | Production |
|---|---|---|
| Fly app | `caratforus-dev` → `caratforus-dev.fly.dev` | `caratforus` |
| Postgres | `caratforus-dev-db` (unmanaged, 1 node) | `caratforus-db` (Fly **Managed**, `basic`) |
| Shopify app | `caratforus-dev` (`378a656c…`) | `caratforus-development` (`f54993df…`) |
| Shopify store | `caratforus-dev.myshopify.com` | `caratforus.myshopify.com` |
| Fly config | `app/fly.dev.toml` | `app/fly.toml` |
| Shopify config | `app/shopify.app.caratforus-dev.toml` | `app/shopify.app.caratforus-development.toml` |
| Cron machines | **none** | 4 |
| Email | **cannot send** (`EMAIL_API_KEY` unset) | configured |

### Deliberately absent, and why

- **No cron machines.** Production's four send email, publish prices to
  Shopify and expire orders — every one an outward-facing side effect. A dev
  environment that fired them would be a dev environment that emails people.
  Run a scheduled job by hand here if it ever needs testing.
- **No `EMAIL_API_KEY`.** Not an oversight. It is the difference between a dev
  mistake being a log line and being a message to a real address.
- **`PRICE_AUTO_PUBLISH_ENABLED=false`.** Dev never pushes a price anywhere
  without a human.
- **No `[events]` subscriptions and no SYOS metaobject definition** in the dev
  Shopify app. App-owned metaobjects are namespaced per app, so this app would
  create a *second*, empty `syos_center_size_profile` type that matches none
  of the entries the dev store's existing SYOS products link to through the
  other app. Add them when SYOS itself is exercised here.

---

## Cost

Fly's published prices (<https://docs.fly.io/about/pricing>), as of
2026-11-08:

| Resource | Rate | Monthly |
|---|---|---|
| `caratforus-dev` app machine, `shared-cpu-1x` 512MB | $3.69/mo running | **~$0.20 idle** |
| `caratforus-dev-db` machine, `shared-cpu-1x` 256MB | $2.19/mo | **$2.19** |
| `pg_data` volume, 1GB | $0.15/GB/mo | **$0.15** |
| | | **≈ $2.50/mo idle, ≈ $6.00/mo if the app ran 24/7** |

The app machine is the variable: `min_machines_running = 0` with
`auto_stop_machines = "suspend"` means it suspends when nobody is using it,
and a suspended machine bills only $0.15/GB/month of rootfs and resumes on the
first request. The database machine stays up.

### What was NOT bought, and why

Mirroring production would mean **Fly Managed Postgres**, which is
**$38/month for the Basic plan** plus $0.28/GB/month of storage — about
**$41/month** all in, roughly **16× the idle cost of what was built**. The
owner's instruction was to use the lowest-cost practical configuration and not
to overbuild for production traffic, so the unmanaged single-node Postgres was
used instead. That is a genuine trade: it has no managed backups, failover or
monitoring. For a database whose entire contents are reproducible from
`prisma migrate deploy` + `npm run db:seed` +
`npm run dev:sample-group-buy`, that is the right trade. **It would not be
for production.**

---

## Deploying

```bash
cd app
./scripts/deploy-dev.sh            # Fly app + Shopify app config
./scripts/deploy-dev.sh fly        # Fly app only
./scripts/deploy-dev.sh shopify    # Shopify app config only
```

**Never a bare `flyctl deploy` or `shopify app deploy.`** Both mirror a local
working tree onto a remote that the command does not name, and in both cases
the *shorter* invocation is the one that targets production — the same shape
as the `shopify theme push` incident recorded in `CLAUDE.md`. The script
refuses to run if either config could reach production, and those refusals are
mutation-tested.

## Reaching the dev store's Admin API

Worth knowing before reaching for the wrong tool: the **claude.ai Shopify MCP
connection is authenticated against `caratforus.myshopify.com` — PRODUCTION.**
`get-shop-info` confirms it, and `switch-shop` would revoke the production
token and require a fresh authorization, so it is the wrong instrument for dev
work.

Dev-store Admin access needs neither. The CLI can execute GraphQL against any
store where the app is installed:

```bash
npx shopify app execute --config caratforus-development \
  --store caratforus-dev.myshopify.com --no-input \
  --query-file q.graphql --output-file out.json
```

That uses the *production-pointing* app's install on the *dev* store, which
touches nothing in production — the app record is not modified, only dev-store
data is read or written. It is how `prisma/devSampleShopifyVariants.json` and
`prisma/devSampleShopifyImages.json` were produced.

One limit found by using it: `read_files` is **not** granted on that app's
dev-store install, so `files(...)` returns `ACCESS_DENIED` even though the
scope is declared in its config — consistent with that config never having
been deployed. Product `media` works under `read_products` and yields the same
`MediaImage` GIDs the Admin file picker returns, which is why the sample
campaign's imagery is sourced that way.

## Reaching the dev database

Credentials live in `app/.env.dev`, which is gitignored (`.env.*`). The URL
points at a local proxy port, so open the tunnel first:

```bash
flyctl proxy 15432:5432 -a caratforus-dev-db
```

Then any script reading `.env.dev` can connect. `prisma/schema.prisma`'s
pooled/direct split does not apply here: unmanaged Fly Postgres exposes
haproxy leader-routing on 5432, **not** a transaction pooler, so
`DATABASE_URL` and `DIRECT_URL` are deliberately the same endpoint.

## Rebuilding it from nothing

```bash
flyctl proxy 15432:5432 -a caratforus-dev-db   # in another shell
cd app
set -a; . ./.env.dev; set +a
npx prisma migrate deploy
npx tsx prisma/seed.ts
npm run dev:sample-group-buy -- --code dev-sample-gb-2 --units 12 --close-in-days 21
npm run dev:sample-group-buy -- --code dev-sample-gb-3 --units 28 --close-in-days 6
```

---

## The sample Group Buy campaigns

`scripts/dev-sample-group-buy-campaign.ts` builds them. It goes **through the
real code, not around it**: the state is assessed by
`assessCampaignBuilderCompleteness`, the contract is produced by
`buildCampaignOptionsJson` (which routes through the real validator), and the
campaign is opened by `openGroupBuyCampaign`. If the script can create a
campaign the admin could not, the script is wrong.

It refuses to run in production twice over — on `APP_ENV`, and on the campaign
code, which must match `^dev-[a-z0-9-]+$`.

| Campaign | Status | Units | Tier | Closes |
|---|---|---|---|---|
| `dev-sample-gb-2` | open | 12 | 2 of 3, with a next-tier message | +21 days |
| `dev-sample-gb-3` | open | 28 | 3 of 3, best price unlocked | +6 days |
| `dev-sample-gb-1` | **closed** | 12 | — | — |

### What the campaigns exercise

- **All three option roles.** `metal` and `center_shape` are
  `variant_defining`; `ring_size` is `variant_defining_band` with 17 exact
  sizes across 3 bands; `engraving` and `gift_box` are `customer_preference`
  and do not multiply variants.
- **498 enabled configurations over 15 priced variant groups** — the two-space
  model, with bands collapsing 17 sizes into 3 priced groups.
- **Both kinds of unavailable combination.** Platinum + Oval removes a whole
  pairing (and three variant groups). White Gold + Round in sizes 11.5 and 12
  is a *partial* exclusion inside a band: the group survives because its other
  sizes still sell. The second case is the one a naive implementation gets
  wrong, by either dropping the whole group or offering the two sizes anyway.
- **Genuinely different prices per group**, from real metal and weight
  differences — 9 distinct frozen bases across the 15 groups, ranging
  $1,697.00–$2,161.00. Not a hardcoded price difference.
- **A three-tier ladder** (×1.000 / ×0.960 / ×0.930) that passed the real tier
  safety and price-ladder checks with no unsafe override.

### Why `dev-sample-gb-1` is closed rather than deleted

It was opened with an **empty options contract**: the script passed
`contract.options` where the validator returns `contract.value`, so
`saveGroupBuyCampaignOptionsUpload` stored `undefined` and the freeze pinned
nothing. Its storefront detail page and its resolver both read the frozen
contract, so it is unusable.

It could not be repaired — options uploads are draft-only by design and it was
already open. It could not be deleted — the unit ledger is append-only at the
database level. Archiving would not have hidden it either: the public feed
deliberately does **not** filter on `archivedAt`, because "archiving an OPEN
campaign is not a thing the lifecycle does"
(`app/domain/groupbuy/campaignVisibility.ts`).

**Closing it was the actual lifecycle answer.** The public hub selects on
`status: "open"`, so a closed campaign drops out of it, and closing a
misconfigured campaign is what a business would do. No protection was
weakened, no evidence was destroyed, and the mistake stays visible in history
where it belongs.

### Deliberately obvious placeholder imagery

The campaigns reference the dev store's built-in Shopify sample photographs
(`prisma/devSampleShopifyImages.json`) — snowboards, not jewellery — and every
`altText` says so. A screenshot of this campaign can never be mistaken for a
real CaratForUs product shot.

---

## The one step that still needs the owner

**The dev Shopify app is not yet installed on `caratforus-dev.myshopify.com`.**
Installing an app is an OAuth grant and needs a signed-in human; it is not
something this work can do on the owner's behalf.

Until it is installed:

- `/apps/carat/...` on the dev store still routes to the **production** app's
  proxy, so the dev store's Group Buy pages would show **production**
  campaigns. This is read-only, but it is the opposite of what the environment
  is for. **Do not evaluate the dev storefront until the install is done.**
- Tier 1 prices could not publish to Shopify, because publishing needs an
  Admin session and the dev database has none. The campaigns are nonetheless
  correctly open and frozen — `CampaignOpenTierPublishError` is explicit that
  the freeze committed and must not be re-opened. The fix is idempotent: call
  `ensureGroupBuyCampaignSyncedToCurrentTier` once a session exists. Until
  then the dev store's variant prices sit at their `$1.00` placeholder, which
  matters only for add-to-cart, not for anything the detail page displays.

After installing, the remaining steps are to push the theme to the dev store
and then run the storefront checklist in
`docs/GROUP-BUY-STOREFRONT-LAUNCH-GATE.md` against `dev-sample-gb-2`.
