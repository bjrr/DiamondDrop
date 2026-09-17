# Feature Spec — Slice 1: Cost Libraries, Buy Now Pricing Engine, Price Review & Sync Job

## Status

**ARCHITECT-APPROVED. CLEARED FOR IMPLEMENTATION.**
Author: Principal Architect / Tech Lead. Date: 2026-09-15.
**Amended 2026-09-16** against owner constraints issued the same day: added **§4.0** (the six-layer separation), **§4.7** (extension seams for automated metal-price feeds and supplier-specific overrides), **§5.0** (function-level decomposition, anti-monolith rule) and acceptance criteria **34–37**. The amendment makes explicit what the spec already required in substance; it changes no business rule, no existing criterion 1–33, and not the approval below. Implementation branch: `slice-1-pricing` (owner directive — slice 1 is not developed on `main`).
Controlling architecture: `docs/ARCHITECTURE-MVP1.md` (owner-approved 2026-09-13; D13 amendment 2026-09-15).
Depends on: Slice 0 (`docs/specs/SLICE-0-FOUNDATION.md`), merged to `main` at `50ff90d`.
Owner (implementation): **Backend & Pricing Engineer (`sonnet`)** with **Test Engineer (`haiku`)**.
Review: **architect review required** on the engine, the rounding/versioning design and the money-safety guard; **QA & Security review** required before acceptance.

Two owner decisions are requested in §13. **Neither blocks writing code** — both are configuration values, and the slice is specified so that the engine is complete and correct without them. They block *synchronising a real price to a real Shopify store*, which is slice 2 work in any case.

---

## 1. Outcome

CaratForUs stops carrying hard-coded Buy Now prices and starts deriving them from a structured, effective-dated cost library. Staff maintain metal prices per gram, stone costs by specification and shape, labour, packaging, shipping, insurance, warranty reserve and payment-cost assumptions. A deterministic pricing engine turns those inputs plus a versioned pricing profile into a per-variant Buy Now price, in integer minor units, under a named and versioned rounding rule. Every computed price is written to an immutable, content-hashed row that records exactly which inputs, which profile version, which engine version and which rounding rule produced it — so any price can be reproduced and defended months later without the database's current state. A scheduled job recalculates all Buy Now variants, decides per variant whether the change is small enough to apply automatically or must be approved by a person, and records that decision durably and idempotently.

This is the slice that makes the phrase "transparent pricing" in `README.md` mean something auditable rather than aspirational, and it is a prerequisite for Group Buy (slice 6), whose campaign freeze snapshots the output of this engine.

### What is NOT in this slice

