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
| C2 | **A store that can take payments.** | 🔴 MISSING | **Confirmed by Shopify CLI 2026-10-14: `Type: Dev`, Plan Basic, created Sep 17 2026, org "My Store" (236195662).** It is a development store, not a client transfer store. Whether *this* store can be transferred depends on the purpose it was created with, which the CLI does not expose — owner is checking for a "Transfer ownership" action in the Partner/Dev Dashboard. **All Shopify catalogue mutations are held until that answer**, so we do not create product IDs in a store we may abandon |
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
| D7 | **Scheduled jobs — all 4** | 🟢 GREEN | `cron-guarantee-sweep` (hourly), `cron-price-recalculation` (daily), and as of 2026-10-15 `cron-group-buy-bank-payment-window` and `cron-group-buy-milestones` (both hourly). Each was invoked authenticated and verified by **its own evidence**, not by an exit code — see below |
| D8 | Production reference data | 🟢 **RESOLVED 2026-10-14** | Answered by a read-only probe run inside the container. The seed *has* run: a pricing profile, all three labor sources, all 15 cost components, three metal references and five stone-cost rows exist. **Nothing is missing.** What remains is validating market/supplier values — tracked as P3 below, not here |

---

## 4a. Pricing

**The pricing system is not a launch blocker.** Its operating numbers are
configurable by design, and a configurable value sitting at a default is
not an unresolved decision.

| # | Item | Status | Evidence / note |
|---|---|---|---|
| P1 | **Pricing engine and schema** | 🟢 WORKING | Profile, metal, labor, stone and component models all populated in production; 94 calculations already recorded |
| P2 | **Pricing-profile operating defaults — 40% target markup, 20% minimum gross margin, $100 minimum profit** | 🟢 **VALUES SETTLED — not an owner decision** | Owner-locked 2026-10-14 as *configurable operating inputs*. Active profile `buy_now` v5, `is_placeholder: false`. **Do not ask the owner to reconfirm these.** Note: *settled* is about the values, not the tooling — see P6 |
| P6 | **Operator tooling — pricing profile, metal, labor, stone** | 🟡 **YELLOW overall** — see lifecycle below | Implementation complete and tested; **not yet deployed or smoke-tested in production** |
| P7 | **Operator tooling — cost components** | 🟡 **YELLOW overall** — see lifecycle below | Implementation complete and tested; same lifecycle gate as P6 |

### P6 / P7 lifecycle — "GREEN" means deployed and usable, not merged

Compressing these three states into one colour is how a register starts
lying. They are tracked separately.

| Stage | P6 (profile, metal, labor, stone) | P7 (cost components) |
|---|---|---|
| **IMPLEMENTED / TESTED** | 🟢 GREEN | 🟢 GREEN |
| **DEPLOYED to production** | 🟢 GREEN — `8ddc275`, 2026-10-15 | 🟢 GREEN — same deploy |
| **LIVE OPERATOR SMOKE TEST** | 🔴 **owner action** | 🔴 **owner action** |
| **Overall** | 🟡 YELLOW | 🟡 YELLOW |

Deployment verified: `/health` ok, database ok, **90 migrations applied, 0
pending**, the offline Shopify session survived (six signed App Proxy policy
groups still return 15 terms), and `/app/pricing-settings` returns 410 —
identical to every other working embedded route, where a genuinely missing
route returns 404. So the route is registered and authenticating.

**The last stage needs a browser session I do not have.** Opening the page
inside Shopify Admin and confirming it displays the real 40% / 20% / $100
and the current metal, labor, stone and component values is the owner's
step. No configuration write is needed to prove it — and deliberately so:
the first real write should be an actual Product #1 cost update, not a
throwaway version created to test a form.
| P3 | **Production cost inputs** — gold, stone, labor, metal loss, casting/setting/polishing/assembly/QC, packaging, shipping, insurance, warranty reserve, supplier fee | 🟡 YELLOW | Every row exists and resolves; all are seed fixtures dated `2026-01-01` and self-labelled "not a real market quote / supplier quote / cost assumption". **Validate for Product #1 before publishing it.** Not a blocker on the engine — only on publishing a real SKU |
| P4 | **Card-price derivation** | 🟢 WORKING | Active profile carries `BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1` — the approved tiered uplift with upward-to-$5 rounding on the Regular/Card Price only |
| P5 | **Fixture catalogue cleanup** | 🟡 YELLOW | Required before public operation; **not a reason to resume feature development.** Proposal prepared, not executed — see section 8 |

