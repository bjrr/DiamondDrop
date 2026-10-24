# MVP1 Launch Blocker Register

**Current as of 2026-10-24. `main` = `c01b944`, deployed.**

The single authoritative list of what stands between CaratForUs and taking
a real customer's money.

This is a *launch* register, not a backlog. An item appears only if MVP1
cannot open without it. It states current truth once; superseded findings
live in §9 as history, never as open items.

---

## The one-paragraph answer

**The platform is ready; the business is not.** The app is deployed and
healthy, fully migrated, operator-configurable, and all four scheduled jobs
run and have been individually proven. What is missing is commercial:
`caratforus-dev` is a development store that **cannot be converted** to a
paid storefront, so a new production store must be created; there is no
real catalogue; and every cost input in the database is still placeholder
data. No amount of further engineering changes any of that.

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
| C1 | **A real catalogue** — no sellable product exists | 🔴 BLOCKER | Blocked behind C2 by choice: no Shopify product, mapping, metaobject or collection is created in a store we are about to abandon. See §8 Track B |
| C2 | **A payment-capable store** | 🔴 BLOCKER | **Determined 2026-10-15: `caratforus-dev` cannot be transferred or upgraded. A new production store is required.** See §2 |
| C3 | **Bank payment coordinates** | 🟢 DONE | All five `PAYMENT_*` secrets set and Deployed. **Resolved 2026-10-24:** the digest `PAYMENT_ZELLE_RECIPIENT` shares with `STAFF_EMAIL_ALLOWLIST` is because both are `orders@caratforus.com`. The allowlist holds a **single address with no commas**, so the Zelle recipient is a valid one — the failure mode I flagged does not apply |
| C4 | **Terms of Service** | 🔴 BLOCKER | Does not exist. Four business decisions needed first — `docs/content/MVP1-STOREFRONT-COPY.md` Part 4 |
| C5 | **Privacy Policy** | 🔴 BLOCKER | Does not exist. Append-only evidence tables interact with deletion requests and need a lawful stated answer — Part 5 |
| C6 | **Shipping configuration in Shopify** | ❓ UNKNOWN | Policy locked in README; Shopify-side configuration not visible from here. Moot until C2 |
| C7 | **Payment gateway and tax** | ❓ UNKNOWN | Not visible from here. Moot until C2 |

---

## 2. The store determination (C2)

Checked in the authenticated Shopify session, three independent places:

| Source | Result |
|---|---|
| `shopify store info` (CLI) | `Type: Dev`, Plan Basic, created 2026-09-17, org "My Store" (236195662) |
| Admin → Settings → **Plan** | "Basic" with a **Development store** badge. Only action on the page: **Delete store**. No plan selection, no upgrade |
| Dev Dashboard → Stores → ⋮ | Exactly two actions: **Log in**, **Delete store**. **No "Transfer ownership"** |

**`caratforus-dev` is a development store created for app/theme testing,
with no self-serve route to a paid public storefront.** A transferable
store exposes a transfer action; this one exposes deletion. It must be
replaced, not upgraded. Creating a store requires a plan purchase and is an
owner action — nothing further can be prepared from here.

### What survives the move, and what does not

| Survives untouched | Must be redone |
|---|---|
| All 15 policy terms (they live in Postgres, not Shopify) | App install + OAuth grant |
| The entire database and all 90 migrations | App Proxy subpath + storefront routing |
| 24 of 25 Fly secrets (only `SHOPIFY_SHOP_DOMAIN` changes) | Webhook registration |
| The Fly app, Postgres, all four cron machines | Theme push |
| Pricing settings and every pricing value | Six policy page shells |

**Now is the cheapest possible moment to move** — there is still no
catalogue, no FAQ metaobject and no collection to lose. That stops being
true the moment Product #1 is created.

---

## 3. Content

| # | Item | Status | Evidence / note |
|---|---|---|---|
| N1 | Six policy pages, correct templates, terms served live | 🟢 DONE | 6/6 groups over signed App Proxy, 15 terms, `incomplete: false`, re-verified after every deploy |
| N2 | Policy page bodies are empty | 🔴 BLOCKER | Drafts written — `MVP1-STOREFRONT-COPY.md` Part 1 |
| N3 | About page copy | 🔴 BLOCKER | Draft written; needs 2–3 sentences only the owner has |
| N4 | Why Buy From Us copy | 🔴 BLOCKER | Draft written and grounded in README + locked pricing policy |
| N5 | FAQ entries | 🔴 BLOCKER | No `faq_entry` metaobject definition or entries exist, so the FAQ page renders nothing |
| N6 | Contact mailbox | 🟢 DONE | `orders@caratforus.com`, owner-confirmed, fenced repo-wide. `CUSTOMER_SERVICE_EMAIL` is deliberately *not* a Fly secret — nothing reads it at runtime. Do not set it |

---

## 4. Shopify Admin setup

