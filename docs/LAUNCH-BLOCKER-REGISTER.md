# MVP1 Launch Blocker Register

**Updated 2026-10-14, after a read-only reconciliation against live
production.** The single authoritative list of what stands between the
current repository and taking a real customer's money.

This is a *launch* register, not a backlog. Nothing enters it because it
would be nice; an item is here only if MVP1 cannot open without it.

> ### Correction notice
>
> The first version of this register (2026-10-14, commit `50fc7d8`) was
> written from reconstruction rather than from evidence, and it was wrong
> about production in three places. It marked the Fly deployment as
> unconfirmed, production secrets as missing, and the email provider as
> missing. **All three were already configured and working.** It also
> marked bank-payment coordinates and object storage as outstanding; both
> are set. And it said no jobs were scheduled, when two have been running
> on a schedule since 2026-09-23.
>
> Every status below now carries the evidence it rests on, or is explicitly
> marked unknown. Where something was verified earlier by the owner and not
> re-verified today, it says so rather than borrowing the earlier
> confidence.

---

## How to read it

| Status | Meaning |
|---|---|
| 🟢 **WORKING** | Configured and verified working, with the evidence named |
| 🔄 **TRANSFER-DEPENDENT** | Working now, but tied to the development store and must be changed or re-verified when the store moves |
| 🔴 **MISSING** | Genuinely absent. Launch cannot proceed |
| ❓ **UNKNOWN** | Cannot be determined from here. Needs owner verification before it can be called either way |

**The headline is unchanged, and the reconciliation reinforces it: the
remaining blockers are commercial, not technical.** The platform is
deployed, healthy, migrated, secret-configured and serving signed App
Proxy traffic. What it does not have is a store that can take money and a
product to sell.

---

## Evidence gathered 2026-10-14 (all read-only)

| Check | Result |
|---|---|
| `flyctl status -a caratforus` | 1 app machine `started`, health check 1/1 passing |
| `GET /health` | `status: ok`, `database: ok` (7 ms) |
| Migrations | **90 applied, 0 pending** — identical to the 90 in the repo |
| `flyctl secrets list` | **25 secrets**, all status `Deployed` |
| Signed App Proxy `GET /apps/carat/policies` ×6 | 6/6 HTTP 200, **15 terms**, every term with text and version, `incomplete: false` on all six |
| `flyctl machines list` | 3 machines: 1 app + **2 scheduled cron machines** |
| `cron-guarantee-sweep` last runs | 14:08 and 15:08, `exit_code=0`. `curl -fsS` fails on non-2xx, so exit 0 proves the endpoint answered 2xx |
| Route probe | `/internal/jobs/group-buy-milestones` → **404**; `bank-payment-guarantee` and `group-buy-bank-payment-window` → 401 |

**One limit on the App Proxy evidence, stated rather than glossed.** Those
six requests were signed locally and sent **directly to
`caratforus.fly.dev`**. They prove the app works, the handler is correct
and `SHOPIFY_API_SECRET` matches. They do **not** re-prove that Shopify
routes `/apps/carat` through to the app, because that would mean going via
`caratforus-dev.myshopify.com`, which is password-protected and which I was
instructed not to request. Shopify-side routing was verified by the owner
earlier and is carried forward as owner-verified, not re-verified today.

---

## 0. Deployment currency — production is healthy but behind `main`

🔄 **This is the situation, exactly.**

The running app is healthy and fully functional. It is **not** running the
latest `main`.

- App machine last deployed **2026-10-14T00:04:46Z**.
- `main` is at **`6755d0e`**; four commits land after that deploy.
- Proven, not inferred: `/internal/jobs/group-buy-milestones` returns
  **404** in production while its sibling job routes return 401. That route
  ships in `157a216`.

What is actually missing from production as a result:

| Commit | In production? | Runtime impact |
|---|---|---|
| `157a216` Group Buy milestone emails | ❌ no | **The only real gap.** Participants get no tier/close emails |
| `5f33f0e` Slice 13 theme surfaces | n/a | Theme files; they deploy to Shopify, not Fly |
| `50fc7d8` test-fake fix + docs | ❌ no | None — a test fake and documents |
| `6755d0e` register update | ❌ no | None — a document |