### Auditability — verified, not assumed

The owner's requirement that historical calculations stay reproducible is
**enforced by the database**, not by convention. Verified 2026-10-14:

- `metal_reference_price`, `stone_cost`, `cost_component`, `pricing_profile`
  and `labor_rate` each carry `no_update`, `no_delete` and (where applicable)
  `no_truncate` triggers. **A historical row physically cannot be rewritten
  in place.** Changing a value means inserting a new effective-dated row.
- `PriceCalculation` pins `pricingProfileId`, `profileVersion`,
  `engineVersion`, `roundingRuleId`, `priceEndingRuleId` and a frozen
  `snapshotId` of the resolved inputs.

So new calculations resolve current values, old ones remain reproducible,
and no future change can retroactively alter recorded evidence.

### The operator surface, and what makes it GREEN

`app/routes/app.pricing-settings.tsx`, built 2026-10-14 to close the gap the
architecture audit found. Scoped to the gap and nothing more: no dashboards,
no charts, no commodity feed, no bulk import, no channel management.

| Level | Result |
|---|---|
| A — data-driven | ✅ was already true |
| B — runtime-resolved | ✅ was already true |
| C — operator-configurable | ✅ **closed by this work** |
| D — safely configurable | ✅ **closed by this work** |

What makes it safe rather than merely present:

- **Version is system metadata.** `createNextPricingProfileVersion` allocates
  it server-side; the operator cannot see or choose a version number.
  Concurrency rides the existing `(code, version)` unique index with a bounded
  deterministic retry, not an unprotected `MAX(version) + 1`.
- **The three profile values save as ONE version.** They are one policy, not
  three independent settings.
- **Everything not typed is inherited** from the current profile — margin
  model, currency, rounding rule, price-ending rule, card-price rule and
  uplift rate. A settings form that silently reset the card rule would be a
  pricing incident dressed as a UI convenience.
- **Validation is real.** The database CHECK that appears to guard these
  fields is vacuous under `MARKUP_ON_COST_V1` (it compares against a NULL
  `target_gross_margin_rate`), so `domain/pricing/profileSettings.ts` is the
  actual guard: markup required and non-negative with no invented ceiling,
  margin in [0, 100), profit non-negative, exact decimal throughout. No
  binary floating point anywhere.
- **Actor comes from the session**, never a form field. Writes require an
  ONLINE Shopify session with an associated user and 401 without one.
- **Audit in the same transaction** as the row, via the existing
  `audit_event` table, carrying the prior and new version and values.
- **Nothing publishes.** The route reaches no Shopify API. Configuration →
  recalculation → calculation → approval/sync intent → Shopify is unchanged,
  and production keeps `PRICE_AUTO_PUBLISH_ENABLED=false`.

**Cost components are covered too (P7).** One generic editor rather than
eleven forms, because the model already generalises them: the natural key is
`(componentType, valueKind)` — which is why `payment_processing` legitimately
appears twice, as a fixed fee and a percentage — and the only shape
difference is which value column is populated. That is not an abstraction
imposed on the schema; it is the existing
`cost_component_value_kind_matches_value` CHECK. **`payment_adjustment` is
excluded**, reading the existing `INERT_COMPONENT_TYPES` export rather than a
second hand-written opinion: nothing resolves it, so a value entered there
would look like it worked and change no price.

**Input boundary, hardened after a pre-deployment review.** The first
revision passed form values into Prisma through `as never`, which is erased
at build time and validates nothing. Two real findings came out of it:

- **`currency` was unvalidated against a `char(3)` column, and Postgres
  BLANK-PADS a short value.** `currency=US` would have been stored as `"US "`
  with no error at any layer, then never matched `"USD"` again. That is
  silent corruption rather than a rejected request, and it is the finding
  that justified the review.
