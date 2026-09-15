# CaratForUs MVP1 Architecture — PROPOSED

## Status
**APPROVED BY OWNER 2026-09-13. Phase 1 (slices 0 → 1 → 2) authorized.**

Owner decisions resolved at approval: **D2 = staff-entered metal prices** (adapter-backed; automated feed is a post-launch fast-follow). **D3/D4 = Fly.io app + managed Postgres, Cloudflare R2 private storage, Resend transactional email.**

Resolved 2026-09-14, arising from the slice 0 acceptance review: **D12 = hybrid adoption of `@shopify/shopify-app-remix`** (OAuth, session storage and App Bridge from the library; webhook receipt stays ours). See §2.1 — it records why the library's `authenticate.webhook` is deliberately not used.

Still open and tracked in §12: **D1** (Shopify development store + API credentials), **D5–D11**. D7 and D10 are reserved to the owner by `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §14 and must be resolved before slice 4 is accepted.

Author: Principal Architect / Tech Lead
Date: 2026-09-13
Repository state at time of writing: requirements-only (29 tracked files, all Markdown; no application code, no `package.json`, no Shopify theme, no Shopify app).

This document is the output of `/plan-architecture` plus the `/architecture-review` verdict in §14. It must be approved by the owner before any broad scaffolding begins.

---

## 1. Architecture Summary

One Shopify store, one Shopify theme, one small custom application, one Postgres database.

```
                 Customer browser
                        |
        +---------------+----------------+
        |                                |
  Shopify Online Store 2.0 theme    Shopify Checkout
  (Liquid, product pages,           (native, unmodified)
   Group Buy UI, Luxury Steals,
   forms rendered via App Proxy)
        |                                |
        | fetch /apps/carat/*            | webhooks (HMAC verified)
        v                                v
  +-------------------------------------------------+
  |        CaratForUs app (single Node service)     |
  |  - App Proxy routes (customer forms + JSON)     |
  |  - Embedded admin UI (staff, in Shopify Admin)  |
  |  - Webhook handlers (idempotent)                |
  |  - Scheduled jobs (price recalc, sync)          |
  |  - Pricing / Group Buy / RMA / warranty engines |
  +-------------------------------------------------+
        |                    |                 |
     Postgres            Object storage     Email
   (system of record   (customer uploads,   (transactional
    for custom data)    private bucket)      non-order mail)
```

No headless storefront. No microservices. No message queue. No separate customer portal. No second checkout.

---

## 2. Recommended Stack

| Layer | Recommendation | Why |
|---|---|---|
| Commerce platform | Shopify (Basic or Grow) | Cart, checkout, payments, accounts, orders, inventory, taxes, order emails — all commodity. Non-negotiable per README. |
| Storefront | Shopify Online Store 2.0 theme (Dawn-based), Liquid + light vanilla JS | Cheapest, fastest, SEO-native, no build pipeline to maintain. |
| Custom app | Single Node 20 + TypeScript service, Remix — **hybrid** adoption of `@shopify/shopify-app-remix`, see §2.1 | One deployable. Remix gives us server routes and the embedded-admin scaffold; the Shopify library supplies OAuth, session storage and App Bridge. Webhook receipt is deliberately **ours**, not the library's — §2.1. |
| Admin UI | Embedded in Shopify Admin via App Bridge + Polaris | Staff already live in Shopify Admin. No separate login, no separate auth system to secure. |
| Customer forms | Shopify **App Proxy** (`/apps/carat/*`) | Forms render on the store's own domain, inherit theme styling, and arrive signed with the logged-in customer ID. Avoids a second domain, second session system, and CORS. |
| Database | Managed Postgres | Money system: needs durability, transactions, concurrent webhook writes, PITR backups, unique constraints for idempotency. SQLite is rejected for those reasons. |
| ORM / migrations | Prisma | Typed access + versioned migrations; low ceremony. |
| Money arithmetic | Integer minor units (`BIGINT` cents) for all stored/charged amounts; `decimal.js` at fixed scale for intermediate cost math | CLAUDE.md #6. Metal-cost math (price/gram × grams) needs decimal precision before rounding to cents under an explicit, versioned rounding rule. |
| File uploads | S3-compatible private object storage (Cloudflare R2 recommended) + presigned upload, short-lived signed reads | Warranty photos, CAD/PDF quote evidence, custom-design inspiration. Must be private (PII + evidence). Shopify Files is public-by-URL and unsuitable. |
| Transactional email | One provider (Resend recommended) | Order emails stay native Shopify. Only Group Buy milestones, RMA/warranty/quote status, and magic links go through this. |
| Hosting | Single-instance container host (Fly.io or Render) | ~$7–25/mo, one region, simple logs, built-in cron. |
| Tests | Vitest (unit + integration), Playwright smoke only | Business rules are pure functions — that is where nearly all test value is. |
| CI | GitHub Actions: typecheck, lint, unit, integration, build | Cheap, sufficient. |

### 2.1 Shopify app library: hybrid adoption (D12)

**APPROVED BY OWNER 2026-09-14**, on the architect's recommendation arising from the slice 0 acceptance review.

This document originally specified "Remix via the official Shopify app template" without qualification, and `docs/specs/SLICE-0-FOUNDATION.md` §0.2 repeated it. Slice 0 shipped plain Remix with no `@shopify/*` dependency at all. That was the right call for slice 0 — the slice needed no OAuth, no admin UI and no live store, so the template's dependencies would have been dead weight — but it left an unresolved question for slice 2, which needs all three. The decision below closes it.

**Adopted from `@shopify/shopify-app-remix`:**
- Embedded-admin **OAuth** / app install flow.
- **Session storage** (Prisma-backed). The `session` model lands in the slice 2 migration; it is not part of slice 0's six tables.
- **App Bridge** (and Polaris for admin UI).

**Deliberately NOT adopted: the library's webhook handling (`authenticate.webhook`).** Inbound webhook receipt stays with our own `receiveShopifyWebhook` (`app/app/shopify/webhooks/receive.server.ts`) and `claimWebhookEventForProcessing` (`app/app/db/repositories/webhookEventRepository.server.ts`).

**Why — read this before "fixing" the divergence.** A future reader will notice that we verify HMACs ourselves while importing a library that also verifies HMACs, and will be tempted to delete ours as duplication. It is not duplication. `authenticate.webhook` verifies the HMAC and parses the body; that is *all* it does. It has no delivery deduplication, no claim state machine, and no notion of a prior attempt having failed. Our receiver provides three properties the library does not, each of which exists because a specific failure mode would otherwise move money incorrectly:

1. **Deduplication on a UNIQUE constraint** over `webhook_event.shopify_event_id` (not a read-then-write check), so two concurrent deliveries of the same event cannot both be processed. Without this, a redelivered `orders/paid` can create a second `campaign_unit` and shift a Group Buy tier.
2. **Dedup keyed on successful processing, not row existence.** A replayed delivery whose prior attempt *failed* is reprocessed (`claimed_retry`), not swallowed. Swallowing it loses the event permanently, because Shopify's retry is the only redelivery we get.
3. **Stale-claim reclaim plus a 5xx (not 200) response for an ambiguous in-flight claim.** A 2xx permanently ends Shopify redelivery, so answering 200 for an unresolved event buries it. A crashed attempt is recovered after `DEFAULT_STALE_CLAIM_MS`; until then the delivery stays in Shopify's retry schedule and remains visible in its failed-delivery reporting.

Replacing our receiver with `authenticate.webhook` would silently discard all three. If a future slice wants to consolidate, the burden is on that slice to demonstrate the library has grown equivalents — not to assume the overlap is accidental.

**Boundary rule.** The library owns *authentication and session* concerns. It does not own *event processing* concerns. Admin and App Proxy routes may use the library's authenticate helpers freely; webhook routes go through `receiveShopifyWebhook`.

### Alternatives considered and rejected

- **Shopify Hydrogen / headless.** Rejected: multiplies build and hosting cost, loses native theme editor for the owner, and buys nothing MVP1 needs.
- **Everything in Shopify (metafields + Flow + off-the-shelf apps).** Rejected: cannot deliver the deterministic Group Buy refund ledger, immutable evidence versioning, tier freeze, or the RMA/warranty state machines. Also stacks recurring per-app SaaS fees on a low-margin business.
- **Separate services per domain (pricing svc, groupbuy svc, …).** Rejected: CLAUDE.md #4. One service, clear internal module boundaries.
- **SQLite/Turso.** Rejected for a system that moves money and must survive concurrent webhook delivery and provide point-in-time recovery.
- **Redis + BullMQ job queue.** Rejected for MVP1: webhook handlers are short, and the two recurring jobs are cron-shaped. Retries are handled by Shopify's own webhook retry plus our idempotency table.

---

## 3. Native Shopify vs Custom — Responsibility Matrix

| Capability | Owner | Notes |
|---|---|---|
| Product catalog, variants, media | **Shopify** | Variant = metal × ring-size band. |
| Cart, checkout, payments, taxes | **Shopify** | Never replaced. |
| Customer accounts, order history | **Shopify** | |
| Inventory, sold-out behavior, no overselling | **Shopify** | Luxury Steals relies on this directly ("continue selling when out of stock" must be OFF). |
| Order confirmation / shipping emails | **Shopify** | Policy text repeated in notification templates. |
| Discount codes and their exclusions | **Shopify** | Native collection-scoped discounts exclude Group Buy + Luxury Steals. |
| Shipping labels, tracking, fulfillment | **Shopify** + carrier | App stores signature/insurance flags and evidence references. |
| Refunds and store credit execution | **Shopify API**, orchestrated by app | App never touches card data. |
| Storefront presentation, badges, disclosures | **Theme (custom code, Shopify-native mechanism)** | |
| Cost component libraries + pricing engine | **Custom** | |
| Buy Now price recalculation + approval + sync | **Custom** | |
| Group Buy campaigns, freeze, tiers, qualifying units | **Custom** | |
| Group Buy progress/savings UI data | **Custom API** → theme | |
| Group Buy final price + refund ledger | **Custom** (executes via Shopify refunds) | |
| Luxury Steals Final Sale acknowledgment + evidence | **Custom** | Shopify has no record of this. |
| Buy Now RMA workflow, windows, remedies | **Custom** | |
| Warranty claim workflow | **Custom** | |
| Custom Jewelry intake, $49 deposit, approval evidence | **Custom** intake; **Shopify** for the deposit and final purchase | |
| Let Us Beat Your Quote intake, age calc, eligibility, fallback benefit | **Custom**; benefit issued as a **Shopify discount code** | Review stays manual. |
| Acknowledgment/policy versioning, snapshots, audit history | **Custom** | |
| Webhook idempotency and authenticity | **Custom** | |
| Staff admin for all of the above | **Custom**, embedded in Shopify Admin | |

### What this architecture will NOT build in MVP1
Customer project portal; voting; photo galleries/moderation; buyer map; referral/affiliate; SMS/push; gamification; direct-post social APIs; automated competitor price scraping; automated dispute-packet generation (records are retrievable; assembly is manual per locked policy); any second checkout.

---

## 4. Core Data Model

Append-only evidence tables are never UPDATEd. All money columns are `BIGINT` minor units plus an explicit `currency`.

**Pricing**
- `cost_component` — metal/stone/labor/packaging/shipping/insurance/warranty-reserve/payment rates, effective-dated, versioned.
- `metal_price` — price per gram by metal+purity, effective-dated, source (`manual` | feed), entered-by.
- `pricing_profile` — Group Buy / Buy Now / Custom / Wholesale / F&F: margin, minimum dollar profit, fee model, rounding rule. Versioned.
- `master_product` / `master_variant` — structured design definition, base weight, base ring size, weight-per-size, band definitions, stone specs, Shopify product/variant mapping.
- `price_calculation` — immutable result row: inputs hash, component breakdown, computed price, profile version, run id, approved-by, synced-at.

**Group Buy**
- `campaign` — status (Open→Closed→In Production→QC→Shipping→Completed), open/close timestamps, tier count (2–5).
- `campaign_snapshot` — **immutable** frozen cost inputs, assumptions, tier thresholds/percentages, and per-eligible-variant frozen base price. Written once at open. Content-hashed.
- `campaign_tier` — threshold units, percentage, computed per-variant price (from snapshot).
- `campaign_unit` — one row per qualifying unit, keyed to Shopify order + line item + unit index; `qualifies` boolean with reason; drives tier state.
- `refund_ledger` — one row per line item: price paid, final price, refund due, status, Shopify refund reference, attempt history, override + reason. Unique constraint prevents duplicate value.

**Evidence (append-only)**
- `policy_version` — slug, version, effective_from, full text, hash.
- `acknowledgment` — exact text, policy_version_id, timestamp, affirmative action label, customer/order/cart/campaign/submission refs, product/variant refs, source IP/user-agent where lawful.
- `snapshot` — typed immutable JSON blob + hash (product/config/media/spec/price/policy at transaction time).
- `audit_event` — actor, action, entity, before/after, reason, timestamp. Every value-moving or status-changing operation writes one.

**Workflows**
- `rma` — full field set from BUY-NOW-RETURNS §9, computed window state, remedy, deadlines, receipt, inspection, disposition.
- `warranty_claim` — full field set from WARRANTY-CLAIMS §2/§5, status enum from §8, authorization record, inbound tracking/insurance, inspection, remedy, local-jeweler records.
- `quote_submission` — LUBYQ §"Required Submission Data", submission type, quote date, computed age in calendar days, verification evidence, eligibility status, decision.
- `fallback_benefit` — issuance/expiry (90 days), discount code ref, single-use, redemption order, override. Unique per qualifying outcome.
- `custom_request` — intake, uploads, deposit reference, approval page version, approval acknowledgment.
- `shipment` — carrier/service/tracking/ship date/insured value/insurance ref/signature flag/delivery evidence/address-change history.

**Infrastructure**
- `webhook_event` — `shopify_event_id` UNIQUE, topic, raw payload, received/processed timestamps, error.
- `idempotency_key` — UNIQUE key for every outbound money operation (refund, credit, benefit issuance) with stored result.
- `upload` — storage key, content type, size, sha256, scanned/validated flag, owning entity.

---

## 5. Shopify Integration Points

**Webhooks** (HMAC verified against raw body, deduped on the `X-Shopify-Webhook-Id` delivery header — **corrected 2026-09-14**: this document and `docs/specs/SLICE-0-FOUNDATION.md` originally said `X-Shopify-Event-Id`, which Shopify does not document; `X-Shopify-Webhook-Id` is the header Shopify documents as stable across retries of the same event, which is the property dedup requires. Kept in one constant at `app/app/shopify/webhooks/headers.ts`):
`orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled`, `refunds/create`, `fulfillments/create`, `fulfillments/update`, `app/uninstalled`, and the three mandatory compliance topics (`customers/data_request`, `customers/redact`, `shop/redact`).

**Admin GraphQL API** (writes): `productVariantsBulkUpdate` (price sync, Group Buy tier price changes), `refundCreate` (Group Buy equalization refunds, RMA refunds, cancellations), store-credit or gift-card issuance (merchandise credit — see open decision D5), `discountCodeBasicCreate` (LUBYQ fallback benefit), metafield writes.

**Metafields/metaobjects**: product-level metafields for CaratForUs-specific display data the theme needs cheaply (Luxury Steal flag, Group Buy campaign id, media-type labels, ring-size config, offered metals). Rule: metafields are a **read cache for presentation**; Postgres is the system of record. Never reconcile money from metafields.

**App Proxy** (`/apps/carat/*`): Group Buy live progress JSON, Luxury Steals acknowledgment capture, RMA form, warranty claim form, quote submission, custom intake, Bring It Back / Request a New Group Buy.

**Scopes (least privilege)**: `read_products, write_products, read_orders, write_orders, read_customers, read_inventory, write_discounts, read_fulfillments, write_price_rules` — plus store-credit scope only if D5 selects native store credit. No `write_customers`, no payment scopes, no unnecessary read of customer PII beyond what a claim requires.

---

## 6. Key Mechanism Decisions

### 6.1 Group Buy pricing on native checkout
Tier prices descend only. The Shopify variant price is set to the **current tier price** and updated when a tier unlocks. Customers therefore pay the price shown when they join.

At campaign close, the final tier locks and the refund ledger equalizes every participant:
`refund_due = price_paid − final_tier_price_for_that_variant` (floored at zero; a negative result is impossible for a monotonic descent and, if it ever occurs, is set to zero and flagged for staff review rather than charged).

This makes the in-flight-cart race safe by construction: a stale cart can only hold a **higher** price, which the ledger refunds. No Shopify Function, no custom checkout, no discount gymnastics.

Refunds are held through production/QC and processed at shipping, per README — staff triggers a batch in admin; every call is guarded by `idempotency_key` plus a ledger state machine, and re-running is a no-op.

### 6.2 Qualifying units and cancellation
`orders/paid` creates `campaign_unit` rows (one per unit, not per line). `orders/cancelled` and `refunds/create` mark units non-qualifying, which can move a live campaign back to a prior tier before close — including raising the variant price back up, which is the correct and disclosed behavior. All transitions are idempotent on Shopify event id.

Customer-initiated cancellation before close is a signed App Proxy request that creates a staff action; staff approves in admin and the app calls Shopify `refundCreate` + order cancel. Money always moves through Shopify. (See open decision D8 on whether self-serve auto-approval is required for MVP1.)

### 6.3 Luxury Steals Final Sale enforcement
Layered, because a JavaScript modal alone is not evidence:
1. Theme renders an unchecked, non-bypassable acknowledgment modal on the Luxury Steal product page.
2. Affirmative acceptance POSTs to the App Proxy **before** add-to-cart, writing an `acknowledgment` row with exact text, policy version, timestamp, cart token, product/variant — this row, not the checkbox, is the evidence.
3. Add-to-cart carries the acknowledgment reference as a line-item property.
4. `orders/create` verifies that every Luxury Steal line item has a matching acknowledgment record; an order without one is flagged and held for staff review rather than silently fulfilled.

Residual gap: a customer who bypasses the storefront and POSTs directly to `/cart/add` can reach checkout without step 2; step 4 catches it after the fact. Closing it pre-checkout requires a Shopify **cart/checkout validation Function** — recommended as a fast-follow once plan availability is confirmed (see open decision D6). I am flagging this rather than asserting the gap does not exist.

### 6.4 Buy Now pricing inputs
MVP1 uses **staff-entered metal prices in the admin app**, behind a `MetalPriceSource` adapter interface. Rationale: zero recurring cost, zero unvetted third-party dependency, fully deterministic and auditable, and it satisfies "recalculate at least daily." A paid spot-price feed can be dropped in behind the same interface later without touching the pricing engine. Twice-daily automated updates are therefore explicitly a fast-follow, not MVP1 — flagged as decision D2.

Price sync guardrail: computed prices are written to `price_calculation`, auto-applied only when the change is within a configured tolerance, and otherwise queued for staff approval. Variants belonging to an open campaign are **excluded** from Buy Now recalculation.

### 6.5 Ring-size bands
Variant = metal × band (Size 2–6 / 6.5–8 / 8.5–11). The customer's **exact** US size is captured as a line-item property and validated server-side against the product's allowed range/increment. Band price is computed from the highest-cost size in the band so the band never sells below floor. Internal cost math still evaluates exact size.

### 6.6 Customer identity on claim forms
RMA and warranty forms must not reveal order data from order-number + email alone (enumeration risk). Logged-in customers are identified by App Proxy `logged_in_customer_id`. Guests receive an emailed, short-lived, single-use magic link before any order detail is displayed.

### 6.7 Idempotency discipline
Shopify's `refundCreate` has no generic idempotency token, so idempotency is ours: a UNIQUE `idempotency_key` row is committed before the API call, the call result is recorded against it, and a retry with the same key returns the stored result without a second call. Same pattern for merchandise credit and LUBYQ benefit issuance. This is the single most important safety property in the system.

---

## 7. Deployment & Local Development

**Repository layout** (proposed, on approval):
```
/app       Node + TypeScript + Remix service (admin, proxy, webhooks, jobs, engines)
/theme     Shopify Online Store 2.0 theme
/docs      requirements and locked policies (existing)
```

**Environments**: Shopify **development store** (free) for all build and QA work; production store cut over at launch. App runs in two instances (staging/prod) against two databases.

**Local dev**: `shopify app dev` (tunnels the app, installs on the dev store) and `shopify theme dev` for the theme. Local Postgres via Docker. Seed script creates sample products, a campaign, and policy versions.

**Cron**: platform scheduler → authenticated internal route guarded by `CRON_SECRET` (not in-process timers), so the job survives a future move to multiple instances.

**Migrations**: Prisma migrations run on deploy; forward-only. Rollback plan is restore-from-PITR plus a forward fix — safer than down-migrations on a ledger.

### Required environment variables
`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES`, `SHOPIFY_APP_URL`, `SHOPIFY_ADMIN_API_VERSION`, `SHOPIFY_APP_PROXY_SUBPATH`, `DATABASE_URL`, `SESSION_SECRET`, `CRON_SECRET`, `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `EMAIL_API_KEY`, `EMAIL_FROM`, `STAFF_EMAIL_ALLOWLIST`, `APP_ENV`.

Secrets live only in the hosting platform's secret store and a local `.env` that is git-ignored. Nothing supplier-cost-related, margin-related, or credential-related is ever rendered into theme Liquid or a storefront JSON response.

### Recurring cost estimate
Shopify plan $39+/mo · app host $7–25/mo · Postgres $0–25/mo · object storage ~$1/mo · email $0–20/mo · domain. **≈ $50–110/month** before payment processing. No per-feature SaaS add-ons.

---

## 8. Security, Privacy & Evidence

- All webhooks HMAC-verified against the **raw** body before parsing; unverified requests rejected and logged.
- All App Proxy requests signature-verified; all input validated server-side with a schema (zod) regardless of client-side validation.
- Uploads: private bucket, presigned PUT, server-validated content type and size cap, sha256 recorded, never publicly addressable; staff reads via short-lived signed URLs.
- PII minimized: reference Shopify customer/order IDs rather than duplicating profiles. Claim forms store only what the locked policies require.
- Admin data (supplier costs, margins, cost components, internal notes, the internal-only local-jeweler option) is served only through authenticated admin routes. **Never** exposed via App Proxy JSON, Liquid, or metafields.
- No raw card data, ever. Refunds execute through Shopify.
- Logging records business events and references, never secrets or payment data.
- Evidence tables are append-only; later edits to live product/policy pages cannot overwrite historical snapshots, which are content-hashed.
- Mandatory Shopify GDPR webhooks implemented, with a documented retention position that preserves transaction/dispute evidence as permitted.

---

## 9. Test Strategy

**Unit (Vitest) — where nearly all the value is.** The business rules are pure functions over explicit inputs, so every locked acceptance case becomes a table-driven test:
- BUY-NOW-RETURNS §13 cases 1–12 (Day 7/14/8/30/31 boundaries, 10-day post-approval expiry, restocking math, outbound-shipping exclusion, duplicate-value prevention).
- LUXURY-STEALS §"MVP1 Acceptance Cases" 1–12.
- WARRANTY-CLAIMS §11 cases 1–11.
- LUBYQ **amendment** §4 cases 1–8 (the amendment's cases control; see §11).
- Group Buy: tier thresholds, qualifying-unit counting, cancellation regression to a prior tier, final price, refund math, margin-floor validation, weight-by-ring-size, band cost basis, rounding.
- Money: no floating point anywhere; property tests that round-trip and sum to exact cents.

**Integration (Vitest + real Postgres).** Webhook HMAC + replay idempotency; refund ledger under duplicate/retried processing; evidence-row immutability; App Proxy signature rejection; magic-link expiry and single use.

**Fixtures.** Recorded Shopify webhook payloads with valid and invalid HMACs.

**Manual QA on the development store** for real checkout, inventory-to-zero, and acknowledgment flows — plus a small Playwright smoke set (PDP renders, acknowledgment blocks add-to-cart, Group Buy progress loads).

**Standing rule:** a locked-policy calculation ships only with tests written from the policy document, and no test may be authored from a README summary where a locked document controls.

---

## 10. MVP1 Vertical Slices

Each slice is end-to-end and independently reviewable. Assignments use the least expensive capable agent.

| # | Slice | Depends on | Owner (model) | Risk |
|---|---|---|---|---|
| 0 | **Foundation**: repo layout, app scaffold, DB + migrations, money primitives, policy versioning, acknowledgment/snapshot/audit core, webhook verification + idempotency, CI | — | Architect specifies; Backend & Pricing (`sonnet`) implements; **architect review required** | High |
| 1 | **Cost libraries + Buy Now pricing engine** + admin price review/sync job | 0 | Backend & Pricing (`sonnet`) + Test Eng (`haiku`); **architect + QA review** | High |
| 2 | **Theme baseline + Buy Now PDP**: media-type labeling, ring-size guide, metal education, return/shipping disclosures | 1 | Shopify Dev (`sonnet`) + Frontend (`sonnet`) | Medium |
| 3 | **Luxury Steals**: collection, badges, real-inventory scarcity, Final Sale acknowledgment + evidence + order verification | 0, 2 | Shopify Dev (`sonnet`) + Backend (`sonnet`); **QA review** | High |
| 4 | **Buy Now RMA**: customer form, window calculation, staff admin, refund/restocking/merchandise credit, evidence | 0 | Backend (`sonnet`) + Frontend (`sonnet`) + Test Eng (`haiku`); **architect + QA review** | High |
| 5 | **Warranty claims**: form, uploads, authorization-before-shipment, inspection, remedy, internal-only jeweler records | 0 | Backend (`sonnet`) + Frontend (`sonnet`) + Test Eng (`haiku`); **QA review** | High |
| 6 | **Group Buy engine core**: campaign, freeze snapshot, tiers, qualifying units, margin validation, webhooks | 0, 1 | Backend (`sonnet`); **architect review required** | High |
| 7 | **Group Buy storefront**: progress, live savings, countdown, tier markers, sharing, milestone emails | 6 | Frontend (`sonnet`) + Shopify Dev (`sonnet`) | Medium |
| 8 | **Group Buy close/refunds**: final price, refund ledger, cancellation-before-close, status workflow | 6 | Backend (`sonnet`) + Test Eng (`haiku`); **architect + QA review** | Highest |
| 9 | **Custom Jewelry**: intake + uploads, $49 deposit, reusable approval/purchase template, approval evidence | 0, 2 | Frontend (`sonnet`) + Backend (`sonnet`) + Shopify Dev (`sonnet`) | Medium |
| 10 | **Let Us Beat Your Quote**: three-path intake, quote-age calc, acknowledgments, manual review admin, 90-day fallback benefit | 0, 9 | Backend (`sonnet`) + Frontend (`sonnet`) + Test Eng (`haiku`); **QA review** | High |
| 11 | **Shipping/insurance/signature** controls and evidence | 0 | Backend (`sonnet`) | Medium |
| 12 | **Content**: FAQ architecture, policy pages, About, Why Buy From Us, contact | 2 | Shopify Dev (`sonnet`) | Low |
| 13 | **Archive & demand capture**: Past Group Buys, Bring It Back, Request a New Group Buy | 6, 7 | Frontend (`sonnet`) + Backend (`sonnet`) | Low |

**Parallel-safety rule.** Slices 0 and 1 are serial and touch shared foundations — no parallel work during them. From slice 2 onward, at most two slices run concurrently and only when they own disjoint files (theme vs app, or distinct app modules). Slices 6 and 8 never run alongside another slice that writes to the pricing or ledger modules.

### Phase 1 (requested for approval now)
**Slices 0 → 1 → 2, executed in order.** This is the smallest sequence that produces a real, sellable Buy Now storefront on correct, audited, deterministic pricing, and it establishes the money, evidence, and idempotency primitives every later slice depends on. I recommend approving Phase 1 only, then re-reviewing before Phase 2 (slices 3–5).

---

## 11. Locked-Policy Conflicts Identified

**C1 — Let Us Beat Your Quote, active online listings.** `docs/LET-US-BEAT-YOUR-QUOTE.md` §"Eligible Submission Types" item 2 and its Acceptance Case 4 state that an active online listing is guarantee-eligible and can trigger the 10%-off fallback. `docs/LET-US-BEAT-YOUR-QUOTE-AMENDMENT.md` §1 and §5 supersede this: online listings are **review-only**, no guarantee, no fallback. CLAUDE.md and README both confirm the amendment controls. **No owner action needed — but this is a live trap**: the superseded document contains a full, plausible-looking acceptance case that directly contradicts the controlling one. Implementation and tests for slice 10 must be written from the amendment, and the original Acceptance Case 4 must be explicitly marked superseded in the feature spec.

**C2 — Competing Group Buys.** Consistent across both documents (review-only, no fallback). No conflict.

**C3 — `docs/COMPETITORS.md` naming.** That document refers to the business as "DiamondDrop" throughout, while every other document and the approved brand is "CaratForUs." It is a competitive-research document with no implementation impact, so I am not treating it as a policy conflict — flagging it only so no customer-facing copy is ever drawn from it verbatim.

No other conflicts found between README summaries and the four locked policy documents.

---

## 12. Open Decisions Requiring Owner Approval

These block or shape work as noted. D1–D4 block Phase 1 start; the rest are needed later.

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | **OPEN.** Shopify store + plan provisioned; development store and API credentials available to the team | Create a free development store now; defer the paid plan until launch. Slice 0 is scoped to proceed without live credentials; this blocks slice 0's dev-store install step and all of slice 2 | Slice 0 (partial), Slice 2 |
| D2 | ~~Metal price source~~ **RESOLVED 2026-09-13: staff-entered in admin**, behind a `MetalPriceSource` adapter. Automated twice-daily feed is an explicit post-launch fast-follow, not MVP1 | — | — |
| D3 | ~~Hosting + Postgres provider~~ **RESOLVED 2026-09-13: Fly.io app + Fly managed Postgres, single region** | — | — |
| D4 | ~~Object storage + email provider~~ **RESOLVED 2026-09-13: Cloudflare R2 (private bucket) + Resend** | — | — |
| D5 | Merchandise-credit mechanism for RMA Days 8–30 | Shopify native store credit if available on the chosen plan; gift card as fallback. Needs verification against the selected plan | Slice 4 |
| D6 | Whether to add a Shopify cart/checkout validation Function to hard-block un-acknowledged Luxury Steal checkouts | Ship layered enforcement (§6.3) in MVP1; add the Function as a fast-follow once plan availability is confirmed | Slice 3 |
| D7 | **Tax treatment of the 50% restocking-fee refund and of merchandise credit.** `BUY-NOW-RETURNS` §14 expressly forbids inventing this | Owner/accountant must specify. I will not assume | Slice 4 completion |
| D8 | Group Buy cancellation: staff-approved (recommended) vs fully self-serve automatic refund before close | Staff-approved for MVP1; every money move reviewed | Slice 8 |
| D9 | Payment methods to encourage as "lower-cost," since payment cost is a pricing-engine input | Owner to specify; engine treats it as a configurable component either way | Slice 1 |
| D10 | Merchandise-credit expiration/transferability | `BUY-NOW-RETURNS` §14 leaves this unsettled — owner must lock it or confirm "no expiration" | Slice 4 |
| D11 | Legal review of customer-facing policy/acknowledgment copy | Out of engineering scope; recommend counsel review before launch | Slice 12 |
| D12 | ~~Shopify app library: official template vs. plain Remix~~ **RESOLVED 2026-09-14: hybrid.** Adopt `@shopify/shopify-app-remix` for OAuth, session storage and App Bridge; keep our own `receiveShopifyWebhook`/`claimWebhookEventForProcessing` for inbound webhooks. Prisma `session` model ships in the slice 2 migration. Full rationale and the "do not consolidate onto `authenticate.webhook`" warning are in §2.1 | — | — |

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Duplicate refunds / duplicate customer value | Mandatory `idempotency_key` + ledger state machine + unique constraints; explicit tests in slices 4, 8, 10 |
| Tier-unlock race with in-flight carts | Monotonic descending prices make staleness favor the customer; ledger equalizes at close (§6.1) |
| Un-acknowledged Luxury Steal purchase via direct cart POST | Layered enforcement + post-order verification and hold; validation Function as fast-follow (D6) |
| Pricing engine drifting below margin floor | Pre-publication validation against minimum margin %, minimum dollar profit, and per-variant floor; unsafe tiers blocked absent an authorized, audited override |
| Test written from a superseded document | C1 documented; every feature spec cites the controlling document and section |
| Shopify metafield/Postgres divergence | Metafields are presentation cache only; money and eligibility are never read from them |
| Single-instance host outage | Webhooks retried by Shopify for 48h and deduped on receipt; no event loss |

---

## 14. Architecture Review Verdict

Reviewed against Shopify-native boundaries, MVP1 scope, evidence/versioning needs, financial determinism, webhook idempotency, authn/authz/privacy, operability and recurring cost, testability, and rollback risk.

- Shopify-native vs custom boundaries: clean. Checkout, payments, inventory, accounts, taxes, and discounts stay native. Custom surface is limited to what Shopify genuinely cannot record or compute.
- No unnecessary frameworks, queues, microservices, extra databases, or headless complexity introduced.
- Financial determinism satisfied: integer minor units, decimal intermediate math, versioned rounding, immutable calculation rows.
- Idempotency addressed at both inbound (webhook event id) and outbound (money operations) edges.
- Recurring cost is appropriate for a low-margin startup (~$50–110/mo).
- One locked-policy trap identified and documented (C1). Eleven owner decisions identified, of which D7 and D10 are expressly reserved to the owner by the locked policy itself.
- One honest residual gap documented rather than papered over (§6.3 / D6).

**VERDICT: APPROVE WITH CONDITIONS**, conditioned on:
1. Owner approval of this document.
2. Owner resolution of **D1–D4** before slice 0 begins.
3. Owner resolution of **D7 and D10** before slice 4 is accepted as complete.
4. Phase 1 limited to slices 0 → 1 → 2, with architect review of slice 0 and slice 1 diffs before Phase 2 is planned.
5. Every delegated slice preceded by `/feature-spec` and closed with `/handoff`.

No scaffolding begins until condition 1 is met.