**The database schema is NOT behind.** 90 migrations applied, 0 pending,
matching the repo exactly. A redeploy applies no migration.

**Consequence for sequencing:** the milestone cron cannot be scheduled
until a deploy happens, because the endpoint it would call does not exist
yet. Deploy first, schedule second.

---

## 1. Commercial — the real blockers

| # | Item | Status | Evidence / note |
|---|---|---|---|
| C1 | **A real catalogue.** No sellable product exists | 🔴 MISSING | See Track B in the action queue for exactly what is needed |
| C2 | **A store that can take payments.** `caratforus-dev.myshopify.com` is a development store | 🔴 MISSING | Development stores cannot process real transactions. This blocks every purchase path |
| C3 | **Bank payment coordinates** | 🟢 WORKING (one check) | `PAYMENT_ZELLE_RECIPIENT`, `PAYMENT_WIRE_BANK_NAME`, `PAYMENT_WIRE_ACCOUNT_NAME`, `PAYMENT_WIRE_ROUTING_NUMBER`, `PAYMENT_WIRE_ACCOUNT_NUMBER` all set and Deployed. ❓ **One thing to confirm —** `PAYMENT_ZELLE_RECIPIENT` has an identical digest to `STAFF_EMAIL_ALLOWLIST`, meaning the same value. That is fine if both are one address; it is wrong if the allowlist is a comma-separated list, because the Zelle recipient would then be unusable. Worth one look |
| C4 | **Terms of Service** | 🔴 MISSING | Four business decisions needed first — `docs/content/MVP1-STOREFRONT-COPY.md` Part 4 |
| C5 | **Privacy Policy** | 🔴 MISSING | Append-only evidence tables interact with deletion requests and need a lawful stated answer — Part 5 |
| C6 | **Shipping configuration in Shopify** — rates, insured value, the $100 signature rule | ❓ UNKNOWN | Policy is locked in the README; whether Shopify is configured for it cannot be seen from here |
| C7 | **Payment gateway and tax** in Shopify | ❓ UNKNOWN | Not visible from here, and moot until C2 |

---

## 2. Content

| # | Item | Status | Evidence / note |
|---|---|---|---|
| N1 | Six policy pages, correct templates, terms served live | 🟢 WORKING | Re-verified today: 6/6, 15 terms, `incomplete: false` |
| N2 | Policy page bodies are empty | 🔴 MISSING | Drafts written — `MVP1-STOREFRONT-COPY.md` Part 1 |
| N3 | About page copy | 🔴 MISSING | Draft written; needs 2–3 sentences only the owner has |
| N4 | Why Buy From Us copy | 🔴 MISSING | Draft written and grounded |
| N5 | FAQ entries | 🔴 MISSING | No `faq_entry` metaobject definition or entries in Admin, so the FAQ page renders nothing |
| N6 | Contact mailbox | 🟢 WORKING | `orders@caratforus.com`, owner-confirmed as monitored; fenced repo-wide. **Note:** `CUSTOMER_SERVICE_EMAIL` is deliberately *not* a Fly secret — nothing reads it at runtime. Do not set it |

---

## 3. Shopify Admin setup

| # | Item | Status | Evidence / note |
|---|---|---|---|
| S1 | Slice 12 policy theme files pushed | 🟢 WORKING | Theme `182948626733`, pushed by owner |
| S2 | FAQ theme files pushed | 🔴 MISSING | Committed `a764887`, not pushed to Shopify |
| S3 | Slice 13 theme files pushed | 🔴 MISSING | Committed `5f33f0e`, not pushed |
| S4 | `faq_entry` metaobject definition | 🔴 MISSING | Exact handles in `docs/specs/SLICE-12-CONTENT.md` §4.2. A wrong field key renders blank entries with no error |
| S5 | `carat.faq_entries` product metafield | 🔴 MISSING (optional for launch) | `product-faq.liquid` is implemented but deliberately unwired pending an owner decision on PDP placement |
| S6 | A `past-group-buys` page using the new template | 🔴 MISSING | Template ships in `5f33f0e`; the page must be created in Admin |
| S7 | Policy pages published | 🔴 MISSING | Deliberately hidden until N2 |
| S8 | App installed, OAuth valid, App Proxy routing | 🔄 TRANSFER-DEPENDENT | Owner-verified earlier on the dev store. **Must be re-verified end to end after any store transfer** — see Track A |