- Unknown enum values reached the database layer unexamined. Prisma did
  reject them, so nothing bad could be stored — but the operator got an
  opaque 500, and relying on a downstream library to be the input boundary
  fails the moment a column is more forgiving than expected, which `currency`
  was.

Both are closed in `domain/pricing/configurationInput.ts`, which validates
every enum against **Prisma's generated runtime objects** — the same
definition the schema and database share, never a retyped list — and applies
numeric rules that follow the database's own stance rather than inventing
limits: metal price `> 0` (matching `metal_reference_price_positive`), labor
rate `>= 0` (matching `labor_rate_non_negative`), stone cost `> 0` (no CHECK
exists, so the boundary is the only guard), component amounts `>= 0`, carat
band half-open with `max > min`.

**Stone-cost display, corrected.** The first revision listed every row with
`effectiveFrom <= now`, showing superseded costs beside live ones and
implying several prices for one stone were simultaneously in force. It now
collapses to the currently effective row per logical key — type, shape, band
and every qualifier — which is exactly what `selectMostSpecific` does
(filter applicable, highest specificity, then latest `effectiveFrom`). Rows
differing in any qualifier are genuinely co-applicable at different
specificities and all remain visible; collapsing harder would hide real
configuration.

**One production cost this feature would have introduced, fixed.**
`resolveActivePricingProfile` loaded the entire version history for a code on
every price calculation and used its first row. Invisible while versions
only appeared when an engineer edited the seed; with operator-created
versions becoming routine, the cost would grow with how often the business
changes its mind. `findFirst` with identical `where` and ordering returns
the same row in constant time. It surfaced in the shared integration
database, where the extra rows pushed two already-slow pricing tests past
their timeout and the full suite from 1143s to 651s.

**Known limitation, reported rather than worked around:** there is no
"recalculate now" button. `runPriceRecalculation` with no `variantIds` sweeps
every active variant and is measured in tens of seconds; running it inside an
embedded admin request would block past any sane timeout, and doing it
properly needs a job-status surface with polling — materially more scope than
this gap. The daily `cron-price-recalculation` already picks up configuration
changes, and every save message tells the operator that prices update at the
next recalculation.

### Profile scope — one profile serves more than Buy Now

`PricingProfileCode` defines six codes (`buy_now`, `group_buy`, `custom`,
`wholesale`, `friends_family`, `marketplace`). **Only `buy_now` is ever
resolved.** Verified: `resolveInputs.server.ts:120` and
`runRecalculation.server.ts:250` both call
`resolveActivePricingProfile("buy_now", asOf)`, and
`app.custom-jewelry.$id.tsx:412` reads `code: "buy_now"` directly.

So changing the Buy Now profile also changes Custom Jewelry card-price
derivation and the economics any *future* Group Buy campaign freezes at
open. Already-open campaigns are insulated — proven, see below. The
per-channel capability the schema allows is **not implemented**.

✅ **The resolution inconsistency is FIXED (2026-10-14).**
`app.custom-jewelry.$id.tsx` carried its own
`findFirst({ orderBy: { version: "desc" } })` with no `effectiveFrom` filter,
so a future-dated profile took effect there immediately while Buy Now
correctly ignored it until its date. It now calls the same
`resolveActivePricingProfile` the rest of pricing uses, so there is one
definition of "current profile" in the codebase. The placeholder refusal is
preserved and now applies to the profile genuinely in effect.

Pinned two ways in `pricingConfigurationPropagation.test.ts`: behaviourally
(a future-dated version does not move the card price Custom Jewelry would
quote, and does once its date arrives) and structurally (the route must call
the shared resolver and must carry no `prisma.pricingProfile` query of its
own) — because a behavioural test alone cannot see the thing that regressed.

### Already-open Group Buys are insulated — proven by test

`tests/integration/groupbuy/frozenRuleVersioning.test.ts`, "a later profile
change cannot reach a frozen campaign": a new profile version with a
different uplift rate leaves an open campaign's bank price, card price and
savings byte-identical. The mechanism is that `openCampaign.server.ts`
stores `pricingProfileId` + `profileVersion` on the campaign and the
storefront reads that frozen row, so no later insert can reach it.

### Payment processing is a cost input, not a price rule