- **No call to the Shopify Admin API and no price actually written to Shopify.** Slice 1 stops at a durable, approved *intent* to sync. Slice 2 installs `@shopify/shopify-app-react-router@2.1.0` and builds the Admin GraphQL client, and is the first slice that may execute `productVariantsBulkUpdate`. See §9.
- **No admin UI.** No Polaris, no App Bridge, no embedded admin route, no OAuth. Staff operate this slice through a thin CLI script (§9.5) and through seeded data. The review UI is slice 2+.
- **No installation of any `@shopify/*` package.** That is slice 2 (D13, `docs/ARCHITECTURE-MVP1.md` §2.1). Adding one here is out of scope even if it looks convenient.
- **No use of the library's `authenticate.webhook`, and no changes to `app/app/shopify/webhooks/`.** The custom webhook-processing boundary is unchanged and untouched by this slice.
- **No Group Buy anything**: no campaign table, no tier model, no freeze snapshot, no frozen pricing. Buy Now prices float with current costs (`CLAUDE.md` #8); Group Buy prices freeze at campaign open (`CLAUDE.md` #7). Slice 1 implements the floating case only, and exposes the engine in a shape slice 6 can freeze. Do not add a `campaign` table, a `frozen` flag, or a tier percentage anywhere.
- **No Luxury Steals pricing.** Luxury Steals prices are explicitly *assigned*, not computed (`docs/LUXURY-STEALS.md`, `README.md` §Luxury Steals: "assigned Luxury Steal pricing must be explicit/auditable"). Slice 3 owns them. The recalculation job must skip any variant flagged as Luxury Steals — see the exclusion port in §9.2.
- **No `compare_at_price`, no "was/now", no savings percentage of any kind.** `README.md` forbids fabricated comparison prices. Slice 1 computes one number per variant.
- **No refund, RMA, credit or restocking arithmetic.** See the standing contract in §12 (C-S4): refunds are computed from what the customer actually paid, never from a recalculated price.
- **No automated metal-price feed.** D2 is resolved as staff-entered, adapter-backed. Build the adapter interface; implement only the manual source.
- **No pricing for Custom Jewelry, Wholesale, Friends & Family or marketplace channels.** The `pricing_profile` table supports them by shape (`README.md` §Pricing Profiles); slice 1 seeds and exercises **Buy Now only**.
- **No theme, Liquid, metafield or storefront change.** Nothing computed here reaches a customer in slice 1.

---

## 2. Authoritative requirements

| # | Rule | Source (controlling) |
|---|---|---|
| R1 | Buy Now prices derive from current cost data, not permanent hard-coded prices | `README.md` §Buy Now Pricing |
| R2 | Inputs may include metal, stones, labor/manufacturing, packaging, shipping/insurance, payment processing, warranty reserve, other allocated costs, required margin/minimum profit | `README.md` §Buy Now Pricing |
| R3 | Independently configurable cost libraries for precious metals, lab/natural diamonds by specification **and shape**, moissanite, colored gemstones, accent stones, CAD, casting, setting, polishing, assembly, QC, packaging, shipping, insurance, warranty, supplier-specific costs | `README.md` §Cost Component Libraries |
| R4 | **Diamond/gemstone pricing must not assume all shapes cost the same** | `README.md` §Cost Component Libraries |
| R5 | Pricing profiles (Group Buy / Buy Now / Custom / Wholesale / F&F / marketplace) may have distinct margin, minimum-profit, fee and rounding rules | `README.md` §Pricing Profiles |
| R6 | All money calculations deterministic and auditable; **no binary floating point for money** | `README.md` §Pricing Profiles; `CLAUDE.md` #5, #6 |
| R7 | Recalculate at least daily, targeting twice-daily precious-metal updates where practical, then synchronise **approved** prices to Shopify | `README.md` §Buy Now Pricing |
| R8 | `Calculated Weight = Base Weight at Base Ring Size + ((Selected Size − Base Size) × Weight Added per Full Size)`; half sizes proportional; exact finished-weight overrides supported; model reused for chains/bracelets/necklaces/bands | `README.md` §Variant Weight / Ring-Size Model |
| R9 | Default customer-facing ring bands 2–6 / 6.5–8 / 8.5–11, configurable per product; **internal cost still evaluates expected weight by exact size**; bands use a safe cost basis so the highest-cost size in the band remains profitable | `README.md` §Variant Weight / Ring-Size Model |
| R10 | Metal library: Sterling Silver, 10K, 14K, 18K, Platinum; product creators explicitly choose offered metals; metal selection connects directly to pricing/variants | `README.md` §Ring Size / Metal UX |
| R11 | Validate against configured minimum gross-margin percentage, minimum dollar profit, and any variant-specific floor; unsafe prices blocked or explicitly overridden by an authorised actor | `README.md` §Tier Model (margin-floor rule; applied here to Buy Now) |
| R12 | Shipping/insurance costs must be represented in pricing so they do not silently erode margin | `README.md` §Shipping, Insurance & Signature |
| R13 | Buy Now pricing may update from current costs; Group Buy campaign prices/cost assumptions **freeze** at campaign open | `CLAUDE.md` #7, #8 |
| R14 | Never expose supplier-private cost data, admin-only margins or credentials to storefront clients | `CLAUDE.md` #10; `docs/ARCHITECTURE-MVP1.md` §8 |
| R15 | Preserve price/discount/tax/shipping and the immutable product/configuration snapshot as purchase evidence; later edits must not overwrite historical evidence | `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §11, §12; `README.md` §Customer Acknowledgment / Evidence Architecture |
| R16 | Staff-entered metal prices behind a `MetalPriceSource` adapter; automated feed is a post-launch fast-follow | `docs/ARCHITECTURE-MVP1.md` §6.4 (D2, resolved 2026-09-13) |
| R17 | Computed prices written to `price_calculation`; auto-applied only within a configured tolerance, otherwise queued for staff approval; variants in an open campaign excluded from Buy Now recalculation | `docs/ARCHITECTURE-MVP1.md` §6.4 |
| R18 | Variant = metal × ring-size band; exact US size captured as a line-item property and validated server-side; band price computed from the highest-cost size in the band | `docs/ARCHITECTURE-MVP1.md` §6.5 |
| R19 | Money columns are `BIGINT` minor units plus an explicit currency; `decimal.js` at fixed scale for intermediate cost math; rounding centralised and versioned | `docs/ARCHITECTURE-MVP1.md` §2, §4; `docs/specs/SLICE-0-FOUNDATION.md` §0.3, §0.4 |
| R20 | Preserve the React Router 7 + `@shopify/shopify-app-react-router` architecture and the custom webhook boundary; the Shopify library is installed in slice 2, not here | `docs/ARCHITECTURE-MVP1.md` §2.1 (D13) |
| R21 | Cron is a platform scheduler hitting an authenticated internal route guarded by `CRON_SECRET`, never an in-process timer | `docs/ARCHITECTURE-MVP1.md` §7 |

Inherited from the slice 0 acceptance review (`docs/specs/SLICE-0-FINDINGS.md`, gate "before slice 1 lands pricing code"): **F-1, F-9, F-10, F-16**. These are acceptance criteria of this slice, not advisory notes — see §10, criteria 1–8.

---

## 3. Native Shopify vs custom boundary

### Shopify owns (do not rebuild, do not wrap, do not mirror)

| Concern | Note |
|---|---|
| The product and variant records themselves | The Shopify variant is the canonical purchasable thing. Our `master_variant` is the *design and cost definition*, joined to it by `shopify_variant_gid`. |
| The price the customer is actually charged | Shopify's `variant.price` field. Our computed price becomes that value only after slice 2 pushes it. |
| Cart, checkout, payments, taxes, discounts, inventory | Untouched by this slice. |
| Currency and money display to the customer | Shopify formats and charges. We compute. |

### Custom owns (built here)

| Concern | Note |
|---|---|
| Cost component libraries (metal, stone, labour, overhead) | Shopify has no concept of a cost structure with effective dating and shape-specific stone pricing. `README.md` §Cost Component Libraries. |
| Master product/variant design definition, weights, ring-size bands | Shopify variants cannot express "base weight 3.2 g at size 6, +0.15 g per size, band 6.5–8 priced at its heaviest size". |
| Pricing profiles, margin models, minimum-profit floors | Shopify has no margin engine. |
| The pricing calculation, its versioning, and its reproducibility record | The core deliverable. |
| The recalculation job and the review/approval decision | Shopify has no approval workflow over price changes. |

### How a computed price reaches a Shopify product/variant

```
  master_variant  --(engine)-->  price_calculation (immutable, hashed)
                                        |
                                  sync decision (pure)
                                        |
                        price_sync_intent (mutable state machine)
                                        |
                       ==== SLICE 1 ENDS HERE ====
                                        |
                        ShopifyPriceSyncPort (interface defined here,
                                        |    implemented in slice 2)
                                        v
                 Admin GraphQL productVariantsBulkUpdate  → variant.price
```

Slice 1 defines the port and produces approved intents. Slice 1 ships **one** implementation of the port: `RecordingPriceSyncPort`, which records the call and marks the intent `synced` **only in tests and local development** — it is never wired into the production job path, and the production wiring throws `PriceSyncNotImplementedError` if invoked. This is deliberate: an unimplemented port that silently no-ops would make slice 1 look like it is syncing prices when it is not.

### Explicit prohibition (R14)

No cost, margin, supplier, component-breakdown or `price_calculation` field may be written to a Shopify metafield, rendered into Liquid, returned from an App Proxy route, or logged. Slice 1 adds no storefront-reachable route at all; the only new route is the `CRON_SECRET`-guarded internal job route. `docs/ARCHITECTURE-MVP1.md` §5's rule stands: metafields are a presentation cache and money is never reconciled from them.

---

## 4. The cost model

### 4.0 Layering — the six domains that stay separated

Six concerns are kept in separate modules with a one-way dependency direction. Point at any file this slice adds and it must be obvious which layer it belongs to; if it is not, the file is doing two jobs.

```
L1 raw inputs ──► L2 normalized libraries ──┐
                                            ├──► [composition] ──► L3 cost ──► L5 price ──► L6 record
L4 profiles / policy ───────────────────────┘                          ▲
                                                                       └── L4 registries (rounding, price ending)
```

| # | Layer | Modules | Tables | May depend on | Must never |
|---|---|---|---|---|---|
| **L1** | **Raw supplier/market cost inputs** — values exactly as entered or received, with author, source and effective date | `prisma/seed.ts`; the ingestion port in §4.7 | `metal_price`, `stone_cost`, `cost_component`, `pricing_profile` (as written) | — | be edited in place (all four are append-only); be normalised, converted or "cleaned" on the way in |
| **L2** | **Normalized cost libraries** — effective-dated resolution: which row applies to this key at this instant, specificity ordering, provenance tagging | `app/app/db/repositories/{metalPrice,stoneCost,costComponent,pricingProfile}Repository.server.ts` | reads L1 | L1 | compute a cost, apply a margin, round, or return a `Prisma.Decimal` or a JS `number` — it returns decimal strings / `Money` with `{ sourceTable, sourceId, effectiveFrom }` provenance (§5.6) |
| **L3** | **Product cost calculation** — weight, and landed cost `C` for one variant at one size | `app/app/domain/pricing/weight.ts`, `cost.ts` | none | nothing; every input arrives as an argument | know that a selling price exists; touch a repository, a clock or the environment |
| **L4** | **Pricing profiles / policy** — margin objective, hard floors, tolerance, rounding rule id, price-ending rule id, margin model | `pricing_profile` row; registries `app/app/domain/money/rounding.ts`, `app/app/domain/pricing/priceEnding.ts`, `version.ts` | `pricing_profile` | L2 for retrieval only | hold product-, variant- or supplier-specific logic. A rule that applies to one product is not a policy; it is a cost input or a variant floor |
| **L5** | **Final customer selling price** — the solve, the floors, the single rounding boundary, band selection | `app/app/domain/pricing/solve.ts`, `bands.ts`, `engine.ts` | none | L3 and L4, as arguments | reach back to L2 or L6 for anything; read a previous `price_calculation` |
| **L6** | **Historical / versioned pricing record** — what was computed, from which inputs, under which versions | `app/app/domain/evidence/snapshot.ts` (slice 0), `priceCalculationRepository.server.ts` | `snapshot`, `price_calculation`, `price_sync_intent`, `audit_event` | L5's output | be read back as an input to a new calculation. A recalculation resolves inputs afresh from L1/L2 — it never falls back to the last price (§4.5) and never reaches a refund (§12 C-S4) |

**Exactly one module composes the layers.** `app/app/jobs/pricing/resolveInputs.server.ts` is the only place permitted to hold a reference to both an L2 repository and an L3/L5 pure function. It resolves every input (including `resolveAssumedPaymentCost`, §4.6), assembles the JSON-safe `BuyNowPricingInputs`, calls the engine and hands the result to L6. If a second module starts doing that, the layering is gone regardless of what this table says.

**The one mechanically enforceable rule.** L3, L5 and L4's registries all live under `app/app/domain/pricing/**`, which must contain **no import** of `app/app/db/**`, `@prisma/client`, any `*.server.ts` module, `node:*` or `process.env`, and no call to `Date.now()` or `new Date()`. Criterion 34 asserts this by reading the imports of every file in the directory. Everything else in the table above is checked at architect review; that one is checked by the test suite, which is why it is the boundary worth stating first.

### 4.1 Units and types — the single most important table in this spec

There are exactly three numeric representations in this slice. Every value belongs to exactly one of them, and the boundaries between them are named functions.

| Representation | Used for | Storage | In-memory | JSON / evidence |
|---|---|---|---|---|
| **Money** — integer minor units + ISO-4217 currency | Any amount that is or becomes a charged/comparable amount: computed price, fixed cost components, minimum dollar profit, variant floor | `BIGINT` + `CHAR(3)` (F-16 convention) | `Money` (`app/app/domain/money/money.ts`) | `MoneyJSON` = `{ amountMinorUnits: string, currency: string }` |
| **Rate decimal** — an exact decimal that is *not itself* an amount | Price per gram, price per carat, percentages, gram weights, ring sizes | `NUMERIC(p,s)` with the scale fixed per column (§7) | `MoneyDecimal` (`app/app/domain/money/decimal.ts`, precision 40) | **decimal string**, e.g. `"48.250000"` — never a JS `number` (F-10) |
| **Plain integer** | Counts, quantities, indices, basis points, tier numbers | `INTEGER` | `number` | `number` (permitted; these are the only permitted JSON numbers) |

Three hard rules follow, and each has an acceptance criterion:

1. **Prisma `Decimal` never becomes a `number`.** Prisma returns `NUMERIC` as a `Prisma.Decimal`. It is a decimal.js instance, but a *different clone* from our `MoneyDecimal`. Cross the boundary with `new MoneyDecimal(prismaDecimal.toString())`. **`.toNumber()` is banned repository-wide** and added to the money-safety scan (§10, criterion 2).
2. **Engine-internal arithmetic is in MINOR units**, as `MoneyDecimal`, with fractional minor units permitted intermediately. The rounding registry (`rounding.ts`) already operates on minor units: `round(decimalMinorUnits): bigint`. Staff enter a metal price in *major* units per gram (dollars/gram) because that is how the market quotes it; conversion happens once, at ingestion, in a named function.
3. **There is exactly one load-bearing rounding boundary per calculation: the final unit price.** Every other money-shaped value stored on the breakdown (`metal_cost`, `stone_cost`, `landed_cost`, …) is a rounded *projection for display and audit* and **must never be fed back into a later step of the calculation**. Double rounding is a correctness defect here, not a cosmetic one.

### 4.2 Input inventory

| Input | Where it comes from | Unit / type | Notes |
|---|---|---|---|
| Metal price per gram | `metal_price` table, staff-entered via `MetalPriceSource` adapter (D2) | `NUMERIC(18,6)` major units per gram + currency | Keyed by `metal` × `purity`. Effective-dated. Records `source` (`manual` \| `feed`), `entered_by`, optional note. |
| Metal loss / scrap allowance | `cost_component`, type `metal_loss` | percentage of metal cost | **Seeded explicitly as 0** so it is configurable without being invented. An *absent* row is an error (§4.5); an explicit zero is not. |
| Stone cost | `stone_cost` table | per-stone `Money` **or** per-carat `NUMERIC(18,6)` | Lookup key **includes shape** (R4). See §4.3. |
| Labour: CAD, casting, setting, polishing, assembly, QC | `cost_component`, one type each | fixed `Money`, **per-stone** `Money`, or percentage | Setting is normally per-stone; the engine supports all three value kinds for every labour type rather than special-casing. |
| Packaging | `cost_component` type `packaging` | fixed `Money` | |
| Shipping | `cost_component` type `shipping` | fixed `Money` | R12. |
| Insurance | `cost_component` type `insurance` | fixed `Money` **or** percentage of **order value** | See §4.4 — a percentage of order value is revenue-side, not cost-side. |
| Warranty reserve | `cost_component` type `warranty_reserve` | fixed `Money` or percentage of cost subtotal | |
| Supplier / other allocated | `cost_component` types `supplier_fee`, `other` | fixed `Money` or percentage | |
| Payment processing | `cost_component` type `payment_processing` | percentage of order value **plus** fixed `Money` | **D9-sensitive** — see §4.6. |
| Target gross margin %, minimum gross margin %, minimum dollar profit, rounding rule, tolerance | `pricing_profile` (versioned) | `NUMERIC(9,6)` / `Money` / rule id / bps integer | Values are owner data — see §13, D14. |
| Variant-specific price floor | `master_variant.min_price_minor_units` (nullable) | `Money` | R11. |
| Gram weight | computed from `master_variant` + selected size, or from an exact override | `NUMERIC(10,4)` grams | §5. |

### 4.3 Stone cost lookup (R3, R4)

`stone_cost` rows are effective-dated and keyed on the tuple:

`(stone_type, shape, carat_min, carat_max, color, clarity, cut_grade, lab_status, supplier_ref)`

- `stone_type` ∈ `natural_diamond | lab_diamond | moissanite | colored_gemstone | accent_melee`.
- `shape` is **required and part of the key** (R4). A lookup that finds a row for the right carat but the wrong shape is a miss, not a fallback.
- Carat is banded: `carat_min` inclusive, `carat_max` exclusive. Bands for a given key-prefix must not overlap — enforced by a validation function and an integration test, not only by convention.
- `color`, `clarity`, `cut_grade`, `lab_status`, `supplier_ref` are nullable and, when null on the cost row, act as **wildcards**. Specificity ordering is deterministic and fixed: among applicable rows, choose the one with the **greatest number of non-null matched qualifiers**; ties break on the **latest `effective_from`**; a remaining tie is an error (`AmbiguousStoneCostError`), never an arbitrary pick.
- A miss is `MissingCostInputError`, never zero (§4.5).

### 4.4 Cost-side vs revenue-side components — the circularity resolution

Two configured costs are naturally expressed as a percentage of the **selling price**, not of cost: payment processing (R2) and full-value shipment insurance (R12 + `README.md` §Shipping: "every outbound customer shipment is insured for the full order value"). Both create a circular dependency — the price depends on a fee that depends on the price.

**Do not solve this iteratively.** Every `cost_component` carries an explicit `basis`:

- `basis = cost_side` — the amount enters the landed cost `C`. A `cost_side` percentage component is a percentage of the **cost subtotal accumulated so far**, evaluated in the fixed order given in §5.2.
- `basis = revenue_side` — the component's percentage rate enters the denominator, and its fixed part enters the numerator, of the closed-form solve in §5.3.

This is a data classification, not a code branch per component type. An insurance component configured as a fixed dollar amount is `cost_side`; the same concern configured as 1.2% of order value is `revenue_side`. Both are supported; which one MVP1 uses is configuration.

### 4.5 Missing input policy — absent is an error, explicit zero is not

If any cost component required by a master variant's cost recipe has **no applicable effective row** at the calculation timestamp, the calculation for that variant **throws `MissingCostInputError`** naming the component, and the job records the variant as `failed` with that reason and continues to the next variant. It does **not** treat the input as zero, does not omit it, and does not fall back to a previous calculation.

A row that exists with value `0` is a legitimate, auditable statement that the cost is zero. This distinction is the difference between "we decided this is free" and "we silently under-priced the product".

### 4.6 D9 (payment methods to encourage) — how the engine stays unblocked

`docs/ARCHITECTURE-MVP1.md` §12 D9 is **open**: which payment methods CaratForUs encourages as lower-cost is an owner decision, and payment cost is a pricing-engine input.

The engine never learns about payment *methods*. It consumes a single resolved pair:

```ts
interface AssumedPaymentCost {
  /** Revenue-side rate, decimal string, e.g. "0.029". */
  rate: string;
  /** Fixed per-order component. */
  fixedFee: MoneyJSON;
}
```

produced by one function, `resolveAssumedPaymentCost(asOf): AssumedPaymentCost`, which in slice 1 reads the single active `payment_processing` component. When D9 resolves, that function's body becomes a weighted blend across a method mix (a new `payment_method_mix` table, if the owner's answer needs one) and **nothing in the engine, its tests, its stored snapshots or its acceptance criteria changes**. Implementers must not anticipate the blend: build the single-component version, and keep the seam at that one function.

### 4.7 Extension seams — feeds and supplier overrides must not rewrite the engine

Two extensions are known to be coming. Each is specified the way §4.6 handles D9: name the seam, name what changes, and name what must not.

#### Seam A — an automated metal-price feed (D2, R16)

**Pre-provisioned now:** `metal_price.source` (`manual` | `feed`); a **nullable** `entered_by` (a feed row has no human author — the column is nullable for that reason, not by oversight); and an ingestion-side port in `app/app/jobs/pricing/ports.ts`:

```ts
interface MetalPriceIngestionSource {
  /** Quotes in MAJOR units per gram as decimal strings, with the source's own timestamp. */
  fetchQuotes(asOf: string): Promise<readonly MetalQuote[]>;
}
```

Slice 1 ships `ManualEntryMetalPriceSource`, which returns an empty list and carries a comment stating that staff write `metal_price` rows directly (seed data now, admin UI later).

**When the feed arrives, what changes:** one new implementation of `MetalPriceIngestionSource`; a scheduled caller that writes `metal_price` rows with `source = 'feed'`; a feed credential as an environment variable; possibly the scheduler cadence (D15).

**What must not change:** the `metal_price` schema, the repository's resolution rule, the engine, its tests, its stored snapshots, its acceptance criteria, or `BuyNowPricingInputs`.

**The rule that keeps it that way:** `source` is **provenance — recorded and displayed, never selected on**. Resolution for a `(metal, purity)` key is exactly "the row with the greatest `effective_from ≤ asOf`", regardless of source. Do not write "prefer feed over manual", do not add a priority column, and do not branch on `source` anywhere under `app/app/domain/pricing/**` or in any resolver. Feed-preferred-with-manual-override, if the owner ever wants it, is then a change to one ordering expression in one repository function — but only if slice 1 declines to pre-empt it with a half-guess. (Criterion 36.)

#### Seam B — supplier-specific cost overrides

**Pre-provisioned now:** `stone_cost.supplier_ref` is part of the lookup key (§4.3), and the specificity ordering already ranks a matched qualifier above a wildcard.

**What is genuinely undefined today, stated plainly:** slice 1 has **no supplier dimension on a product**. `master_variant_stone` records no supplier, so every lookup is issued with `supplier_ref = null`, only supplier-agnostic rows are applicable, and a `stone_cost` row carrying a non-null `supplier_ref` is **inert** — it must not be seeded as though it were live pricing. Precedence between a supplier-specific row and a *more qualified* supplier-agnostic row (supplier X with clarity wildcard, versus any supplier with clarity VS1) is **deliberately undecided**. Deciding it now would be inventing a supplier hierarchy with no requirement behind it.

**The minimum slice 1 must do:**

1. Keep `supplier_ref` in the key and in the stored provenance.
2. Implement effective-dating and specificity **once**, as a single shared helper used by every effective-dated resolver:
   ```ts
   selectMostSpecific<TRow>(rows, query, qualifierKeys): TRow  // ties -> latest effective_from; remaining tie -> throw
   ```
   so that a second table gaining a supplier dimension reuses it instead of growing a second copy of the rule.
3. Add no supplier column to `cost_component`, no supplier table and no sourcing model.

**When supplier overrides arrive, what changes:** a nullable supplier reference on `master_variant_stone` (or a sourcing table — owner's call), passed into the stone-cost query; an answer to the precedence question above, expressed as the `qualifierKeys` ordering handed to `selectMostSpecific`; seed data.

**What must not change:** the engine, `BuyNowPricingInputs`, stored snapshots, the rounding/versioning design, or any criterion in §10. The engine receives each stone cost as an already-resolved value with provenance and cannot tell how it was chosen — which is the whole point. (Criterion 37.)

---

## 5. The pricing calculation — deterministic specification

### 5.0 Function-level decomposition — there is no single pricing function

§5.1–§5.7 give the semantics; this gives the shape. Every function below is pure, receives resolved values as arguments (a function that needs a cost **is handed it**, never fetches it), returns a value, and is unit-testable with no database, no repository and no stub except where noted. `Dec` is `MoneyDecimalValue`; `DecimalString` is a decimal as a string (§4.1).

| File | Function | Signature | Implements |
|---|---|---|---|
| `weight.ts` | `validateSize` | `(spec: SizeSpec, size: DecimalString) => void` | §5.1 rule 4; throws `InvalidSizeError` |
| `weight.ts` | `calculateWeightGrams` | `(spec: WeightSpec, size: DecimalString) => DecimalString` | §5.1 rules 1–3, 5 |
| `cost.ts` | `calculateMetalCost` | `({ pricePerGramMinorUnits, weightGrams, metalLossRate }) => Dec` | §5.2 steps 1–2 |
| `cost.ts` | `calculateStoneCost` | `(positions: readonly ResolvedStonePosition[]) => { totalMinorUnits: Dec; stoneCount: number }` | §5.2 step 3 |
| `cost.ts` | `orderCostSideComponents` | `(components: readonly ResolvedCostComponent[]) => readonly ResolvedCostComponent[]` | the load-bearing order of §5.2 steps 4–5, as one named function instead of an implicit array order |
| `cost.ts` | `applyCostSideComponents` | `(subtotal: Dec, ordered: readonly ResolvedCostComponent[], stoneCount: number) => { total: Dec; perComponent: readonly { componentId: string; amount: Dec }[] }` | §5.2 steps 4–5, all three value kinds |
| `cost.ts` | `calculateLandedCost` | `(input: LandedCostInput) => LandedCostBreakdown` | §5.2 end to end; composes the four above; returns exact unrounded decimals |
| `cost.ts` | `partitionRevenueSide` | `(components: readonly ResolvedCostComponent[]) => { rate: Dec; fixedMinorUnits: Dec }` | the `r` and `f` of §5.3 |
| `solve.ts` | `solveExactPrice` | `({ landedCostMinorUnits, targetGrossMarginRate, revenueRate, revenueFixedMinorUnits, minDollarProfitMinorUnits, variantFloorMinorUnits }) => { exact: Dec; binding: "margin" \| "min_profit" \| "variant_floor" }` | §5.3; throws `UnreachableMarginError` |
| `solve.ts` | `evaluateFloors` | `({ priceMinorUnits: bigint, landedCostMinorUnits, revenueRate, revenueFixedMinorUnits, minGrossMarginRate, minDollarProfitMinorUnits, variantFloorMinorUnits }) => { satisfied: boolean; contribution: Dec; grossMargin: Dec; failing: readonly FloorId[] }` | §5.5 **predicate only — no loop** |
| `solve.ts` | `enforceFloors` | `(input: same, maxBumps: number) => { priceMinorUnits: bigint; bumps: number; final: FloorEvaluation }` | §5.5 bounded loop; throws `MarginFloorUnreachableError` |
| `priceEnding.ts` | `applyPriceEnding` | `(priceMinorUnits: bigint, ruleId: PriceEndingRuleId) => bigint` | §5.4 registry; `NONE_V1` only in slice 1 |
| `bands.ts` | `validateBandCoverage` | `(bands: readonly BandSpec[], spec: SizeSpec) => void` | §5.7 gapless, non-overlapping |
| `bands.ts` | `enumerateBandSizes` | `(band: BandSpec, spec: SizeSpec) => readonly DecimalString[]` | §5.7; throws `InvalidBandError` when empty |
| `bands.ts` | `selectBandPrice` | `(candidates: readonly DecimalString[], priceAtSize: (size: DecimalString) => BuyNowPriceResult) => { bandPrice: Money; costBasisSize: DecimalString; perSize: readonly …[] }` | §5.7 max-and-tie. **The per-size evaluation is injected**, so the max/tie logic is tested against a three-line stub and `bands.ts` never imports `engine.ts` |
| `engine.ts` | `computeBuyNowPrice` | `(inputs: BuyNowPricingInputs) => BuyNowPriceResult` | §5.6 — composition only |
| `engine.ts` | `computeBuyNowBandPrice` | `(inputs: BuyNowBandPricingInputs) => BuyNowBandPriceResult` | binds `computeBuyNowPrice` into `selectBandPrice` |
| `types.ts`, `errors.ts`, `version.ts` | — | — | shared types; the named errors; `PRICING_ENGINE_VERSION` |

Splitting `evaluateFloors` (predicate) from `enforceFloors` (loop) is what turns criterion 18's subtle requirement — *not* bumped merely for falling a fraction below the **target** — into a one-line test.

**The anti-monolith rule.** `engine.ts` performs **no money or rate arithmetic of its own**: every `+ − × ÷` on a `Money` or decimal quantity lives in `cost.ts`, `solve.ts`, `weight.ts` or `Money` itself. `computeBuyNowPrice` is a sequence of named calls — validate size → weight → landed cost → revenue-side partition → solve → round once (§5.4) → price ending → enforce floors → assemble the breakdown. If it contains a formula, the formula is in the wrong file. An implementer tempted to inline "just this one subtraction" adds a named function instead. Checked at architect review and by criterion 35.

### 5.1 Weight (R8, R9)

Pure, in `app/app/domain/pricing/weight.ts`.

```
calculateWeightGrams(variant, size) -> decimal string (grams, scale 4)
```

Ordered rules, applied exactly in this order:

1. If an **exact finished-weight override** exists for `(master_variant, size)`, return it. Overrides win unconditionally (R8).
2. Otherwise, if the product's `size_axis` is `none`, return `base_weight_grams`.
3. Otherwise `weight = base_weight_grams + ((size − base_size) × weight_per_full_size)`. Half and quarter sizes fall out of this arithmetic naturally — there is no separate half-size branch. `size` may be below `base_size`, producing a negative delta.
4. `size` must lie within `[allowed_size_min, allowed_size_max]` and be an exact multiple of `size_increment` offset from `allowed_size_min`; otherwise `InvalidSizeError`. Validate **before** step 1.
5. If the resulting weight is `≤ 0`, throw `InvalidWeightError`. A non-positive weight is a data error, never a free product.

`size_axis` ∈ `ring_size_us | length_inches | none`. This generalises the base-plus-increment model to chains, bracelets and necklaces (R8) without a second code path; `size` is a `NUMERIC(6,2)` decimal in the axis's own unit. All size arithmetic is `MoneyDecimal`, never JS `number`.

### 5.2 Landed cost `C` (decimal, minor units)

Evaluated in exactly this order. The order is load-bearing because `cost_side` percentage components apply to the subtotal accumulated *before* them.

1. `metal = pricePerGramMinor × weightGrams`
2. `metal += metal × metalLossRate`
3. `stones = Σ over each stone position: unitCost × quantity`, where `unitCost` is the per-stone cost, or `perCaratCost × carat` when the matched row is per-carat.
4. `labour = Σ over labour components`, each evaluated by its value kind: `fixed` → its amount; `per_stone` → amount × total stone count; `percentage` → rate × subtotal-so-far.
5. `overhead = Σ over packaging, shipping, insurance(cost_side), warranty_reserve, supplier_fee, other`, same three value kinds, in the fixed order just listed.
6. `C = metal + stones + labour + overhead`

All six steps are `MoneyDecimal` in minor units. Nothing is rounded here.

### 5.3 Price solve

Let:
- `m` = `target_gross_margin_rate` (profile, decimal)
- `r` = Σ of all **revenue-side** percentage rates (payment rate, insurance-on-order-value rate, …)
- `f` = Σ of all **revenue-side** fixed amounts, in minor units
- `minProfit` = profile `min_dollar_profit`, minor units

```
denominator = 1 − m − r
if denominator <= 0  -> throw UnreachableMarginError
P_margin     = (C + f) / denominator
P_minProfit  = (C + f + minProfit) / (1 − r)          // (1 − r) <= 0 also throws
P_floor      = variant.min_price_minor_units  (or 0 if unset)
P_exact      = max(P_margin, P_minProfit, P_floor)
```

Gross margin is defined **on price**, not on cost, because R11's validation rule is stated as a minimum gross-margin *percentage* and the price formula and the floor check must use the same definition. The profile carries `margin_model` with `TARGET_GROSS_MARGIN_V1` as the Buy Now default; `MARKUP_ON_COST_V1` (`P = C × (1 + k)`, then the same floors) is registered for future profiles but is not used in slice 1. Adding a model is a registry addition, not a schema change.

### 5.4 The single rounding boundary

```
price = Money.fromDecimalMinorUnits(P_exact, currency, profile.rounding_rule_id)
```

`Money.fromDecimalMinorUnits(value, currency, roundingRuleId)` is a **new method added to `app/app/domain/money/money.ts` by this slice** — the minor-unit twin of the existing `fromDecimalMajorUnits`, which should be re-expressed in terms of it. It is the *only* place the pricing engine rounds.

`profile.rounding_rule_id` is a `RoundingRuleId` from the existing registry; MVP1 uses `HALF_UP_MINOR_UNIT_V1`. The profile also carries `price_ending_rule_id`, a new registry in `app/app/domain/pricing/priceEnding.ts` containing exactly one entry in slice 1: `NONE_V1` (identity). Charm pricing (`.99` endings) is **not** introduced; the registry exists so that adding one later is a versioned, reviewable act rather than an edit to the engine. An id, once referenced by a stored calculation, may never change behaviour — the same rule the rounding registry already states.

### 5.5 Post-rounding floor re-validation (do not skip this)

Rounding to the cent can land marginally below the target. The **floors** (R11) are hard and are therefore checked **after** rounding, against the rounded price, in exact decimal:

```
deductions   = r × price + f
contribution = price − deductions − C          // exact decimal, not rounded
grossMargin  = contribution / price

while (grossMargin < profile.min_gross_margin_rate
       || contribution < minProfit
       || price < P_floor) {
    price = price + 1 minor unit
    recompute deductions/contribution/grossMargin
    if iterations > 100 -> throw MarginFloorUnreachableError
}
```

Note the deliberate distinction, which the implementer must preserve: `target_gross_margin_rate` is the pricing **objective** used in §5.3; `min_gross_margin_rate` is the hard **floor** checked here. The schema enforces `min_gross_margin_rate <= target_gross_margin_rate`. Comparing the rounded price against the target (rather than the floor) would make the loop bump nearly every price by a cent for no reason.

### 5.6 Determinism, versioning and reproducibility

The engine is a pure function in `app/app/domain/pricing/engine.ts`:

```ts
computeBuyNowPrice(inputs: BuyNowPricingInputs): BuyNowPriceResult
```

- No I/O, no clock, no randomness, no `Date.now()`. `asOf` is a field on `inputs`.
- `BuyNowPricingInputs` is **JSON-safe by type**: every decimal is a `string`, every amount is a `MoneyJSON`, every timestamp is an ISO-8601 `string`, and the only `number`s are counts and indices. This is what discharges F-10.
- Each resolved input carries its provenance: `{ sourceTable, sourceId, effectiveFrom, value }`. Reproduction therefore needs no database.
- `PRICING_ENGINE_VERSION` is a constant in `app/app/domain/pricing/version.ts`, bumped whenever the formula, the ordering in §5.2, or the floor logic changes. Bumping it is an architect-reviewed change.

**Reproducibility contract (an acceptance criterion, §10 criterion 19).** For any stored calculation:

```
computeBuyNowPrice(snapshot.payload.inputs) == stored result
```

byte-for-byte on the canonical JSON of the result, **provided** `snapshot.payload.engineVersion === PRICING_ENGINE_VERSION`. When the engine version has moved on, reproduction is expected to be attempted against the historical inputs and the *difference* reported — it must not be silently asserted equal. Ship a `verifyPriceCalculation(id)` function and a CLI verb that does exactly this; it is the auditability deliverable of R6 and R15.

### 5.7 Ring-size bands (R9, R18)

A Shopify variant is `metal × band`. A band is priced at the price of its **worst case**:

```
priceBand(variant, band):
  candidates = every allowed size s in [band.min, band.max]
               at the product's size_increment
  if candidates is empty -> InvalidBandError
  for each s: p_s = full §5.2–§5.5 calculation at size s
  bandPrice     = max over s of p_s
  costBasisSize = the s attaining that max (lowest such s on a tie)
```

Decomposed per §5.0 this is `enumerateBandSizes` followed by `selectBandPrice(candidates, priceAtSize)`, with the per-size evaluation injected as a function argument.

**Evaluate the full price at every size in the band; do not shortcut to `band.max`.** The shortcut is correct only while weight increases monotonically with size, and an exact finished-weight override (R8) or a size-specific labour component can break monotonicity — which is precisely the case where the shortcut sells below floor. Bands contain at most ~20 candidate sizes; the cost of being right is negligible.

`costBasisSize` is stored on the calculation. Internal cost still evaluates expected weight by exact size (R9) — that is what the per-candidate evaluation is.

Default bands (2–6, 6.5–8, 8.5–11) are **seed data on the product**, not constants in code, and are configurable per product (R9). Bands must cover the product's allowed size range without gaps or overlaps; validate at write time and in an integration test.

### 5.8 Worked example — ground truth for the test authors

A 14K yellow gold ring, base size 6, base weight `3.2000` g, `+0.1500` g per full size; 1 lab round 1.00 ct centre; 12 accent melee. Profile: target gross margin `0.42`, min gross margin `0.35`, min dollar profit `$150.00`, payment `2.9% + $0.30` (revenue-side), rounding `HALF_UP_MINOR_UNIT_V1`. All figures in **minor units (cents)** unless stated.

| Step | Value |
|---|---|
| Size 8 weight | `3.2 + (8 − 6) × 0.15` = **3.5000 g** |
| 14K price/gram | `$48.250000` → `4825.000000` minor/g |
| Metal | `4825 × 3.5` = **16887.5** |
| Metal loss (0%) | +0 → **16887.5** |
| Centre stone (lab, round, 1.00 ct) | `$420.00` = **42000** |
| Accent melee 12 × `$3.25` | **3900** |
| Stones | **45900** |
| Labour: casting `$25.00`; setting `$4.00` × 13 stones; polishing `$8.00`; QC `$5.00` | `2500 + 5200 + 800 + 500` = **9000** |
| Packaging `$6.00`, shipping `$12.00`, insurance (cost-side fixed) `$3.00` | **2100** |
| Cost subtotal before warranty reserve | **73887.5** |
| Warranty reserve, 2% of subtotal (cost-side) | **1477.75** |
| **Landed cost `C`** | **75365.25** |
| `r` = 0.029, `f` = 30, `m` = 0.42 | denominator `= 0.551` |
| `P_margin = (75365.25 + 30) / 0.551` | **136833.484573502722323…** |
| `P_minProfit = (75365.25 + 30 + 15000) / 0.971` | **93095.005149330587…** |
| `P_exact = max(...)` | **136833.484573502722323…** |
| Round HALF_UP at the minor unit | **136833** = **$1,368.33** |
| Post-round check: deductions `= 0.029 × 136833 + 30` | `3998.157` |
| contribution `= 136833 − 3998.157 − 75365.25` | `57469.593` (= `$574.70`) |
| gross margin `= 57469.593 / 136833` | `0.419998…` ≥ `0.35` floor ✔ |
| dollar profit `$574.70` ≥ `$150.00` ✔ | no bump; final price **$1,368.33** |

Band `6.5–8` at increment `0.5` has candidates `6.5, 7, 7.5, 8`; size 8 is the maximum, so the band price is **$1,368.33** with `cost_basis_size = 8.00`.

This exact case must appear as a unit test. The intermediate values above are the assertions.

---

## 6. Evidence and audit

- The engine inputs **and** the component breakdown are stored as **one** `snapshot` row (slice 0's append-only, content-hashed evidence table), `kind = "pricing.buy_now_calculation.v1"`, payload `{ engineVersion, profileVersion, roundingRuleId, priceEndingRuleId, asOf, inputs, breakdown, result }`. `price_calculation.snapshot_id` references it.
- Snapshots are **content-addressed and reused**: before inserting, look up `(kind, contentHash)`; if a row exists, reference it. A daily job over unchanged inputs therefore does not grow the evidence table without bound. A duplicate row created by a race is harmless.
- `price_calculation` itself is **append-only at the database level**, extending slice 0's trigger function to the new table. Note the standing caveat **F-7** (`docs/specs/SLICE-0-FINDINGS.md`): until the slice-2 deploy task splits the migration role from the runtime role, append-only is enforced by a trigger the runtime role could drop. Slice 1 must not describe it as fully enforced.
- Every price-affecting staff action writes an `audit_event`: cost-component or metal-price creation, profile version creation, approval, rejection, and authorised override of a margin floor. Actor, entity, before/after, reason.
- **F-10 applies to all of the above**: no JS `number` for any decimal quantity in any evidence payload. Gram weights and price-per-gram are the specific values at risk and must be decimal **strings**.

---

## 7. Persistence

New Prisma models and one migration. Naming and mapping follow slice 0's conventions (`@map` snake_case, `@db.Uuid` ids, `@default(now())` timestamps).

### 7.1 The F-16 convention, demonstrated

Slice 0's schema header describes the money convention but never demonstrates it. Slice 1 is the first schema with money columns and must both **demonstrate it in a real model** and **add the commented example** F-16 asks for:

```prisma
// ---------------------------------------------------------------------------
// MONEY COLUMN CONVENTION (F-16). Every monetary amount is stored as two
// columns: BIGINT minor units + CHAR(3) ISO-4217 currency. Never NUMERIC,
// never DOUBLE PRECISION, never a bare integer without its currency.
//
//   computedPriceMinorUnits BigInt  @map("computed_price_minor_units")
//   currency                String  @db.Char(3)
//
// Prisma maps BIGINT to a JS `bigint`. `JSON.stringify` THROWS on a bigint —
// "Do not know how to serialize a BigInt". Never return a raw row across a
// JSON boundary. Repositories convert at their edge:
//
//   Money.fromMinorUnits(row.computedPriceMinorUnits, row.currency)
//
// and Money.toJSON() yields { amountMinorUnits: string, currency } — lossless
// and JSON-safe. See app/app/domain/money/money.ts.
//
// RATE COLUMNS are different and are NOT money: a price per gram, a price per
// carat, a percentage, a gram weight or a ring size is NUMERIC(p,s) with the
// scale fixed below. Prisma returns these as Prisma.Decimal. Cross into the
// domain with `new MoneyDecimal(d.toString())`. `.toNumber()` is banned —
// the money-safety scan fails on it.
// ---------------------------------------------------------------------------
```

### 7.2 Models

| Model | Key columns | Notes |
|---|---|---|
| `metal_price` | `metal` enum, `purity` enum, `pricePerGram NUMERIC(18,6)`, `currency CHAR(3)`, `effectiveFrom`, `source` enum(`manual`,`feed`), `enteredBy`, `note` | Unique `(metal, purity, effectiveFrom)`. Metals per R10: `sterling_silver`, `gold`, `platinum`; purity `925`, `10k`, `14k`, `18k`, `pt950`. Append-only. |
| `stone_cost` | key tuple from §4.3, `costKind` enum(`per_stone`,`per_carat`), `costMinorUnits BigInt?` + `currency`, `costPerCarat NUMERIC(18,6)?`, `effectiveFrom`, `supplierRef` | Exactly one of the two cost columns non-null — CHECK constraint. Append-only. |
| `cost_component` | `componentType` enum, `basis` enum(`cost_side`,`revenue_side`), `valueKind` enum(`fixed`,`per_stone`,`percentage`), `amountMinorUnits BigInt?` + `currency`, `rate NUMERIC(9,6)?`, `effectiveFrom`, `enteredBy`, `note` | Exactly one of amount/rate non-null per `valueKind` — CHECK constraint. Append-only. |
| `pricing_profile` | `code` enum, `version INT`, `marginModel`, `targetGrossMarginRate NUMERIC(9,6)`, `minGrossMarginRate NUMERIC(9,6)`, `minDollarProfitMinorUnits BigInt` + `currency`, `roundingRuleId`, `priceEndingRuleId`, `autoApplyToleranceBps INT`, `effectiveFrom`, `createdBy` | Unique `(code, version)`. CHECK `minGrossMarginRate <= targetGrossMarginRate`. Append-only — a change is a new version. |
| `master_product` | category/design metadata, `sizeAxis` enum, `allowedSizeMin/Max NUMERIC(6,2)`, `sizeIncrement NUMERIC(6,2)`, `baseSize NUMERIC(6,2)`, `offeredMetals`, `shopifyProductGid?`, `isLuxurySteal Boolean @default(false)`, `status` | `offeredMetals` is explicit per R10. `isLuxurySteal` exists so the exclusion port has something to read; slice 3 owns its semantics. |
| `master_variant` | `masterProductId`, `metal`, `purity`, `bandId?`, `baseWeightGrams NUMERIC(10,4)`, `weightPerFullSizeGrams NUMERIC(10,4)`, `minPriceMinorUnits BigInt?` + `currency`, `shopifyVariantGid?`, `status` | Unique `(masterProductId, metal, purity, bandId)`. Unique `shopifyVariantGid` where not null. |
| `ring_size_band` | `masterProductId`, `label`, `sizeMin`, `sizeMax NUMERIC(6,2)`, `sortOrder` | Per-product, configurable (R9). Validated for gapless, non-overlapping coverage. |
| `variant_weight_override` | `masterVariantId`, `size NUMERIC(6,2)`, `weightGrams NUMERIC(10,4)`, `reason` | Unique `(masterVariantId, size)`. R8. |
| `master_variant_stone` | `masterVariantId`, `position`, `stoneType`, `shape`, `carat NUMERIC(8,3)`, `color?`, `clarity?`, `cutGrade?`, `labStatus?`, `quantity INT` | The stone composition the engine sums in §5.2 step 3. |
| `price_calculation` | `runId`, `masterVariantId`, `pricingProfileId`, `profileVersion`, `engineVersion`, `roundingRuleId`, `priceEndingRuleId`, `asOf`, `snapshotId`, `costBasisSize NUMERIC(6,2)?`, `landedCostMinorUnits BigInt`, `computedPriceMinorUnits BigInt`, `currency CHAR(3)`, `status` enum(`computed`,`failed`), `failureReason?` | **Unique `(runId, masterVariantId)`** — this is what makes a re-run of the same job idempotent. **Append-only (DB trigger).** |
| `price_sync_intent` | `masterVariantId`, `priceCalculationId`, `decision` enum(`auto_apply`,`needs_approval`), `status` enum(`pending_approval`,`approved`,`rejected`,`syncing`,`synced`,`failed`,`superseded`), `previousPriceMinorUnits BigInt?`, `deltaBps INT?`, `decidedBy?`, `decidedAt?`, `reason?`, `syncedAt?`, `shopifyVariantGid?`, `attemptCount INT` | **Mutable.** Partial unique index: at most **one non-terminal** intent per `masterVariantId` (`status NOT IN ('synced','rejected','failed','superseded')`). |

`master_variant.lastSyncedPriceCalculationId` (nullable FK) is the compare-and-set anchor for the sync (§9.4).

`price_calculation` is immutable while `price_sync_intent` is mutable **by deliberate design**. `docs/ARCHITECTURE-MVP1.md` §4 describes a single `price_calculation` row carrying `approved-by` and `synced-at`; that is internally inconsistent with the immutability the same section requires of pricing evidence. **Architect ruling (recorded here, amending §4 of the architecture document): split the immutable calculation from the mutable review/sync state.** This is a structural refinement inside an architecture document the architect owns; it changes no business rule and needs no owner decision.

---

## 8. Money-module and guard changes (F-1, F-9, F-10, F-16)

Confirmed against the tree at `main` before writing this spec: **`app/.eslintrc.cjs` still exists** (ESLint 8, `.eslintrc` format, not flat config), and **both guards still run in CI** — `.github/workflows/ci.yml` runs `npm run lint` and `npm run check:money-safety` on every push and PR. F-1's D13 caveat is therefore discharged: the rule at `.eslintrc.cjs:30-38` and the scan at `app/scripts/check-money-safety.mjs:16` are the two artefacts to fix, and no file move is needed.

### 8.1 F-1 — money-safety guard (fix BEFORE any pricing code lands)

Record honestly what each mechanism actually does. Criterion 6's first clause ("no float arithmetic") is satisfied by **`Money`'s bigint type boundary and decimal.js**, not by the scan — TypeScript refuses to mix `bigint` and `number` under an arithmetic operator, which is a compile-time guarantee a regex cannot provide. The scan's job is the *lexical* hazards that slip past the type boundary. Fix it to do that job properly.

**Two tiers.**

*Tier 1, repository-wide* — add to the existing `Math.(round|floor|ceil)` pattern: `Math.trunc(`, computed/aliased access to `Math` (`Math[`, `= Math.round`), `.toFixed(`, `parseFloat(`, `~~`, `>> 0`, `| 0`.

*Tier 2, money-adjacent paths only* (`app/app/domain/money/**`, `app/app/domain/pricing/**`, `app/app/jobs/pricing/**`, and any repository whose name matches `price|cost|metal|stone`) — additionally ban `.toNumber(` and `Number(`.

Also required:

- **Stop skipping `*.test.ts`** (`check-money-safety.mjs:31`). A test that rounds with `toFixed` is a test that can validate a broken implementation.
- **Add a structured allow-list**: `{ path, pattern, reason }` entries, printed in the scan's output. Seed it with exactly one entry — `app/app/domain/money/rounding.ts` for `.toFixed(`, reason: *"decimal.js's own exact `toFixed`, not `Number.prototype.toFixed`"*. Any new entry is an architect-reviewed change.
- **Fix the ESLint selector's blind spot**: `CallExpression[callee.object.name='Math']` does not match computed member access. Add a second selector on `MemberExpression[object.name='Math']`, which catches `Math["round"](x)` and `const r = Math.round` alike.
- **Add a type-level guard** for the engine's public surface: an `@ts-expect-error` test asserting that `BuyNowPricingInputs` and `BuyNowPriceResult` reject a JS `number` where a decimal quantity is expected. This is the part of "no float arithmetic" a lexical scan structurally cannot reach.
- **Document the division of labour** in a comment at the top of `check-money-safety.mjs`: what the type boundary guarantees, what the scan catches, and what neither catches.

### 8.2 F-9 — money tests

`multiplyByDecimal` is the method the engine uses for every margin and percentage application and currently has no test at all. Required cases: factor `1`; factor `0`; an exact `.5` tie rounding away from zero (`2.5 → 3`); the same tie on a **negative** amount (`−2.5 → −3`); a repeating decimal (`× 1/3`); a factor supplied as a string vs as a `MoneyDecimal`; and an amount **above 2^53** proving no float path exists. Also required, per F-9: `negate()` including zero and a negative; `sumMoney`'s happy path, its empty-array case, and its currency-mismatch throw; `fromDecimalMajorUnits` with `minorUnitsPerMajorUnit` of `1` (JPY-shaped) and `1000` (3-decimal-shaped); and `allocate` with a **zero weight among non-zero weights**, asserting the zero-weight part receives exactly `0` (pinning the proof rather than leaving it unwritten). The new `fromDecimalMinorUnits` gets the same tie/negative/large-value treatment.

### 8.3 F-10 — evidence payload contract

Document on `app/app/domain/evidence/snapshot.ts`: *any decimal quantity in an evidence payload is a `Money` (serialising to `MoneyJSON`) or a decimal **string** — never a JS `number`. Only counts, indices and enumerated integers may be JSON numbers.* Slice 1 is the first real instance and must honour it (§5.6). Enforced by a test that walks the produced pricing snapshot payload and asserts no `typeof === "number"` outside a named allow-list of count/index keys.

### 8.4 F-16 — schema convention

The commented block in §7.1, plus a real demonstration in `price_calculation`, plus a repository-edge conversion to `Money`, plus a test that `JSON.stringify` of a price-calculation DTO does not throw.

---

## 9. The recalculation, review and sync job

### 9.1 Trigger

`POST /internal/jobs/price-recalculation`, a **resource route** (no default export, per slice 0's convention in `app/app/routes/webhooks.*.tsx`), authenticated by `CRON_SECRET` from a request header, compared with `crypto.timingSafeEqual`. Reject with 401 before reading the body. Invoked by the platform scheduler (R21) — no in-process timer. Daily by default; twice-daily is a scheduler configuration change, not a code change (R7).

Because it is a resource route it is exempt from React Router 7's `throwIfPotentialCSRFAttack` guard (F-23 / architecture §2.1 R-1), and a cron invocation sends no `Origin` header in any case. **Stating this explicitly is the point** — the route must not gain a default export later without re-reading F-23.

### 9.2 Run

For each active `master_variant` with `status = active`:

1. Skip if excluded. Exclusions come from `OpenCampaignExclusionSource.excludedMasterVariantIds(asOf)` — an interface defined in `app/app/jobs/pricing/ports.ts`. Slice 1 ships `LuxuryStealExclusionSource` (reads `master_product.isLuxurySteal`) and `NoOpOpenCampaignExclusionSource`, which returns empty and carries a comment naming slice 6 as its implementer. Skipped variants are recorded with a reason, not silently dropped (R17).
2. Resolve inputs as of the run timestamp, in `app/app/jobs/pricing/resolveInputs.server.ts` — the single composition module of §4.0, and the only place that touches both a repository and the engine. A missing required input fails **that variant only** (§4.5).
3. For a banded product, run §5.7; otherwise run §5.2–§5.5 at the variant's own weight.
4. Write the `snapshot` (reusing by content hash) and the `price_calculation` row.
5. Compute the sync decision (§9.3) and upsert the `price_sync_intent`.

A failure in one variant never aborts the run. The run summary (counts of computed, skipped, failed) is logged as a business event — **no cost, margin or price values in the log** (R14).

### 9.3 The sync decision (pure)

```ts
decideSync({ newPrice, lastSyncedPrice, toleranceBps }): "auto_apply" | "needs_approval"
```

- No `lastSyncedPrice` (first-ever price for the variant) → **`needs_approval`**, always. A brand-new price must never auto-publish.
- `|newPrice − lastSyncedPrice| × 10000 / lastSyncedPrice ≤ toleranceBps` → `auto_apply`. Computed in `MoneyDecimal`, compared exactly; the boundary is inclusive.
- Otherwise → `needs_approval`. Increases and decreases are treated symmetrically; a large *decrease* is as much a data-entry-error signal as a large increase.
- `newPrice == lastSyncedPrice` → `auto_apply`, and the intent is created in terminal status `synced` with no work to do (a no-change run must not fill the approval queue).

### 9.4 Idempotency

Price sync is **not** routed through `executeIdempotent`. That wrapper exists for outbound *money movement* (`docs/ARCHITECTURE-MVP1.md` §6.7) and carries three open defects gated at slice 4 (F-5, F-20, F-21, F-22). Slice 1 must not become its first production caller. Setting a variant price is naturally idempotent — writing the same price twice is indistinguishable from writing it once — so idempotency here is structural:

- Unique `(runId, masterVariantId)` on `price_calculation`: re-running a run id is a no-op.
- Partial unique index guaranteeing at most one non-terminal `price_sync_intent` per variant: a second run supersedes the prior pending intent (`status = superseded`, audited) rather than creating a duplicate.
- `master_variant.lastSyncedPriceCalculationId` is the compare-and-set anchor: slice 2's sync executes only if the intent's `priceCalculationId` is still the newest computed calculation for that variant.

### 9.5 Approval surface in slice 1

No UI. A CLI script `app/scripts/price-review.mjs` with exactly three verbs:

- `list` — pending intents with variant, old price, new price, delta bps.
- `approve --intent <id> --actor <staff-id> [--reason <text>]`
- `reject --intent <id> --actor <staff-id> --reason <text>`

Each writes an `audit_event`. `--actor` is mandatory; there is no anonymous approval. The script is explicitly a stopgap for slice 1 operability and is superseded by the admin UI; say so in its header comment.

A fourth verb, `verify --calculation <id>`, runs §5.6's reproducibility check and prints the comparison.

### 9.6 What waits for slice 2 — and the boundary that keeps it there

`app/app/jobs/pricing/ports.ts` defines:

```ts
interface ShopifyPriceSyncPort {
  applyVariantPrice(input: {
    shopifyVariantGid: string;
    price: Money;
    priceCalculationId: string;
  }): Promise<{ appliedAt: Date }>;
}
```

Slice 1 ships `RecordingPriceSyncPort` (tests and local dev only) and `UnimplementedPriceSyncPort` (production wiring; throws `PriceSyncNotImplementedError`). Slice 2 implements the real adapter over Admin GraphQL `productVariantsBulkUpdate`, having installed `@shopify/shopify-app-react-router@2.1.0`.

**Scope fence.** Slice 1 does not add `@shopify/*` to `package.json`, does not add an Admin API client, does not add OAuth or session storage, does not add an admin route, and does not read `SHOPIFY_API_KEY`. If an implementer finds themselves needing any of those, the answer is that the task belongs to slice 2 — stop and escalate to the architect rather than pulling it forward.

---

## 10. Acceptance criteria

Numbered, testable. 1–8 are the inherited slice 0 findings and must be satisfied **before pricing code lands**.

**Inherited findings (F-1, F-9, F-10, F-16)**

1. The money-safety scan flags `Math.trunc(`, computed/aliased `Math` access, `.toFixed(`, `parseFloat(`, `~~`, `>> 0` and `| 0`, and within money-adjacent paths also `.toNumber(` and `Number(` — demonstrated by a fixture file per pattern that the scan rejects. (F-1)
2. The scan no longer skips `*.test.ts`, and its allow-list contains exactly one entry: `app/app/domain/money/rounding.ts` for `.toFixed(`, with a stated reason. Running the scan against the current tree passes. (F-1)
3. The ESLint rule catches `Math["round"](x)` and `const r = Math.round`, proven by a lint run over a fixture. Both `npm run lint` and `npm run check:money-safety` still run in CI. (F-1)
4. A type-level test asserts the engine's input and result types reject a JS `number` where a decimal quantity belongs; the comment at the top of `check-money-safety.mjs` states what the type boundary guarantees versus what the scan catches. (F-1)
5. `multiplyByDecimal` has tests for factor 1, factor 0, a positive exact tie, a **negative** exact tie, a repeating decimal, string vs `MoneyDecimal` factors, and an amount above 2^53. (F-9)
6. `negate()` (including zero), `sumMoney` (happy path, empty array, currency mismatch), `fromDecimalMajorUnits` at `minorUnitsPerMajorUnit` 1 and 1000, and `allocate` with a zero weight among non-zero weights are all tested; the zero-weight part receives exactly zero. (F-9)
7. `app/app/domain/evidence/snapshot.ts` documents the no-bare-`number` contract, and a test walks the pricing snapshot payload asserting every decimal quantity is a `MoneyJSON` or a decimal string. (F-10)
8. `schema.prisma` carries the commented money-column example including the `JSON.stringify`/`bigint` hazard, and `price_calculation` demonstrates `BIGINT` minor units + `CHAR(3)`; `JSON.stringify` of a price-calculation DTO does not throw. (F-16)

**Weight and bands**

9. `calculateWeightGrams` matches R8 at the base size, above it, below it, at a half size and at a quarter size, to 4 decimal places, with no JS `number` in the path.
10. An exact finished-weight override takes precedence over the linear model; a size outside the allowed range, or off the configured increment, throws `InvalidSizeError`; a computed weight ≤ 0 throws `InvalidWeightError`.
11. A band's price equals the maximum price over **every allowed size in the band**, and the recorded `cost_basis_size` is the size that attained it — including a case where an override makes an **interior** size the most expensive, which a `band.max` shortcut would get wrong.
12. Bands are per-product configuration seeded with the 2–6 / 6.5–8 / 8.5–11 defaults; a band set with a gap or an overlap against the product's allowed range is rejected at write time.

**Engine**

13. The §5.8 worked example reproduces exactly, including each named intermediate and the final `$1,368.33`.
14. Changing the stone **shape** while holding carat and everything else constant changes the price, and a shape with no cost row raises `MissingCostInputError` rather than pricing the stone at zero. (R4)
15. An **absent** required cost component raises `MissingCostInputError` and fails only that variant; a component present with value `0` computes normally. (§4.5)
16. A `revenue_side` percentage component enters the denominator and a `cost_side` one enters the cost: the same nominal rate configured each way yields different, individually-verified prices, and `1 − m − r ≤ 0` raises `UnreachableMarginError`.
17. When the margin-derived price is below the minimum-dollar-profit price, the minimum-dollar-profit price wins; when a variant floor exceeds both, the floor wins.
18. After rounding, a price violating `min_gross_margin_rate`, `min_dollar_profit` or the variant floor is bumped one minor unit at a time until it passes; the loop is bounded and raises `MarginFloorUnreachableError` at the bound. A price that satisfies the floors is **not** bumped merely for falling a fraction below the *target*.
19. `computeBuyNowPrice(snapshot.payload.inputs)` reproduces a stored result exactly when `engineVersion` matches; when it does not match, the verifier reports a difference instead of asserting equality.
20. Rounding happens exactly once per price. The stored breakdown components are rounded projections and are never inputs to a later step — demonstrated by a case whose result differs if the metal cost is rounded before the margin is applied.
21. A currency mismatch anywhere in the inputs throws rather than producing a price.

**Persistence and job**

22. `price_calculation` rejects `UPDATE` and `DELETE` at the database level; the caveat that enforcement depends on the slice-2 role split (F-7) is recorded in the migration.
23. Re-running the job with the same `runId` creates no duplicate `price_calculation` rows and no duplicate intents.
24. At most one non-terminal `price_sync_intent` exists per `master_variant`; a newer run marks the prior pending intent `superseded` with an audit event.
25. The decision table holds: no prior price → `needs_approval`; within tolerance → `auto_apply`; outside tolerance in **either** direction → `needs_approval`; unchanged price → terminal `synced` with no queue entry.
26. Variants excluded by `LuxuryStealExclusionSource` or `OpenCampaignExclusionSource` are recorded as skipped with a reason and produce no calculation and no intent.
27. `POST /internal/jobs/price-recalculation` returns 401 for a missing, wrong or malformed `CRON_SECRET`, using a timing-safe comparison, and rejects before reading the body; it is a resource route with no default export.
28. Approval and rejection require an explicit actor, write an `audit_event`, and are reflected in the intent's status; there is no code path that approves without an actor.
29. Slice 1 never calls the Shopify Admin API: `package.json` contains no `@shopify/*` dependency, and the production-wired port throws `PriceSyncNotImplementedError`.

**Security and privacy**

30. No cost, margin, supplier, component-breakdown or price value appears in any log line; the run summary logs counts and references only.
31. No route added by this slice is reachable from the storefront or from an unauthenticated caller.
32. Prisma `Decimal` values never pass through `.toNumber()`; the scan enforces it on money-adjacent paths.

**Pipeline**

33. `npm run typecheck`, `lint`, `check:money-safety`, unit tests, `prisma migrate deploy`, integration tests and `build` all pass in CI on a clean checkout. Any claim that they pass must be accompanied by the actual output.

**Layering, decomposition and seams**

34. No file under `app/app/domain/pricing/**` imports `app/app/db/**`, `@prisma/client`, any `*.server.ts` module, `node:*` or `process.env`, and none calls `Date.now()` or `new Date()`. Asserted by a test that reads every file in the directory and inspects its imports — not left to convention. (§4.0)
35. The §5.0 functions exist in the named files with the named responsibilities, and the split is real: `evaluateFloors` is tested without `enforceFloors`, `selectBandPrice` is tested against a stub `priceAtSize` with no engine and no database, and `orderCostSideComponents` is tested as a function in its own right. `engine.ts` contains no money or rate arithmetic of its own. (§5.0)
36. Two `metal_price` rows differing only in `source` resolve identically — the later `effective_from` wins regardless of source — and `source` appears in no selection predicate and nowhere under `app/app/domain/pricing/**`. (§4.7 Seam A)
37. A `stone_cost` row with a non-null `supplier_ref` is never selected by slice 1's supplier-agnostic lookup, and every effective-dated resolver goes through the one shared `selectMostSpecific` helper — its ambiguous-tie throw is tested once, at the helper, not re-tested per table. (§4.7 Seam B)

---

## 11. Test plan

**Unit (pure, no database)** — the bulk of the value, per `docs/ARCHITECTURE-MVP1.md` §9.

| Area | Cases |
|---|---|
| Money (F-9) | Criteria 5 and 6 in full. |
| `fromDecimalMinorUnits` | Exact ties positive and negative; values above 2^53; a repeating decimal; an unknown rounding rule id throws. |
| Weight | Base/above/below/half/quarter size; override precedence; out-of-range; off-increment; ≤ 0 weight; `size_axis = length_inches` and `none`. |
| Bands | Monotonic case; override making an interior size heaviest; single-size band; empty band; tie broken to the lowest size. |
| Engine | The §5.8 worked example with every intermediate asserted; shape sensitivity; missing vs explicit-zero input; cost-side vs revenue-side; `1 − m − r ≤ 0`; min-profit dominance; variant floor dominance; post-round bump and its bound; no-bump-below-target; single-rounding proof; currency mismatch. |
| Cost resolution | Effective dating picks the latest row at or before `asOf` and ignores future rows; no applicable row throws; stone specificity ordering including the ambiguous-tie throw; overlapping carat bands rejected. |
| Sync decision | Criterion 25's table, plus exactly-at-tolerance (inclusive) and one bp over. |
| Evidence shape (F-10) | Payload walk asserting no bare `number` for a decimal quantity. |
| Reproducibility | Same inputs → same result and same content hash; a one-character change in any input changes the hash. |

**Integration (Vitest + real Postgres)**

- Migration applies cleanly to an empty database and matches what Prisma would generate from `schema.prisma` (the same drift check slice 0's deferred item 2 required).
- `price_calculation` append-only trigger blocks `UPDATE`, `DELETE` and `TRUNCATE`, with error discrimination (not a bare `.toThrow()` — see F-15).
- `BIGINT` round-trip: write, read, `Money` equality; DTO `JSON.stringify` does not throw.
- `NUMERIC(18,6)` round-trip: `48.250000` and a value exercising the full scale survive write→read→`MoneyDecimal` as an exact string.
- Job idempotency: same `runId` twice → one calculation row per variant, one intent.
- Intent uniqueness: a concurrent second run cannot create two non-terminal intents (unique-constraint enforced, not read-then-write).
- Snapshot reuse: two runs with identical inputs reference the same `snapshot` row.
- Cron route: valid secret → 200/202; wrong, absent and malformed secret → 401; wrong HTTP method → 405.
- Audit events written for approve, reject, supersede and override.
- End-to-end: seed → run job → intent pending → CLI approve → intent approved → `RecordingPriceSyncPort` receives exactly one call with the exact `Money`.

**Specific money edge cases that must be covered (called out so they are not skipped)**

Exact `.5` ties positive and negative; amounts above `2^53`; a repeating decimal through the margin solve; a zero-cost component; a zero weight rejected; `1 − m − r` exactly 0 and slightly negative; a price of exactly one minor unit; the tolerance boundary exactly at `toleranceBps`; allocation with a zero weight; currency mismatch on every arithmetic entry point.

**Fixtures.** Seed data (`prisma/seed.ts` extension) covering: three metals × two purities, one lab diamond shape pair (round vs princess at the same carat, different cost — proving R4), melee accent stones, a full labour set, cost-side and revenue-side overhead, and one Buy Now profile version. No real supplier data; representative placeholder values only, clearly marked as such.

---

## 12. Contracts this slice creates for later slices

To be folded into `docs/specs/SLICE-0-FINDINGS.md` as new register entries when this slice lands, so they are not lost:

- **C-S1 (gate: slice 6).** Slice 6 must implement `OpenCampaignExclusionSource` so variants in an open campaign are excluded from Buy Now recalculation (R17). Until then the no-op implementation is correct because no campaign can exist.
- **C-S2 (gate: slice 2).** Slice 2 must implement `ShopifyPriceSyncPort` over `productVariantsBulkUpdate`, must honour the `lastSyncedPriceCalculationId` compare-and-set, and must not reintroduce a JS `number` price anywhere between `Money` and the GraphQL variable.
- **C-S3 (gate: slice 6).** A Group Buy `campaign_snapshot` must record `engineVersion`, `pricingProfileVersion` and `roundingRuleId` alongside the frozen prices, or a frozen price ceases to be reproducible — which defeats the purpose of freezing it (`CLAUDE.md` #7).
- **C-S4 (gate: slices 4 and 8).** **Refunds, restocking calculations and merchandise credit are computed from the amount the customer actually paid — the Shopify order line and its purchase snapshot — never from `price_calculation`.** `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §4 speaks of "the eligible merchandise amount", which is a historical fact about a transaction, not a current computation. A recalculated price must never reach a refund path.
- **C-S5 (gate: any slice adding a price-bearing route).** No cost, margin, supplier or breakdown field may be exposed via metafield, Liquid, App Proxy JSON or log (R14).

---

## 13. Open decisions

### Owner decisions requested (neither blocks implementation)

**D14 — Buy Now pricing profile values.** The engine needs, as configuration: target gross margin %, minimum gross margin %, minimum dollar profit, and the auto-apply tolerance in basis points. These are business numbers, not engineering defaults, and I will not invent them. Slice 1 seeds clearly-labelled placeholder values and the CLI refuses to approve an intent computed from a profile still marked `placeholder`. **Blocks:** approving or syncing any real price. **Does not block:** building, testing or reviewing the engine.

**D15 — recalculation cadence.** R7 asks for at least daily, targeting twice-daily. With D2 resolved as staff-entered metal prices, a second daily run only re-reads whatever staff last entered, so daily is the honest default and twice-daily is a scheduler setting. Slice 1 ships a daily schedule; confirm or change. **Blocks:** nothing.

### Already-open decisions this slice is specified around

**D9 — payment methods to encourage (open).** Seamed at one function per §4.6. Does not block; do not build the method-mix model in anticipation.

**D2 — automated metal-price feed (resolved as staff-entered).** Seamed per §4.7 Seam A. Does not block.

**D1 — development store and credentials (open).** Irrelevant here — nothing in slice 1 touches a live store. Blocks slice 2's port implementation only.

### Locked-policy conflicts found

**None affecting this slice.** Checked `README.md` §Buy Now Pricing, §Cost Component Libraries, §Pricing Profiles, §Variant Weight / Ring-Size Model, §Shipping, §Luxury Steals against `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md`, `docs/LUXURY-STEALS.md` and `CLAUDE.md`. C1 (`docs/ARCHITECTURE-MVP1.md` §11) affects slice 10 only.

Two near-conflicts, resolved here rather than escalated because neither changes a business rule:

- **`docs/ARCHITECTURE-MVP1.md` §4 makes `price_calculation` immutable yet gives it `approved-by` and `synced-at`.** Internally inconsistent; resolved by the split ruling recorded in §7.
- **Insurance at "full order value" (`README.md` §Shipping) is a percentage of price, not of cost**, which is circular. Resolved by the `cost_side` / `revenue_side` classification and the closed-form solve in §5.3 — a modelling decision, not a policy change. R12 is satisfied either way.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| An implementer solves the payment/insurance circularity with an iterative loop, producing a price that depends on iteration count | §5.3 gives the closed form; criterion 16 tests it; architect review of the engine is mandatory |
| Double rounding — a rounded intermediate fed back into the calculation | §4.1 rule 3, §5.4, and criterion 20, which requires a case whose result *differs* under double rounding |
| Band priced at `band.max` instead of the true maximum, selling an override-heavy interior size below floor | §5.7 forbids the shortcut; criterion 11 tests the interior-maximum case explicitly |
| A missing cost input silently prices as zero | §4.5; criterion 15; the absent-vs-explicit-zero distinction is the whole point |
| Prisma `Decimal.toNumber()` reintroducing float in the one place the `Money` type boundary cannot see | Banned by the strengthened scan (criteria 1, 32); called out in the schema comment |
| Scope leaking into slice 2 via "we need the Admin client to finish the sync" | §9.6 scope fence; criterion 29 checks `package.json` |
| Slice 1 becoming the first production caller of `executeIdempotent`, inheriting F-5/F-20/F-21 before slice 4 fixes them | §9.4 routes price sync around it entirely; structural idempotency instead |
| `price_calculation` append-only treated as enforced when F-7's role split is still outstanding | Recorded in the migration and in §6; F-7 remains a slice-2 deploy task |
| Test authors inventing expected values instead of deriving them | §5.8 supplies ground truth with every intermediate; the engine tests are written against it |
| A later "cleanup" changes a rounding rule id's behaviour, invalidating historical calculations | The registry's existing rule stands and is restated in §5.4; ids are append-only |
| The layering collapses — the engine gains a repository import, or the solve, floors and band sweep all land in one large function in `engine.ts` | §4.0's one-way dependency rule and §5.0's named decomposition; criteria 34 and 35 are automated checks, not advisory notes |
| A metal-price feed or a supplier override arrives and the engine is rewritten to accommodate it | §4.7 names exactly what changes and what may not; criteria 36 and 37 keep `source` and `supplier_ref` inert so the seam stays a data-and-one-function change |

---

## 15. Agent ownership and sequencing

Serial where files overlap. Slices 0 and 1 are serial overall per `docs/ARCHITECTURE-MVP1.md` §10, so **no other slice runs concurrently with this one**.

| # | Task | Owner (model) | Files | Depends on |
|---|---|---|---|---|
| T1 | F-1 guard hardening (scan tiers, allow-list, ESLint selector, comment) | Backend & Pricing (`sonnet`) | `app/scripts/check-money-safety.mjs`, `app/.eslintrc.cjs` | — |
| T2 | `Money.fromDecimalMinorUnits`; F-10 doc on `snapshot.ts`; F-16 schema comment | Backend & Pricing (`sonnet`) | `app/app/domain/money/money.ts`, `app/app/domain/evidence/snapshot.ts`, `app/prisma/schema.prisma` (comment only) | T1 |
| T3 | F-9 money tests + `fromDecimalMinorUnits` tests | Test Engineer (`haiku`) | `app/app/domain/money/money.test.ts` | T2 |
| T4 | Prisma models + migration + append-only trigger extension + seed data | Backend & Pricing (`sonnet`) | `app/prisma/**` | T2 |
| T5 | Cost-library repositories (L2) and effective-dated resolution, including the one shared `selectMostSpecific` helper (§4.7 Seam B) | Backend & Pricing (`sonnet`) | `app/app/db/repositories/*` (new files only) | T4 |
| T6 | Pure pricing domain (L3–L5) decomposed per §5.0: `weight.ts`, `cost.ts`, `solve.ts`, `bands.ts`, `priceEnding.ts`, `version.ts`, `types.ts`, `errors.ts`, `engine.ts` | Backend & Pricing (`sonnet`) | `app/app/domain/pricing/**` | T2 |
| T7 | Engine, weight, cost, solve and band unit tests against §5.8, plus the §4.0 import-direction test (criterion 34) | Test Engineer (`haiku`) | `app/app/domain/pricing/*.test.ts` | T6 |
| T8 | Job orchestration, the `resolveInputs.server.ts` composition module (§4.0), ports (including `MetalPriceIngestionSource`), sync decision, cron route, CLI | Backend & Pricing (`sonnet`) | `app/app/jobs/pricing/**`, `app/app/routes/internal.jobs.price-recalculation.tsx`, `app/scripts/price-review.mjs` | T5, T6 |
| T9 | Integration tests | Test Engineer (`haiku`) | `app/tests/integration/pricing/**` | T8 |
| T10 | QA and security review (`/security-review`, `/review-code`) | QA & Security Reviewer (`sonnet`) | review only | T9 |
| T11 | Architect review of the engine, rounding/versioning, guard, and the slice-2 scope fence; final acceptance | Principal Architect (`opus`) | review only | T10 |

T3 and T7 (Test Engineer) must not run while T2/T6 (Backend) are editing the same files — sequence as shown. T1 lands first, before any pricing code, per the F-1 gate.

Every delegated task closes with `/handoff`: files changed, behaviour, tests actually run with output, assumptions, unresolved issues, policy documents used, and items needing architect review. Implementation tasks use `/backend-feature`; test tasks use `/test-business-rules`. `/ship-feature` is the final gate.

---

## 16. Architect approval

This specification is **approved for implementation** as written, subject to the two conditions below.

1. **T1 (F-1 guard hardening) lands before any pricing code.** The whole reason F-1 is gated here is that slice 1 is the first code whose arithmetic becomes a price; hardening the guard afterwards inspects the code with the guard that let it through.
2. **Architect review is required, not optional, on:** the engine's closed-form solve and floor handling, the rounding/versioning design, the F-1 guard changes, the `price_calculation` / `price_sync_intent` split, the slice-2 scope fence, and — added by the 2026-09-16 amendment — the §4.0 layer boundaries and the §5.0 decomposition as actually implemented. High-risk diffs are inspected with test evidence before acceptance; "done" without output is not accepted.

D14 and D15 are requested from the owner. Neither blocks the start of implementation; D14 blocks approving or syncing a real price, which is slice 2 work regardless.