---

## 4. Deployment and operations

| # | Item | Status | Evidence / note |
|---|---|---|---|
| D1 | App deployed to Fly and healthy | 🟢 WORKING | Machine `started`, 1/1 checks, `/health` ok. **Behind `main` — see section 0** |
| D2 | Production Postgres attached and migrated | 🟢 WORKING | `database: ok` 7 ms; 90 applied, 0 pending |
| D3 | Core secrets | 🟢 WORKING | `DATABASE_URL`, `DIRECT_URL`, `SESSION_SECRET`, `CRON_SECRET`, `APP_ENV` — all Deployed. **Do not recreate these** |
| D4 | Shopify secrets | 🔄 TRANSFER-DEPENDENT | `SHOPIFY_API_SECRET`, `SHOPIFY_API_KEY`, `SHOPIFY_SCOPES`, `SHOPIFY_APP_URL`, `SHOPIFY_APP_PROXY_SUBPATH`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_API_VERSION` — all Deployed and working. `SHOPIFY_SHOP_DOMAIN` currently points at the dev store and **must change on transfer**; the API key/secret change too if a new app is created |
| D5 | Email provider | 🟢 WORKING (configured) | `EMAIL_API_KEY`, `EMAIL_FROM`, `STAFF_EMAIL_ALLOWLIST` all Deployed. ❓ No test send was performed — configured is proven, *delivery* is not |
| D6 | Object storage | 🟢 WORKING (configured) | All four `STORAGE_*` Deployed. ❓ No upload was performed from here |
| D7 | **Scheduled jobs — 2 of 4** | 🔄 PARTIAL | `cron-guarantee-sweep` (hourly) and `cron-price-recalculation` (daily) exist, target the correct endpoints with `CRON_SECRET`, and are exiting **0**. **Missing: `group-buy-bank-payment-window` and `group-buy-milestones`.** The latter cannot be scheduled until a deploy, because its route is currently 404 |
| D8 | Production reference data — pricing profile, metal prices, labor rates, stone costs | ❓ **UNKNOWN, and it gates Track B** | `prisma migrate deploy` runs as the release command; **it does not run the seed.** The 15 policy terms prove only that *migrations* ran, since policy text is migration-provisioned. Whether production holds a pricing profile and cost libraries cannot be seen from outside. **If it does not, no price can be calculated for any product** |

---

## 5. Engineering

| # | Item | Status | Evidence / note |
|---|---|---|---|
| E1 | Slices 0–13 implemented and merged | 🟢 WORKING | Tagged `mvp1-engineering-complete` at `c4420a1` |
| E2 | Group Buy milestone emails | 🟢 WORKING (in `main`) | `157a216`. **Not in production** — see section 0 |
| E3 | Slice 13 theme surfaces | 🟢 WORKING (in `main`) | `5f33f0e`. Not pushed to Shopify |
| E4 | CI green on `main` | 🟢 WORKING | Runs #116/#117 green on every step. 99/99 integration files and 1576 tests also pass locally |
| E5 | Live Shopify proof for Group Buy refund execution | 🟢 WORKING | 15/15 assertions against the real store |

**Feature development is stopped.** No further engineering until launch
testing exposes an actual defect.

### Note on CI run #115

It failed one assertion in the new milestone test. The cause was the **test
fake**: `RecordingGroupBuyParticipantEmailPort.seed()` did not clear a
previously seeded failure, so a "recovered" order kept throwing and it read
as the sweep failing to retry. The sweep was correct.

Reproducing it needed a real Postgres and this machine has no Docker, WSL
or installed Postgres, so a throwaway server from npm was used in the
scratchpad. **Anyone repeating that must initialise it with
`--encoding=UTF8`** — initdb otherwise defaults to the Windows locale's
WIN1252, `CREATE DATABASE` inherits it, and `webhooks/httpServer.test.ts`
then fails with Postgres 22P05 on an emoji in a payload, which looks like a
webhook defect and is not one.

---

## 6. What is NOT in this register

- Post-MVP functionality of any kind.
- `product-faq.liquid`'s PDP placement — implemented, unwired, awaiting an
  owner decision. Not a blocker; the FAQ page works without it.
- The optional "close to the next tier" Group Buy email. README permits it;
  the scope freeze excludes it.
- Performance work on the pricing job's query count. Real, recorded, not a
  launch blocker.
- **Anything already configured.** Core secrets, email, storage, bank
  coordinates and the two live cron jobs are done, and the action queue
  does not ask for them again.

---

## 7. The two parallel tracks

These do not depend on each other and should run at the same time. Track A
is entirely owner work. Track B needs one input from the owner and is then
mostly engineering.

### Track A — commerce-store activation (owner)

Strictly ordered; each step depends on the one before.

1. **Decide: convert `caratforus-dev` to a paid plan, or stand up a new
   production store.** Everything else in this track waits on it. Converting
   keeps the app install, the theme, the policy pages and the App Proxy
   configuration intact, which is a substantial amount of verified setup.
   A new store means redoing all of it.
2. **Payment gateway** — Shopify Payments or a provider, activated and
   able to take a live card.
3. **Tax** — registration and Shopify tax configuration.
4. **Shipping configuration** (C6) — rates, full-value insurance, and the
   locked rule that anything over $100 requires signature.
5. **Confirm the Zelle recipient** (C3) — it currently holds the same value
   as `STAFF_EMAIL_ALLOWLIST`.
6. **Post-transfer re-verification**, only if the store identity changes:
   - update `SHOPIFY_SHOP_DOMAIN`, and `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`
     if a new app is created;
   - reinstall the app and re-grant scopes;
   - reconfigure the App Proxy subpath and re-verify routing **through the
     storefront**, which is the half not provable from the app side;
   - re-register webhooks and confirm delivery;
   - re-push the theme.

### Track B — the first real product

**What to create first: a single-variant, no-stone, fixed-size pendant or
chain in sterling silver.**

Not a ring, and not for aesthetic reasons. A ring drags in the ring-size
band model, `weightPerFullSizeGrams`, size-band weight overrides and a
per-size price surface — four systems that can each fail independently on
a first run. `sizeAxis: none` removes all of it. No stones removes the
stone cost library. Sterling silver keeps the metal reference price
simple. The goal of the first product is to prove
**Map → Calculate → Approve → Sync → Verify** end to end, and every extra
dimension is another way for that proof to be ambiguous.

Rings, stones and multi-variant products come second, once the path is
known to work.

**Blocking unknown first:** D8. If production holds no pricing profile and
no cost libraries, nothing can be priced. That has to be settled before
any of the data below is useful.

**Exactly what is needed from the owner:**

| # | Field | Example | Why |
|---|---|---|---|
| 1 | Product name and category | "Rope Chain 20in", `chain` | `MasterProduct.name` / `.category` |
| 2 | Metal and purity | `sterling_silver` / `925` | Selects the metal reference price |
| 3 | Finished weight in grams | `8.4` | `baseWeightGrams`. The single biggest cost driver |
| 4 | Labor source and cost | `china`, and the per-unit labor cost | `LaborSource` + `LaborRate` |
| 5 | Current silver reference price | per troy ounce or per gram, and as-of date | `MetalReferencePrice` |
| 6 | Any per-unit extras | plating, packaging, QC, inbound freight | `CostComponent` |
| 7 | Target markup and minimum margin floor | — | `PricingProfile`, **only if production has none** |
| 8 | Product photographs | — | For the Shopify product |

With 1–6 (and 7 if needed) the engineering side can run: map the master
product and variant, calculate the Bank Payment Price, derive the
Regular/Card Price under the locked tier-and-$5-rounding rules, approve,
sync to Shopify, and verify the published price matches the calculation.