`payment_processing` (currently 2.9% + $0.30, `basis: revenue_side`) is a
**configurable cost/audit input only**. It does not and must not participate
in deriving the customer-facing Regular/Card Price, which is governed solely
by the approved Bank-vs-Card rule: Bank Payment Price is the underlying
calculated selling price, the Regular/Card Price is derived afterwards by
the tiered uplift, and only the Card Price is rounded up to the next $5.
Updating the processing rate when a real gateway is chosen changes cost and
margin maths; it leaves the Bank-vs-Card model untouched.

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

1. **Check whether `caratforus-dev` offers "Transfer ownership"** in the
   Partner/Dev Dashboard, then either retain it or stand up a production
   store. Everything else in this track — and the whole of Track B — waits
   on this. Retaining preserves the verified app install, theme, policy
   pages and App Proxy configuration. **Now is the cheapest possible moment
   to move**: there is no catalogue, no FAQ metaobjects and no collections
   to lose, and the 15 policy terms live in Postgres rather than Shopify, so
   they survive either way.
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

**LOCKED (owner, 2026-10-14): a 14K gold solitaire pendant with one
lab-grown diamond.** Fixed configuration, single Shopify variant,
`sizeAxis: none`, no ring-sizing model, one centre stone.

An earlier draft of this register proposed a sterling-silver SKU on
simplicity grounds. That was wrong for the purpose: a throwaway product has
no launch value. The locked archetype proves the real CaratForUs path —
metal + purity + weight + labor + stone + components + pricing profile +
Bank/Card derivation + Shopify sync — while `sizeAxis: none` still excludes
the ring-size band model, `weightPerFullSizeGrams`, weight overrides and the
per-size price surface.

14K costs nothing extra on the metal side: `purity.ts` computes
`pure_reference_price_per_gram × fineness × grams`, so one
`MetalReferencePrice(gold)` row serves 10k/14k/18k.

**Blocked on the Shopify-store decision**, deliberately. No product is
created or mapped until it is settled, so Shopify IDs are not minted in a
store we may abandon.

**Owner inputs, agreed 2026-10-14:** product name; finished 14K weight in
grams; whether a chain is included and if so its length and weight; stone
shape; carat; intended colour/clarity/cut; actual supplier cost for the
stone; labor source and real rate; current pure-gold price with as-of date;
realistic metal-loss percentage; and the applicable component costs
(casting, setting, polishing, assembly, QC, packaging, shipping, insurance,
warranty reserve, supplier fee). CAD may legitimately be zero for a stock
pendant.

**Stone coverage.** The existing library covers lab round and lab princess
over **[0.90, 1.10) ct** only — a half-open interval, so 1.10 itself is not
covered. If the real pendant is a commoner pendant size (0.25–0.75 ct),
a new effective-dated `StoneCost` band is created **from the owner's real
supplier cost**, never invented to make the engine resolve. A missing band
raises `MissingCostInputError`, so the engine fails closed rather than
pricing a stone at zero.

**MVP1 stone-costing policy, stated plainly.** The *resolver* supports
quality tiers — `selectMostSpecific` prefers a row matching colour, clarity,
cut grade, lab status or supplier over a less specific one. The *data* does
not: every current row leaves those qualifiers NULL, so they act as
wildcards and cost varies only by stone type, shape and carat band. The
database does not differentiate quality today. Adding a more specific row
later will take precedence automatically, with no code change.

---

### The two new cron jobs, and what invoking them actually proved

Verifying the job's own output rather than the exit code was the right
instruction, and it immediately paid.

**`group-buy-milestones` → HTTP 200**, and:

```json
{"campaignsExamined":3,"milestonesDispatched":1,"emailsSent":0,
 "emailsAlreadySent":0,"emailsFailed":3,"recipientsUnresolved":0}
```

`curl -fsS` exited 0. **Three sends failed.** The job worked perfectly —
it found an open campaign at `best_tier:2`, resolved three participants,
built the emails, called the provider and recorded each failure with the
campaign, the milestone, a recipient fingerprint and the error name, with
no address in plaintext. What failed is the data: the campaign is
**`ZZ LIVE GATE TEST CAMPAIGN — DO NOT PUBLISH`, still `open` in
production, with all three participants on `@example.com`.**

