# MVP1 Launch Blocker Register

**Current as of 2026-10-22. `main` = `5d24640` (application code unchanged since `c14c94c`).**
**Production Shopify store: `CaratForUs` — `caratforus.myshopify.com` (permanent domain `nnb1th-cm.myshopify.com`).**

The single authoritative list of what stands between CaratForUs and taking
a real customer's money.

This is a *launch* register, not a backlog. An item appears only if MVP1
cannot open without it. It states current truth once; superseded findings
live in §9 as history, never as open items.

---

## The one-paragraph answer

**The production store exists and is wired to the production backend; the
business is not ready.** On 2026-10-22 the real merchant store was created,
the existing CaratForUs app was installed on it (same app, same client, no
secret rotated), Fly was repointed at it, and App Proxy, webhooks, the theme,
the six policy pages, FAQ infrastructure and the Slice 13 page were verified
**through the new storefront**. The storefront remains password-protected.
What is missing is commercial and owner-only: payments (KYC), tax, shipping
rates, Terms of Service, Privacy Policy, approved page copy and FAQ entries,
a real catalogue, and real cost inputs to replace the `2026-01-01` fixtures.

---

## How to read it

| Status | Meaning |
|---|---|
| 🟢 **DONE** | Verified working, with the evidence named |
| 🟡 **PARTIAL** | Works, but with a stated limit or an unverified half |
| 🔴 **BLOCKER** | Launch cannot proceed until this is done |
| ❓ **UNKNOWN** | Cannot be determined from here; needs owner verification |

---

## 1. Commercial — the real blockers

| # | Item | Status | Evidence / note |
|---|---|---|---|
| C1 | **A real catalogue** — no sellable product exists | 🔴 BLOCKER | Unblocked by C2 but not started: Product #1 waits on real owner inputs (§8 Track B) and on P3 |
| C2 | **A payment-capable store** | 🟢 DONE (store) / 🔴 payments not active | Production store created 2026-10-22 on the **Grow** plan ($1/mo promotional until 2027-01-21, then $105/mo — owner chose Grow over Basic). See §2. Card processing is C7 |
| C3 | **Bank payment coordinates** | 🟢 DONE | All five `PAYMENT_*` secrets Deployed. **Owner confirmed 2026-10-22: `PAYMENT_ZELLE_RECIPIENT` is exactly one recipient** (it shares a digest with `STAFF_EMAIL_ALLOWLIST`, so that allowlist is a single address too). Shopify manual-payment instructions not yet configured — Phase 14 |
| C4 | **Terms of Service** | 🔴 BLOCKER | Does not exist. Four business decisions needed first — `docs/content/MVP1-STOREFRONT-COPY.md` Part 4 |
| C5 | **Privacy Policy** | 🔴 BLOCKER | Does not exist. Append-only evidence tables interact with deletion requests and need a lawful stated answer — Part 5. Note: Shopify auto-created a "Your Privacy Choices" page on the new store that refers to a Privacy Policy |
| C6 | **Shipping configuration in Shopify** | 🔴 BLOCKER | Not configured. Needs owner rates/zones/packages; the $100 signature rule needs an operational mechanism, not policy text |
| C7 | **Payment gateway and tax** | 🟢 payments DONE / 🔴 tax not configured | **Shopify Payments active 2026-10-24** (owner completed KYC): accepting payments, receiving payouts (daily, Shopify Balance), CVV verification on. Real rate on Grow: **2.7% + $0.30 online** (2.5% + $0.10 in person). The pricing audit input was updated to match — see P3. The customer Card Price rule (`BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1`) is unchanged. Tax not yet configured |

---

## 2. The production store (C2) — migrated 2026-10-22

`caratforus-dev` is a development store with no transfer or upgrade path
(determined 2026-10-15). It was **replaced, not converted**, and is left in
place untouched — app install and session included — until the new store is
fully live.

### The store