Everything here is **blocked behind C2** and should be done once, in the
production store.

| # | Item | Status | Evidence / note |
|---|---|---|---|
| S1 | Slice 12 policy theme files pushed | 🟢 DONE (dev store) | Theme `182948626733`. Must be re-pushed to the production store |
| S2 | FAQ theme files pushed | 🔴 BLOCKER | Committed `a764887`, never pushed to Shopify |
| S3 | Slice 13 theme files pushed | 🔴 BLOCKER | Committed `5f33f0e`, never pushed |
| S4 | `faq_entry` metaobject definition | 🔴 BLOCKER | Exact handles in `docs/specs/SLICE-12-CONTENT.md` §4.2. A wrong field key renders blank entries with no error anywhere |
| S5 | `carat.faq_entries` product metafield | 🟡 PARTIAL (optional for launch) | `product-faq.liquid` is implemented but deliberately unwired pending an owner decision on PDP placement |
| S6 | A `past-group-buys` page using the new template | 🔴 BLOCKER | Template ships in `5f33f0e`; the page must be created in Admin |
| S7 | Policy pages published | 🔴 BLOCKER | Deliberately hidden until N2 |
| S8 | App installed, OAuth valid, App Proxy routing | 🟢 DONE (dev store) | Working today — the embedded admin and signed App Proxy both verified. **All of it must be redone in the production store** |

---

## 5. Deployment and operations

| # | Item | Status | Evidence / note |
|---|---|---|---|
| D1 | App deployed to Fly and healthy | 🟢 DONE | **Production runs `main` (`c01b944`)**, deployed 2026-10-24 with the D11 and D9 fixes. `/health` ok, database ok, 90 migrations applied / 0 pending |
| D2 | Postgres attached and migrated | 🟢 DONE | **90 migrations applied, 0 pending** — identical to the 90 in the repo |
| D3 | Core secrets | 🟢 DONE | `DATABASE_URL`, `DIRECT_URL`, `SESSION_SECRET`, `CRON_SECRET`, `APP_ENV` all Deployed. **Do not recreate these** — regenerating `CRON_SECRET` would silently break all four cron jobs |
| D4 | Shopify secrets | 🟢 DONE (store-dependent) | All seven `SHOPIFY_*` set and working. `SHOPIFY_SHOP_DOMAIN` must change when the production store exists; API key/secret change too if a new app is created |
| D5 | Email provider | 🟡 PARTIAL | Addresses verified 2026-10-24: `EMAIL_FROM` is `CaratForUs <orders@caratforus.com>` (display-name format, correct address) and `STAFF_EMAIL_ALLOWLIST` is `orders@caratforus.com`. The provider is reachable — the milestone job's attempts got to it and were rejected only because the fixture recipients were `@example.com`. **Still unproven: no successful delivery to a real address has been observed.** See below |
| D6 | Object storage | 🟡 PARTIAL | All four `STORAGE_*` Deployed. No upload performed from here |
| D7 | **All four scheduled jobs** | 🟢 DONE | `cron-guarantee-sweep` (hourly), `cron-price-recalculation` (daily), `cron-group-buy-bank-payment-window` (hourly), `cron-group-buy-milestones` (hourly). Each invoked authenticated and verified by **its own returned evidence**, not by an exit code — see §6 |
| D8 | Production reference data exists | 🟢 DONE | A pricing profile, three labor sources, 15 cost components, three metal references and five stone-cost rows all exist. Nothing is missing. Their *values* are placeholder — that is P3, not this |

---

### Email delivery is configured but unproven, and there is no safe test path

Every outbound address is `orders@caratforus.com`, a monitored mailbox, so
nothing is misdirected. What has never happened is a **successful delivery
to a real address** — every recipient so far was an `@example.com` fixture.

There is deliberately **no "send a test email" action** in the app, and
the three real senders cannot be triggered without inventing data:

- admin alerts fire only when the guarantee sweep finds a genuine fault;
- payment instructions fire only on a real Group Buy bank checkout;
- milestone emails fire only for a real campaign at a real milestone.

Fabricating any of those would recreate exactly the fixture rows we just
finished clearing, so none was done. Three honest options, for the owner
to choose:

1. **Let the first real event prove it** — the earliest is a bank-payment
   order's instructions email, which is also the one whose failure would
   hurt most.
2. **Accept the risk** on the grounds that the provider is reachable and
   the From address is verified.
3. **Add a small authenticated test-send action.** New engineering, and
   the scope freeze excludes it unless the owner lifts it for this.

---

## 6. Pricing