⚠️ **This makes the fixture cleanup time-sensitive rather than cosmetic.**
A failed milestone deliberately leaves the milestone incomplete so it
retries — so from now on this produces **three failed sends every hour**,
against a real email provider, for addresses that cannot exist. Harmless
to customers, but it burns provider reputation and is exactly the kind of
recurring error that trains people to ignore the log where a real failure
will later appear. Closing or archiving that campaign stops it.

**`group-buy-bank-payment-window` → HTTP 200**, and:

```json
{"now":"2026-10-15T03:45:08.859Z","ordersConsidered":5,
 "inactivated":5,"kept":0,"errored":0}
```

**This one changed production state**, and that is worth stating plainly
rather than burying: it inactivated five Group Buy bank-payment orders.
All five were fixture/live-gate orders long past their 96-hour window —
they had been sitting overdue precisely because this job had never been
scheduled — so the job did exactly what it exists to do on its first run.
Inactivation is internal bookkeeping only (the enum's own comment: the
Shopify order and the counted units are untouched) and is reversible by
staff reactivation.

---

## 8. Fixture catalogue cleanup — proposed, NOT executed

Production carries seed and live-gate fixtures. The concrete harm today is
narrow but real: **four active fixture variants are processed by the daily
production recalculation cron.** None is synced to Shopify
(`shopify_variant_gid` is null), so nothing is customer-visible — but an
active fixture product in a production catalogue is what surfaces at the
worst possible moment.

**The lever is `status`, and it is safe and reversible.** Verified:
`runRecalculation.server.ts` selects `{ status: "active" }` and nothing
else consumes active master variants; `MasterProductStatus` and
`MasterVariantStatus` are both `draft | active | archived`; and the
catalogue tables carry **no** append-only triggers, so a status change is a
normal, reversible update. Archiving removes a variant from recalculation
and sync without touching one row of evidence.

| Row | Current | Proposed | Why |
|---|---|---|---|
| `Seed Fixture Solitaire Ring` (product) | `active` | **archive** | Pure seed fixture; a ring, which we are not launching with |
| Its 3 active 14k gold variants | `active` | **archive** | Stops them entering daily recalculation |
| Its 1 active pt950 variant | `active` | **archive** | Same |
| `ZZ livegate storefront …` (product) | `archived`, has `shopify_product_gid` | **leave as-is in Postgres** | Already archived. Its Shopify side is handled below |
| `ZZ LIVE GATE TEST — DO NOT SELL …` (product) | `draft` | **leave as-is** | Draft never reaches recalculation |
| **`ZZ LIVE GATE TEST CAMPAIGN — DO NOT PUBLISH`** (Group Buy campaign `dcccf42e…`) | **`open`** | **close or archive — now the most urgent item here** | Discovered 2026-10-15 when the milestone cron ran. An OPEN campaign with three `@example.com` participants, generating three failed provider sends every hour. Closing it ends the noise; archiving additionally hides it from staff views. Its three bank-payment orders were inactivated by the window job's first run |
| Its 1 archived + 1 draft variant | archived / draft | **leave as-is** | Already excluded |
| 94 `price_calculation`, 93 `price_sync_intent`, all snapshots | — | **UNTOUCHED** | Historical evidence. Archiving the variant does not break the foreign keys that reference it |
| `policy_version`, acknowledgments, audit records | — | **UNTOUCHED** | Never in scope |

**Nothing is hard-deleted.** No DELETE on any fixture row is proposed, and
the evidence tables are append-only in any case.

### Shopify side, split by outcome

| | If `caratforus-dev` is retained | If a new production store is created |
|---|---|---|
| `gid://shopify/Product/10357871313197` (the live-gate storefront product) | Must be deleted or unpublished **in Shopify Admin** — it is a real product record in that store | Disappears on its own; the new store starts clean |
| The one draft variant holding a `shopify_variant_gid` | Same — remove in Admin | Disappears |
| **Postgres fixture records** | Archive as proposed above | **Still need archiving.** A new store does not clean the database |

That last cell is the one worth not missing: moving store solves the
Shopify half and none of the Postgres half.

**Not executed.** Proposed for owner approval first.
