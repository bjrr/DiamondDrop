# MVP1 Launch Blocker Register

**Current as of 2026-10-25. `main` = `0638578`, deployed and smoke-tested.**

The single authoritative list of what stands between CaratForUs and taking
a real customer's money.

This is a *launch* register, not a backlog. An item appears only if MVP1
cannot open without it. It states current truth once; superseded findings
live in §9 as history, never as open items.

---

## The one-paragraph answer

**The platform is ready; the business is not.** The app is deployed and
healthy, fully migrated, operator-configurable, and all four scheduled jobs
run and have been individually proven. The last two engineering gaps —
D15's unsafe Shopify invoice and D12's email-only payment instructions —
are fixed, deployed and live-proven (§7). What is missing is commercial:
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
| S9 | **A `bank-payment-orders` page using the new template** | 🔴 BLOCKER | The durable Bank Payment instructions page (D12). Template `page.bank-payment-orders.json` ships in `main`; the Admin page must be created with the handle **exactly** `bank-payment-orders` and that template assigned. Both checkout confirmations link to `/pages/bank-payment-orders`, so a wrong handle produces a 404 at the one moment a customer is looking for payment details. Link it from the account page and the footer too |

---

## 5. Deployment and operations

| # | Item | Status | Evidence / note |
|---|---|---|---|
| D1 | App deployed to Fly and healthy | 🟢 DONE | **Production runs `main` (`0638578`)**, deployed 2026-10-25 with the D12/D15 work. `/health` ok, database ok, **90 applied / 0 pending, matching the 90 in the repo exactly** |
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
finished clearing, so none was done.

**Owner decision 2026-10-24: prove it on the first real event.** No
test-send action will be built.

### What to watch, because this failure is silent to the customer

The earliest real send is the Group Buy bank-payment instructions email,
and its failure mode is deliberately quiet: the send is wrapped so that a
provider outage **cannot lose the order**. The order is created, the units
count, the price is locked — and the email failure is logged at error for
staff to handle by hand. That is the right trade, but it means a customer
can end up with an open order and no idea where to send money, with
nothing on screen indicating anything went wrong.

So on the first real bank-payment order, check the log for exactly one of:

```
group_buy_bank_checkout.instructions_email_sent     ← delivered
group_buy_bank_checkout.instructions_email_failed   ← send by hand, now
```

Neither line appearing at all means the email was never attempted —
`instructions_email_unconfigured`, a configuration fault rather than a
provider one.

The same applies to the other senders, which log
`group_buy_milestone.email_failed` and the admin-alert equivalents. The
milestone sweep additionally reports `emailsFailed` in its returned
summary, so a scheduled run's failures are visible without reading logs.

**This is no longer the only channel.** As of D12 the customer sees the full
instructions on screen at checkout and can return to them at any time on the
authenticated `/pages/bank-payment-orders` page. The log lines above still
matter — a failed email is still worth sending by hand — but an email outage
no longer strands a customer.

---

### ⚠️ Operations constraint — do not rotate bank coordinates while unpaid orders are open

The Zelle recipient and wire details live **only** in Fly secrets
(`PAYMENT_ZELLE_RECIPIENT`, `PAYMENT_WIRE_*`). They are resolved per request
and deliberately never persisted — not in `BankPaymentOrder`, not in
`GroupBuyBankPaymentOrder`, not in a snapshot, an audit event, an
idempotency payload, a Shopify note, or a log line. That boundary is
enforced by tests on both checkout routes and by
`bankPaymentCoordinates.server.ts`'s own header.

The consequence is a real operational rule:

> **Bank Payment coordinates must not be changed while unpaid Bank Payment
> orders are outstanding, unless staff deliberately reconcile those open
> orders.**

Because nothing is stored, every surface shows the CURRENT coordinates.
Rotate them and a customer who placed an order yesterday — and who returns
to the orders page, or who was emailed the old ones — now has two different
destinations, and staff have no record of which one any given order was
shown.

**Do not "fix" this by persisting the coordinates.** A copy in Postgres is a
second place to secure, retain and eventually redact, and the whole point of
the boundary is that it does not exist. The fix is procedural:

1. Before rotating, list open orders:
   `BankPaymentOrder` where `status = 'open'`, and
   `GroupBuyBankPaymentOrder` where `status IN ('active','inactive')`.
2. If any exist, either wait for them to settle, or contact those customers
   directly with the new destination and record that you did.
3. Then rotate. Payments to the old destination after that point are
   reconciled by hand against the order reference, which is the one thing
   every payment carries.

If the coordinates are unset or partially set, both checkout routes refuse
with `503 checkout_unavailable` **before** any Shopify call — no order is
created that cannot be paid. The orders page degrades differently and
deliberately: it still lists the orders, their references, amounts and
deadlines, and tells the customer to email `orders@caratforus.com` for the
destination. Hiding their orders because a secret is unset would turn a
configuration problem into a lost customer.

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
| E6 | **D15 — the Buy Now Bank Payment invoice** | 🟢 FIXED in `main` | Buy Now sent Shopify's draft-order invoice, whose **Confirm order** action let the customer advance a draft that must stay staff-held until funds are verified. `sendInvoice` is gone, the invoice URL is out of the contract, and `bankCheckoutInvoiceFence.test.ts` fails if a usable one returns. `sendInvoice` now has **zero callers** anywhere |
| E7 | **D12 — bank instructions depended solely on email** | 🟢 FIXED, **deployed and live-proven** | Three surfaces now state the same server-composed instructions: the checkout confirmation panel, the authenticated `/pages/bank-payment-orders` page, and the email (now secondary). Group Buy Bank Payment ordering is wired to its real endpoint for the first time — the storefront previously offered a "Contact us" link. Coordinates still never persist; see §5. **Live gate 10/10 against production 2026-10-25** — see below |

**Feature development is frozen again** as of the D12/D15 work. No further
engineering until the production-store migration or launch testing exposes
an actual defect.

### What was actually proven in production, and what was not

Run `npx tsx tests/live/bankPaymentOrdersRoute.ts` after any deploy.

**Proven against `https://caratforus.fly.dev`, 2026-10-25, 10/10:**

- the route is deployed and routable — it is not shadowed by a redirect,
  a CSRF guard or an error page, which is exactly the class of fault D11
  was (every `/app` action 400'd in production for nine days while every
  local test passed);
- it fails closed on an unsigned request, a wrong signature, a validly
  signed **anonymous** request, and a signed request with an **empty**
  `logged_in_customer_id` — the last being what Shopify actually sends for
  a signed-out visitor, and it is part of the signed message, so that
  request is genuinely well-formed;
- a signed, authenticated request returns 200 with both lifecycles reported
  separately and `Cache-Control: no-store`;
- the deployed `SHOPIFY_API_SECRET` is the one the storefront signs with —
  implied by that 200;
- **payment coordinates are configured in production** (`coordinatesAvailable:
  true`), which is what makes instructions statable without an email at all.

**NOT proven, and deliberately so.** The gate is read-only and uses a
customer id that owns nothing, so its success case is 200 with two empty
lists. It therefore does not prove the rendering of a real payable order,
the confirmation panel, or the Group Buy storefront form — those need a
real order placed by a real signed-in customer in a store that can take
payment, which does not exist yet (C2). They are covered by the integration
suite against real Postgres and by the theme unit tests; the first
end-to-end proof belongs to launch testing in the production store, and
S9's page must exist before that test is meaningful.

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