| # | Item | Status | Evidence / note |
|---|---|---|---|
| P1 | Pricing engine and schema | 🟢 DONE | All models populated in production; 94 calculations recorded |
| P2 | Operating defaults — 40% markup, 20% min gross margin, $100 min profit | 🟢 DONE — **not an owner decision** | Owner-locked as *configurable operating inputs*. Active profile `buy_now` v5, `isPlaceholder: false`. **Do not ask the owner to reconfirm these** |
| P3 | **Production cost inputs** | 🟡 PARTIAL — **placeholder, see the warning below** | Every row resolves; all are seed fixtures dated `2026-01-01` |
| P4 | Card-price derivation | 🟢 DONE | Active profile carries `BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1` — approved tiered uplift, upward-to-$5 rounding on the Card price only |
| P5 | Fixture catalogue cleanup | 🟡 PARTIAL | The email-generating defect is **fixed and verified** (§9). What remains is tidiness: four active seed-fixture variants still enter daily recalculation. Proposal in §7, not executed |
| P6 | **Operator tooling — profile, metal, labor, stone** | 🟢 **DONE — implemented, deployed, live smoke-tested** | See below |
| P7 | **Operator tooling — cost components** | 🟢 **DONE — same** | See below |

### P6 / P7 — all three lifecycle stages complete

| Stage | Evidence |
|---|---|
| Implemented / tested | `app/routes/app.pricing-settings.tsx` + 75 tests |
| Deployed | live in production (`c01b944`) |
| Live **read** verification | 2026-10-15, in Shopify Admin |
| Live **write** verification | 2026-10-24, after the D11 fix |

> **The 2026-10-15 smoke test covered rendering only, and that was not
> enough.** It exercised the loader and deliberately avoided a save, to
> avoid creating a throwaway profile version. The write path was therefore
> never tested — and it was broken: **D11** rejected every embedded-admin
> form action with 400 before authentication or the action ran. "P6/P7
> GREEN — operationally configurable" was, for nine days, only half true:
> an operator could read every value and save none. Both halves are now
> verified separately, and the table above records them separately.

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

**Write path verified 2026-10-24**, without creating a throwaway version:
an intentionally invalid markup (`-5`) was submitted from Shopify Admin.
The action ran and rejected it, and the database confirms the request left
nothing behind — `buy_now` versions still `[1, 2, 3, 5]`, active still
version 5 at 0.4 / 0.2 / 10000, and **0 audit events** for
`pricing_profile`. A rejected save writes neither a row nor a misleading
audit entry. The server log shows `POST /app/pricing-settings.data 200`
for the page's own data request, which is what proves the CSRF origin
guard now admits the embedded admin at all.

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
| E4 | CI green on `main` | 🟢 DONE | Green on `c01b944`. 180 unit files / 3195 tests and 101 integration files / 1622 tests also pass locally |
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
in the dev store and disappears when the production store replaces it —
but **the Postgres fixtures still need archiving either way.**

---

## 8. The two parallel tracks

### Track A — production store (owner)

1. **Create the production Shopify store.** `caratforus-dev` cannot be
   converted (§2). Requires a plan purchase — owner only.
2. **Payment gateway** — activated and able to take a live card.
3. **Tax** — registration and Shopify configuration.
4. **Shipping** (C6) — rates, full-value insurance, the $100 signature rule.
5. **Confirm the Zelle recipient** (C3).
6. **Re-establish the app in the new store**: update `SHOPIFY_SHOP_DOMAIN`
   (and API key/secret if a new app), reinstall and re-grant scopes,
   reconfigure the App Proxy and verify routing **through the storefront**,
   re-register webhooks, re-push the theme, recreate the six policy pages.

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

**Blocked on Track A step 1**, deliberately — so Shopify IDs are not minted
in a store we are about to abandon.

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

**D11 — every embedded-admin form save failed in production with 400.**
Fly terminates TLS at its proxy and forwards plain HTTP;
`react-router-serve` never enables Express's `trust proxy`, so
`request.url` was rebuilt as `http://caratforus.fly.dev/…` while the
browser sent `Origin: https://caratforus.fly.dev`. React Router's
`throwIfPotentialCSRFAttack` compares full origins including scheme, saw a
mismatch, found the host absent from an allowlist that is `[]` in
production by design — and rejected every `/app` action before
authentication or the action ran. Fixed by allowing the app's own host
(`PRODUCTION_APP_HOST`), with a test tying it to the Shopify TOML's
`application_url`. Deployed and verified 2026-10-24.

**It was found by a real write, which is the lesson.** My 2026-10-15
smoke test verified rendering and skipped the save, so a surface reported
as "operationally configurable" could not actually be operated. A
read-only verification of a write surface is not a verification of that
surface.

**D9 — the request log printed Shopify session tokens.**
`react-router-serve` always installs `morgan("tiny")`, whose `:url` token
is the full original URL, so every embedded-admin page load logged
Shopify's `id_token` (a signed session JWT), `hmac` and `session`, and
every App Proxy request logged its `signature` and
`logged_in_customer_id`. Fixed by preloading a module that redefines
morgan's `url` token to the path only. Verified in production: the log
line is now `GET /app/pricing-settings 200` with no query string.

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