| Property | Value |
|---|---|
| Display name | **CaratForUs** |
| Primary myshopify domain | **`caratforus.myshopify.com`** (one further myshopify rename remains) |
| Permanent domain | **`nnb1th-cm.myshopify.com`** — what Shopify sessions, App Proxy signatures and webhooks identify the shop by. **This, not the friendly name, is `SHOPIFY_SHOP_DOMAIN`** — proven from the install log, where the offline and online sessions were both created for `nnb1th-cm.myshopify.com` |
| Organization | "My Store" (236195662) — the same organization that owns the app |
| Type / plan | Production / **Grow** |
| Storefront | **Private (password-protected)** |
| Live theme | **CaratForUs MVP1 `#187633434842`**, pushed from `theme/` at `5d24640`. Shopify's default Horizon theme is kept unpublished as the rollback |

### How the app moved — same app, no new client

The app belongs to the store's own organization, so Shopify installs it on
any store in that organization from the Dev Dashboard (**Apps → ⋮ → Install
app**). No distribution method was chosen, no new app was created, and
`SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` were **not** rotated. The only Fly
change was `SHOPIFY_SHOP_DOMAIN` → `nnb1th-cm.myshopify.com` (release #42).

Webhook subscriptions and the App Proxy are **declared in the app version**
(`caratforus-development-13`) and attach to every installation, so there was
nothing to re-register and no way to create duplicates.

### Verified on the new store

| Check | Evidence |
|---|---|
| Embedded admin + OAuth | Install granted the version-13 scopes; app opens embedded and authenticated |
| Pricing Settings | Profile v5, **40 / 20 / 100.00**, read from the production database; labor rates present. Nothing written |
| Fly / database | Release #42 healthy; `/health` ok; applied migrations = the 90 in the repo, **0 pending**; required policy versions present |
| App Proxy — backend half | Direct unsigned `GET caratforus.fly.dev/apps/carat/policies` → `{"error":"unauthorized"}`, logged `invalid_or_missing_signature` |
| App Proxy — Shopify half | `caratforus.myshopify.com/apps/carat/policies` → signed request reached Fly with `shop=nnb1th-cm.myshopify.com` → **6 groups, 15 terms, `incomplete: false`** |
| Webhooks | A throwaway draft product ("ZZ webhook test — DO NOT SELL", never active, now **archived**) produced exactly one `products/update` delivery per change (2 changes → 2 deliveries), both **200**, handled by our receiver (which returns 401 on HMAC failure). `inventory_levels/update`, `orders/create`, `orders/paid` are the same subscription set but **not yet observed firing** — they need stock changes or a real order, so they are proven in the launch rehearsal |
| Six policy pages | See N1 |
| Past Group Buys | See S6 |
| FAQ | See S2/S4 |
| Old dev store | Install and session still present; untouched |

---

## 3. Content

| # | Item | Status | Evidence / note |
|---|---|---|---|
| N1 | Six policy pages, correct templates, terms served live | 🟢 DONE (production store, live-tested) | Created 2026-10-22, each verified in the storefront: Returns and Cancellations (`policy-returns`, 1 term), Warranty (`policy-warranty`, 1), Luxury Steals (`policy-luxury-steals`, 1), Group Buy (`policy-group-buy`, 3), Custom Jewelry (`policy-custom-jewelry`, 3 — final-approval term at **Version 2**), Let Us Beat Your Quote (`policy-quote-match`, 6). **15 terms**, version labels shown, no Loading or error state, empty bodies so nothing is duplicated. Handles: `returns-and-cancellations`, `warranty`, `luxury-steals`, `group-buy`, `custom-jewelry`, `let-us-beat-your-quote` |
| N2 | Policy page bodies are empty | 🔴 BLOCKER | Drafts written — `MVP1-STOREFRONT-COPY.md` Part 1, **still DRAFT, not owner-approved**; nothing published from it |
| N3 | About page copy | 🔴 BLOCKER | Draft written; needs 2–3 sentences only the owner has. No About page created |
| N4 | Why Buy From Us copy | 🔴 BLOCKER | Draft written and grounded in README + locked pricing policy. Not approved; no page created |
| N5 | FAQ entries | 🔴 BLOCKER | Definition and page now exist (S4); **no entries** — there is no approved FAQ copy, so the FAQ page shows only its title |
| N6 | Contact mailbox | 🟢 DONE | `orders@caratforus.com`, owner-confirmed, fenced repo-wide. `CUSTOMER_SERVICE_EMAIL` is deliberately *not* a Fly secret — nothing reads it at runtime. Do not set it |
| N7 | Contact page + form routing | 🟢 DONE (live-tested) | `/pages/contact` (template `contact`) carries the **owner-approved wording verbatim**; Shopify's contact form renders below it; store contact email `orders@caratforus.com`. **Delivery proven 2026-10-24:** a test submission (marker `CONTACT-FORM-TEST-20261024-1546`) was accepted by Shopify ("Thanks for contacting us") and the **owner confirmed it arrived in the monitored `orders@caratforus.com` inbox**. Note: Dawn's form shows an optional "Phone number" input — collected, not advertised as support |

---

## 4. Shopify Admin setup

All items below refer to the **production store** (`caratforus.myshopify.com`).

| # | Item | Status | Evidence / note |
|---|---|---|---|
| S1 | Complete theme pushed and published | 🟢 DONE | `shopify theme push --unpublished` from `theme/` (391 files) → **CaratForUs MVP1 `#187633434842`**; previewed, then published 2026-10-22 behind the storefront password (owner-approved — Shopify only offers templates from the *published* theme when assigning a page template). All 12 page templates present, including the six `policy-*`. ⚠️ A second unpublished theme also named "CaratForUs MVP1" exists (from an earlier mistyped push attempt) — unused, safe to delete by the owner |
| S2 | FAQ theme files pushed | 🟢 DONE | Part of S1 |
| S3 | Slice 13 theme files pushed | 🟢 DONE | Part of S1 |
| S4 | `faq_entry` metaobject definition | 🟢 DONE (configured) | Type `faq_entry`; fields `question` (single line, required), `answer` (rich text, required), `category` (single line), `sort_key` (integer) — exactly the §4.2 handles. Storefronts API access on; not published as web pages. FAQ page `/pages/faq` uses template `faq`. **No entries** — N5 |
| S5 | `carat.faq_entries` product metafield | 🟡 PARTIAL (optional for launch) | Not created — not needed until an owner decision on PDP placement |
| S6 | `past-group-buys` page | 🟢 DONE (live-tested) | `/pages/past-group-buys`, template `past-group-buys`. Archive renders its designed empty state ("No Group Buys have closed yet…") — confirming the archived ZZ fixture campaigns stay hidden — and **Request New Group Buy** renders with its disclosure served live from Postgres. **Bring It Back** renders only on a closed campaign, so it is correctly absent. No test submission made (it would write a fake demand row into production) |
| S7 | Policy pages published | 🟡 PARTIAL | The six pages are set **Visible** so they can be verified — a Hidden page 404s even in admin preview — but the storefront password keeps them non-public. Still gated by N2 before public launch |
| S8 | App installed, OAuth valid, App Proxy routing, webhooks | 🟢 DONE (production store) | See §2. Webhooks: `products/update` live-proven; the other three subscriptions await the launch rehearsal |
| S9 | Storefront password | 🟢 ON | Private mode. **Must stay on** until §8 Track A and C4/C5 are done |

---

## 5. Deployment and operations

| # | Item | Status | Evidence / note |
|---|---|---|---|
| D1 | App deployed to Fly and healthy | 🟢 DONE | **Production runs the application code of `main`.** Last code deploy `c14c94c`; every later commit is documentation. Release #42 (2026-10-22) was a secrets-only deploy. `/health` ok, database ok |
| D2 | Postgres attached and migrated | 🟢 DONE | **90 migrations applied, 0 pending** — identical to the 90 in the repo |
| D3 | Core secrets | 🟢 DONE | `DATABASE_URL`, `DIRECT_URL`, `SESSION_SECRET`, `CRON_SECRET`, `APP_ENV` all Deployed. **Do not recreate these** — regenerating `CRON_SECRET` would silently break all four cron jobs |
| D4 | Shopify secrets | 🟢 DONE | All seven `SHOPIFY_*` set. **`SHOPIFY_SHOP_DOMAIN` = `nnb1th-cm.myshopify.com`** (the production store's permanent domain — not `caratforus.myshopify.com`), deployed in release #42. API key/secret unchanged — same app. That deploy also synced the four scheduled machines, clearing Fly's "secrets partially deployed" warning |
| D9 | **Request log printed Shopify session tokens** | 🟢 DONE (deployed, live-verified) | `react-router-serve`'s built-in `morgan("tiny")` logged full URLs (`id_token`, `hmac`, `session`, App Proxy `signature`, `logged_in_customer_id`). Fixed by a `node --require` preload that logs the path only — PR #3, merged to `main` `c01b944`, deployed 2026-10-24. **Verified in the Fly log:** the same admin load that printed `?…id_token=…` now logs `GET /app/pricing-settings 200` |
| D10 | Fly Doctor "machines restarting too much" | 🟢 NOT A FAULT | Names `8654d99c9322d8`, a scheduled-job machine that starts, runs and exits by design. The app machine is stable and `/health` returns 200 every 30 s |
| D11 | **Every embedded-admin form save failed in production (400)** | 🟢 DONE (deployed, live-verified) | Fly terminates TLS, so `request.url` was `http://` while the admin's Origin is `https://`; React Router's CSRF guard (production allowlist `[]`) rejected every `/app` action before auth. Fixed by always allowing the app's own host `caratforus.fly.dev` (pinned to the TOML) — PR #2, merged `51f1800`, deployed 2026-10-24; integration test against the production build proves own-origin passes and foreign/look-alike origins are still rejected. **Verified live:** `POST /app/pricing-settings.data 200` and the row below was written |
| D5 | Email provider | 🟡 PARTIAL | `EMAIL_API_KEY`, `EMAIL_FROM`, `STAFF_EMAIL_ALLOWLIST` Deployed and the provider is reachable — the milestone job's send attempts reached it and were rejected only because the fixture addresses were `@example.com`. **No successful delivery to a real address has been observed** |
| D6 | Object storage | 🟡 PARTIAL | All four `STORAGE_*` Deployed. No upload performed from here |
| D7 | **All four scheduled jobs** | 🟢 DONE | `cron-guarantee-sweep` (hourly), `cron-price-recalculation` (daily), `cron-group-buy-bank-payment-window` (hourly), `cron-group-buy-milestones` (hourly). Each invoked authenticated and verified by **its own returned evidence**, not by an exit code — see §6 |
| D8 | Production reference data exists | 🟢 DONE | A pricing profile, three labor sources, 15 cost components, three metal references and five stone-cost rows all exist. Nothing is missing. Their *values* are placeholder — that is P3, not this |

---

## 6. Pricing

| # | Item | Status | Evidence / note |
|---|---|---|---|
| P1 | Pricing engine and schema | 🟢 DONE | All models populated in production; 94 calculations recorded |
| P2 | Operating defaults — 40% markup, 20% min gross margin, $100 min profit | 🟢 DONE — **not an owner decision** | Owner-locked as *configurable operating inputs*. Active profile `buy_now` v5, `isPlaceholder: false`. **Do not ask the owner to reconfirm these** |
| P3 | **Production cost inputs** | 🟡 PARTIAL — **placeholder, see the warning below** | Every row resolves; all are seed fixtures dated `2026-01-01` **except** `payment_processing` (percentage), now a real value: **0.027**, effective `2026-10-24T22:39:18.542Z`, written through Pricing Settings with its source noted (Shopify Payments, Grow, online). The fixed `payment_processing` $0.30 already matched reality and was left as is. Note: Shopify may add a surcharge for international/currency-converted cards, not modelled |
| P4 | Card-price derivation | 🟢 DONE | Active profile carries `BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1` — approved tiered uplift, upward-to-$5 rounding on the Card price only |
| P5 | Fixture catalogue cleanup | 🟡 PARTIAL | The email-generating defect is **fixed and verified** (§9). What remains is tidiness: four active seed-fixture variants still enter daily recalculation. Proposal in §7, not executed |
| P6 | **Operator tooling — profile, metal, labor, stone** | 🟢 **DONE — implemented, deployed, live smoke-tested** | See below |
| P7 | **Operator tooling — cost components** | 🟢 **DONE — same** | See below |

### P6 / P7 — all three lifecycle stages complete

| Stage | Evidence |
|---|---|
| Implemented / tested | `app/routes/app.pricing-settings.tsx` + 75 tests |
| Deployed | `c14c94c`, live in production |
| **Live operator smoke test** | **2026-10-15, in Shopify Admin** |

Smoke test observed, with **no configuration written** — deliberately, so
the first real write can be an actual Product #1 cost update rather than a
throwaway version:

- **Target markup 40, minimum gross margin 20, minimum profit 100.00**,
  pre-filled, under "Currently version 5, effective 2026-09-18… margin
  model MARKUP_ON_COST_V1; card rule BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1".
- Metals: sterling_silver 0.9189, gold 82.7, platinum 36.58 USD/g.
- Labor: india 4.5, china 5.25, usa 12 USD/g.
- Stones: five rows, **each appearing once** — the per-key collapse working
  against real data.
- Components: fourteen rows including `payment_processing` **twice**
  (percentage 0.029 and fixed 0.30 — the `(type, valueKind)` key behaving
  as designed) and **`payment_adjustment` correctly absent**.
- Both scope notices rendered.
- No application console errors; no failed requests.

An authenticated operator can now change target markup, minimum gross
margin, minimum profit, metal reference prices, labor rates, stone costs
and cost components with **no code change, no seed, no SQL and no SSH**.
Each save inserts a new effective-dated row attributed to the signed-in
Shopify staff user.

**Known limitation, reported rather than worked around:** there is no
"recalculate now" button. `runPriceRecalculation` with no `variantIds`
sweeps every active variant and is measured in tens of seconds; running it
inside an embedded admin request would block past any sane timeout, and
doing it properly needs a job-status surface with polling. The daily cron
already picks up configuration changes, and every save message says so.

### ⚠️ Placeholder cost data — the trap for Product #1

**Every cost input in production is placeholder data, and it does not look
like placeholder data.** Gold at 82.70/g implies roughly $2,572/oz; silver
and platinum are similarly plausible. A price computed from them will be a
sensible-looking number that is not a real price.

Three properties make this dangerous rather than untidy:

1. **It resolves.** Nothing fails. Product #1 priced today would move
   cleanly through calculate → approve → sync with no error anywhere.
2. **`isPlaceholder` does not cover it.** That flag exists only on
   `pricing_profile`, and the active profile is legitimately
   `isPlaceholder: false` — its *rules* are owner-approved. There is no
   equivalent flag on `metal_reference_price`, `labor_rate`, `stone_cost`
   or `cost_component`.
3. **Every row is dated `2026-01-01`** — the one reliable tell, and the
   Pricing Settings screen shows it for every value.

**Operating rule:** a variant may be mapped and calculated to prove the
pipeline, but **nothing may be published to a storefront while any cost
input it depends on still carries the `2026-01-01` fixture date.**

### Auditability — enforced by the database, not by convention

- `metal_reference_price`, `stone_cost`, `cost_component`,
  `pricing_profile` and `labor_rate` each carry `no_update` / `no_delete`
  triggers. **A historical row cannot be rewritten in place.** A change is
  always a new effective-dated row.
- `PriceCalculation` pins `pricingProfileId`, `profileVersion`,
  `engineVersion`, both rule ids and a frozen `snapshotId`.

New calculations resolve current values; old ones stay reproducible; no
future change can retroactively alter recorded evidence.

### Profile scope — one profile serves more than Buy Now

`PricingProfileCode` defines six codes; **only `buy_now` is ever
resolved**. It is read by floating Buy Now calculations, by Custom Jewelry
card-price derivation, and by Group Buy campaigns at the moment they open
and freeze. The per-channel capability the schema allows is **not
implemented**, and the Pricing Settings screen says so rather than
labelling itself "Buy Now settings".

Already-open Group Buy campaigns are insulated by their frozen
profile/version — proven by `frozenRuleVersioning.test.ts`, and the
operator surface creates no path around it.

### Payment processing is a cost input, not a price rule

`payment_processing` (2.9% + $0.30, `revenue_side`) is a configurable
cost/audit input only. It does not participate in deriving the
customer-facing Regular/Card Price, which is governed solely by the
approved Bank-vs-Card rule. Updating it when a real gateway is chosen
changes cost and margin maths and leaves that model untouched.

### The resolver query — accurate characterisation

`resolveActivePricingProfile` uses `findFirst` with the same `where`
(`code` + `effective_from <= asOf`) and the same deterministic ordering
(`effective_from DESC, version DESC`), so it selects exactly the same row
and the documented same-date version tie-break still holds.

It is **not constant time.** `EXPLAIN (ANALYZE, BUFFERS)` against
production shows an index scan on the `(code, version)` unique index
reading **all** rows for the code, then a top-N heapsort — nothing indexes
`effective_from`. The genuine improvement is that one row is materialised
and returned instead of k. At today's k=4 the LIMIT form measured
marginally *slower* (0.084 ms vs 0.041 ms); the benefit appears as versions
accumulate. If they ever do, the real fix is an index on
`(code, effective_from DESC, version DESC)` — not built, because at k=4 it
would be speculative.

---

## 7. Engineering

| # | Item | Status | Evidence / note |
|---|---|---|---|
| E1 | Slices 0–13 implemented and merged | 🟢 DONE | Tagged `mvp1-engineering-complete` at `c4420a1` |
| E2 | **Group Buy milestone emails** | 🟢 DONE — **in production** | `157a216`, deployed. Route authenticates; the job has run against production and reported its own evidence |
| E3 | Slice 13 theme surfaces | 🟢 DONE (in `main`) | `5f33f0e`. Not yet pushed to Shopify — see S3 |
| E4 | CI green on `main` | 🟢 DONE | Green on `29de5b1`. 180 unit files / 3195 tests and 101 integration files / 1622 tests also pass locally |
| E5 | Live Shopify proof for Group Buy refund execution | 🟢 DONE | 15/15 assertions against the real store |

**Feature development is frozen.** No further engineering until the
production-store migration or launch testing exposes an actual defect.

### Fixture catalogue cleanup — proposed, NOT executed

The email-generating problem is **resolved** (§9). What remains is
tidiness: four active seed-fixture variants still enter the daily
recalculation. Nothing is customer-visible — none is synced to Shopify.

The lever is `status`, verified safe and reversible: `runRecalculation`
selects only `{ status: "active" }`, nothing else consumes active master
variants, and the catalogue tables carry no append-only triggers.

| Row | Current | Proposed |
|---|---|---|
| `Seed Fixture Solitaire Ring` (product) | `active` | **archive** |
| Its 3 active 14k gold variants | `active` | **archive** |
| Its 1 active pt950 variant | `active` | **archive** |
| `ZZ livegate storefront …` / `ZZ LIVE GATE TEST — DO NOT SELL …` | archived / draft | **leave** — already excluded |
| All six ZZ Group Buy campaigns | archived | **leave** — already archived, and the sweep now honours it |
| 94 price calculations, 93 sync intents, all snapshots | — | **UNTOUCHED** — evidence |
| Policy versions, acknowledgments, audit records | — | **UNTOUCHED** — never in scope |

**No hard deletion is proposed for anything.** On the Shopify side, one
leftover live-gate product (`gid://shopify/Product/10357871313197`) exists
in the dev store only; it never reaches the production store — but **the
Postgres fixtures still need archiving either way.** The production store's
only product is the archived "ZZ webhook test — DO NOT SELL" (draft, never
on a channel, never mapped in Postgres).

---

## 8. The two parallel tracks

### Track A — production store (owner)

Done 2026-10-22: production store created (Grow); app installed and
verified; `SHOPIFY_SHOP_DOMAIN` repointed; App Proxy verified through the
storefront; webhooks verified (`products/update`); theme pushed and
published; six policy pages, FAQ page + definition, Past Group Buys and the
Contact wording in place; Zelle recipient confirmed (C3). See §2.

Remaining, in order:

1. ~~Payment gateway~~ — done 2026-10-24 (C7); real rate written to P3.
2. **Manual / Bank Payment method** in Shopify, consistent with the app.
3. **Tax** — nexus, registrations, Shopify configuration (owner facts).
4. **Shipping** (C6) — rates, zones, packages, full-value insurance and an
   operational mechanism for the $100 signature rule.
5. **Approved copy** — N2–N5, then C4/C5.

### Track B — the first real product

**Locked archetype: a 14K gold solitaire pendant with one lab-grown
diamond.** Fixed configuration, single Shopify variant, `sizeAxis: none`,
no ring-sizing model, one centre stone. It proves the real CaratForUs path
— metal + purity + weight + labor + stone + components + profile +
Bank/Card derivation + Shopify sync — while `sizeAxis: none` excludes the
ring-size band model, `weightPerFullSizeGrams`, weight overrides and the
per-size price surface.

14K costs nothing extra on the metal side: `purity.ts` computes
`pure_price_per_gram × fineness × grams`, so one gold reference row serves
10k/14k/18k.

**No longer blocked by the store** — it can now be created in the production
store. Blocked only on the owner inputs below and on P3: nothing may be
published while a dependent cost input still carries the `2026-01-01`
fixture date.

**Owner inputs needed:** product name; finished 14K weight in grams;
whether a chain is included and if so its length and weight; stone shape;
carat; intended colour/clarity/cut; actual supplier cost for the stone;
labor source and real rate; current pure-gold price with as-of date;
realistic metal-loss percentage; and the applicable component costs. CAD
may legitimately be zero for a stock pendant.

**Stone coverage:** the library covers lab round and lab princess over
**[0.90, 1.10)** ct only — half-open, so 1.10 is not covered. A commoner
pendant size (0.25–0.75 ct) needs a new effective-dated band created from
the owner's real supplier cost, never invented to make the engine resolve.
A missing band raises `MissingCostInputError`, so the engine fails closed
rather than pricing a stone at zero.

**MVP1 stone-costing policy:** the *resolver* supports quality tiers, but
every current row leaves colour, clarity, cut and lab status NULL, so they
are wildcards and cost varies only by type, shape and carat band. **The
database does not differentiate quality today.** A more specific row added
later takes precedence automatically, with no code change.

---

## 9. Resolved findings — history, not open items

Recorded because the reasoning is worth keeping. **None of these is an
active blocker.**

**The production-store migration needed no new app (2026-10-22).** The
working assumption that a store change might force a new app/client did
not hold: the app lives in the store's own organization, so the Dev
Dashboard installs it on any store there. Two traps were avoided and are
worth knowing for any future store change. First, `SHOPIFY_SHOP_DOMAIN`
must be the **permanent** myshopify domain (`nnb1th-cm…`), not the renamed
friendly one (`caratforus…`) — Shopify keys sessions, proxy signatures and
webhooks by the permanent domain, and the wrong value would have broken
bank checkout, warranty lookup, price sync and milestone emails silently.
Second, a **Hidden** Shopify page returns 404 even through the admin
preview, and page templates can only be assigned from the **published**
theme — so verifying pages before launch requires a published theme and
Visible pages behind the storefront password.

**The milestone sweep emailed participants of archived campaigns.**
Found within minutes of the job first running in production: it emailed
three participants of a campaign staff had archived ten days earlier. The
sweep filtered on `status in (open, closed)` and ignored `archivedAt`. This
was never fixture hygiene — all six ZZ campaigns were *already* archived on
2026-10-05 — it was a general defect that would have kept notifying
participants of **any** archived campaign indefinitely, because failed
milestones deliberately retry. Fixed in `c14c94c` with three regression
tests; production now reports `campaignsExamined: 0, emailsFailed: 0`.
Rejected non-fixes: writing completion markers (would record sends that
never happened) and closing the campaign (would convert the pending
milestone into a `campaign_closed` milestone, producing *more* failed
sends, and move a fixture campaign toward settlement).

**Five overdue bank-payment orders were inactivated correctly.** The
window job's first run inactivated five orders — `16a161d3…`, `4b53f8ca…`,
`d89dc767…`, `d7f0fc4b…`, `60f80d34…` — all `active` → `inactive`, all on
`@example.com`, all on ZZ live-gate campaigns, quoted 2026-09-29/10-05 and
therefore 10–16 days past their 96-hour window. They were overdue precisely
because the job had never been scheduled. Inactivation is internal
bookkeeping only; the Shopify orders and counted units are untouched and
staff reactivation reverses it.

**Verifying job evidence rather than exit codes was load-bearing.** The
milestone job returned HTTP 200 and `curl -fsS` exited 0 while reporting
`emailsFailed: 3`. An exit-code check would have called that success.

**Pricing values were data-driven but not operationally configurable.** An
architecture audit found the only writer to any pricing-configuration table
was `prisma/seed.ts`. Closed by P6/P7.

**Custom Jewelry resolved the pricing profile by a different rule.** It
carried its own query with no `effectiveFrom` filter, so a future-dated
profile would have taken effect there before Buy Now. Now uses the shared
resolver; pinned behaviourally and structurally.

**The input boundary used casts, not checks.** Every enum crossed through
`as never`, and `currency` was unvalidated against a `char(3)` column that
**blank-pads** — `US` would have been stored as `"US "` silently. Closed in
`domain/pricing/configurationInput.ts`, validating against Prisma's
generated runtime enums.

**Production reference data was unknown and turned out to exist.** The
seed had run; a pricing profile and all cost libraries were present.

**Earlier register revisions were wrong about production.** A
reconstruction-based revision marked the Fly deployment unconfirmed,
secrets missing, email missing and no jobs scheduled. All were already
configured. Every status in this register now names its evidence.

---

## 10. Not in this register

- Post-MVP functionality of any kind.
- `product-faq.liquid`'s PDP placement — implemented, unwired, awaiting an
  owner decision. Not a blocker; the FAQ page works without it.
- The optional "close to the next tier" Group Buy email. README permits it;
  the scope freeze excludes it.
- A "recalculate now" action — see the limitation under P6/P7.
- An index on `(code, effective_from, version)` — speculative at k=4.
- Channel-specific pricing profiles — schema-capable, not required for MVP1.
- **Anything already configured.** Core secrets, Shopify secrets, email,
  storage, bank coordinates and all four cron jobs are done, and nothing
  here asks for them again.
