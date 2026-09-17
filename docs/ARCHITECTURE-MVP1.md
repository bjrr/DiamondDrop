# CaratForUs MVP1 Architecture — PROPOSED

## Status
**APPROVED BY OWNER 2026-09-13. Phase 1 (slices 0 → 1 → 2) authorized.**

Owner decisions resolved at approval: **D2 = staff-entered metal prices** (adapter-backed; automated feed is a post-launch fast-follow). **D3/D4 = Fly.io app + managed Postgres, Cloudflare R2 private storage, Resend transactional email.**

Resolved 2026-09-14, arising from the slice 0 acceptance review: **D12 = hybrid adoption of `@shopify/shopify-app-remix`** (OAuth, session storage and App Bridge from the library; webhook receipt stays ours). **D12 is SUPERSEDED as of 2026-09-15 by D13** and is retained in §12 only as history — do not implement it.

Resolved 2026-09-15, owner-directed: **D13 = React Router 7 replaces Remix v2, and `@shopify/shopify-app-react-router` replaces `@shopify/shopify-app-remix`.** The *hybrid boundary* established by D12 is unchanged and carries over verbatim: the Shopify library supplies OAuth, session storage and App Bridge; inbound webhook receipt stays ours. See §2.1, which is the single live statement of this decision and records both the version pin and why the library's `authenticate.webhook` is deliberately not used.

Resolved 2026-09-17, owner-directed: **D9** (cash-equivalent base price; credit-card price derived at a configurable, versioned +5%), **D15** (daily recalculation, configurable). **D14 is PARTIALLY resolved** — target markup on cost 40%, minimum margin 20%, minimum dollar profit $100, whole-dollar rounding; only the automatic price-sync tolerance remains outstanding, and until it is supplied automatic Shopify publication stays disabled.

Still open and tracked in §12: **D1** (Shopify development store + API credentials — owner will provide before slice 1 completion; gates slice 2, and Shopify synchronisation must not be described as verified until it exists), **D5–D8**, **D10**, **D11**, and D14's tolerance. D7 and D10 are reserved to the owner by `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §14 and must be resolved before slice 4 is accepted.

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
| Custom app | Single Node 20 + TypeScript service, **React Router 7 (framework mode), pinned to `react-router@7.18.3`** — **hybrid** adoption of `@shopify/shopify-app-react-router` (designated, adopted in slice 2), see §2.1 | One deployable. React Router 7 gives us server routes and the embedded-admin scaffold; the Shopify library supplies OAuth, session storage and App Bridge. Webhook receipt is deliberately **ours**, not the library's — §2.1. **Do not upgrade React Router past 7.x without reading §2.1** — 8.x breaks the Shopify library's peer range and raises the Node floor. |
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

### 2.1 Web framework and Shopify app library: React Router 7 + hybrid adoption (D13, supersedes D12)

**D13 APPROVED BY OWNER 2026-09-15.** **D12 (2026-09-14) is superseded and must not be implemented.** This section is the single live statement of the decision; §12's D12 row is retained as history only.

**What changed and why.** D12 chose Remix v2 plus a hybrid adoption of `@shopify/shopify-app-remix`. Shopify's current official documentation recommends the **React Router app template** and **`@shopify/shopify-app-react-router`** for new apps. CaratForUs is pre-launch with one slice shipped, so establishing new architecture on the superseded library would buy a migration debt for nothing. Remix v2 → React Router 7 is the documented continuation — React Router 7 is what Remix v3 became — so this is very largely a rename-and-rewire of the framework shell rather than a rewrite.

**"Largely", not "entirely".** Exactly one genuine behaviour change came with the migration — a cross-origin guard on action submissions, harmless in slice 0 only by accident of how its routes are shaped. It is written up under *R-1* below and must be read before slice 3 builds the first App Proxy form. Do not let the "rename-and-rewire" summary license an assumption that nothing behavioural moved.

**What did NOT change.** The hybrid boundary from D12 carries over unchanged, including the reasoning below about `authenticate.webhook`. Owner restatement, 2026-09-15: *"Do not replace our custom webhook processing merely because the Shopify library provides webhook authentication."* D13 is a framework/library swap, not a re-opening of the boundary.

#### Version pin — read before upgrading anything

| Package | Pinned | Why this exact line |
|---|---|---|
| `react-router` | **7.18.3** | The upper end of what the Shopify library supports, and compatible with our Node 20 floor. |
| `@shopify/shopify-app-react-router` | **2.1.0** (designated; installed in slice 2) | Current latest. Peer deps: `react >=18`, `react-dom >=18`, **`react-router ^7.6.2`**. |

**React Router is pinned to 7, not to latest, for two independent reasons — either one alone is disqualifying:**

1. **Peer range.** `@shopify/shopify-app-react-router@2.1.0` declares `react-router: ^7.6.2`. React Router 8.x is outside that caret range. Upgrading to 8 puts us on an unsupported combination with the library that owns our OAuth and session storage.
2. **Node floor.** React Router **8.x requires Node >=22.22.0**. Our CI is pinned to Node 20 and `package.json` declares `engines: {node: ">=20.0.0"}`. React Router 7.18.3 requires Node >=20.0.0, so the pin leaves both untouched. Moving to 8 forces a Node-runtime migration across CI, the Fly image and every developer machine, as a side effect of what would look like a routine dependency bump.

This is recorded in this much detail because *"upgrade to the newest React Router"* is exactly the well-meaning maintenance change that would break both at once, and neither breakage is obvious from the diff. Raising the React Router major is an architecture decision requiring a recorded amendment here, not a dependency bump. It is unblocked only when `@shopify/shopify-app-react-router` publishes a release whose peer range admits it **and** the owner accepts the Node 22 floor.

#### Hybrid adoption

**Adopted from `@shopify/shopify-app-react-router` (designated now, installed in slice 2):**
- Embedded-admin **OAuth** / app install flow.
- **Session storage** (Prisma-backed). The `session` model lands in the slice 2 migration; it is not part of slice 0's six tables.
- **App Bridge** (and Polaris for admin UI).

**Deliberately deferred to slice 2, not installed in slice 0.** Slice 0's non-goals exclude admin OAuth, session storage and Admin API calls. A declared-but-unused dependency has no consumer and therefore cannot be tested; it would be dead weight that the first real integration would likely have to change anyway. The library is *designated* here so slice 2 does not re-litigate the choice, and *installed* there so its first commit has a caller and a test.

**Deliberately NOT adopted: the library's webhook handling (`authenticate.webhook`).** Inbound webhook receipt stays with our own `receiveShopifyWebhook` (`app/app/shopify/webhooks/receive.server.ts`) and `claimWebhookEventForProcessing` (`app/app/db/repositories/webhookEventRepository.server.ts`).

**Why — read this before "fixing" the divergence.** A future reader will notice that we verify HMACs ourselves while importing a library that also verifies HMACs, and will be tempted to delete ours as duplication. It is not duplication. `authenticate.webhook` verifies the HMAC and parses the body; that is *all* it does — and this is as true of `@shopify/shopify-app-react-router` as it was of `@shopify/shopify-app-remix`; the rename changed nothing about it. It has no delivery deduplication, no claim state machine, and no notion of a prior attempt having failed. Our receiver provides three properties the library does not, each of which exists because a specific failure mode would otherwise move money incorrectly:

1. **Deduplication on a UNIQUE constraint** over `webhook_event.shopify_event_id` (not a read-then-write check), so two concurrent deliveries of the same event cannot both be processed. Without this, a redelivered `orders/paid` can create a second `campaign_unit` and shift a Group Buy tier.
2. **Dedup keyed on successful processing, not row existence.** A replayed delivery whose prior attempt *failed* is reprocessed (`claimed_retry`), not swallowed. Swallowing it loses the event permanently, because Shopify's retry is the only redelivery we get.
3. **Stale-claim reclaim plus a 5xx (not 200) response for an ambiguous in-flight claim.** A 2xx permanently ends Shopify redelivery, so answering 200 for an unresolved event buries it. A crashed attempt is recovered after `DEFAULT_STALE_CLAIM_MS`; until then the delivery stays in Shopify's retry schedule and remains visible in its failed-delivery reporting.

Replacing our receiver with `authenticate.webhook` would silently discard all three. If a future slice wants to consolidate, the burden is on that slice to demonstrate the library has grown equivalents — not to assume the overlap is accidental. A *version bump* of the Shopify library is not such a demonstration.

**Boundary rule.** The library owns *authentication and session* concerns. It does not own *event processing* concerns. Admin and App Proxy routes may use the library's authenticate helpers freely; webhook routes go through `receiveShopifyWebhook`.

**File-path stability.** React Router 7 framework mode keeps Remix's `app/` route-module convention, so the module paths cited throughout this document and in `docs/specs/SLICE-0-FINDINGS.md` survive the migration. Line numbers in those citations may shift; treat a stale line number as a pointer to the named symbol, not as evidence the finding was addressed. **Checked 2026-09-15 and no citation actually moved** — every `Where` reference in that register points into `domain/`, `db/`, `lib/` or `shopify/`, and the migration changed no file in any of them (not even an import specifier; none of those modules ever imported `@remix-run/*`).

#### R-1 — React Router 7's CSRF origin guard (new behaviour, no Remix v2 equivalent)

Recorded 2026-09-15 from the D13 migration review. **This is a slice 2 input and a live trap for slices 3, 4, 5, 9 and 10.**

D13 is described above as a rename-and-rewire of the framework shell. That is accurate for slice 0 but slightly understates one thing: React Router 7 introduced `throwIfPotentialCSRFAttack`, which Remix v2 had no counterpart for. It runs on **every mutation-method request to a route that has a default export**, and `allowedActionOrigins` defaults to an empty allowlist — so the check is always active with zero exemptions unless configured.

**Resource routes are exempt.** `@react-router/dev`'s own config typing says the allowlist covers "action submissions to UI routes (does not apply to resource routes)". Slice 0's four routes all have `hasDefaultExport: false` — they are resource routes — which is why the migration passed every webhook test. Shopify webhooks also send no `Origin` header at all.

Evidence from the review, against the built server:

| Request | Result |
|---|---|
| `POST /webhooks/shop/redact` + `Origin: https://caratforus.com` | **200** (resource route, exempt) |
| `POST /` + `Origin: https://caratforus.com` | **400** (UI route, guard fires) |
| `POST /` + `Origin: http://127.0.0.1:3111` (same origin) | **405** |

The 405 on the same-origin request is the load-bearing detail: it proves the 400 came from the CSRF guard and not from method rejection.

**The failure mode to avoid.** Slices 3, 4, 5, 9 and 10 all POST customer forms through the App Proxy. A form rendered on `caratforus.com` posting to a route that *also renders UI* arrives with `Origin: https://caratforus.com` while `request.url` is the app host. The request is rejected with 400 **before any validation runs, before any evidence row is written, and before any log line our code emits**. A customer's Group Buy join or warranty claim fails silently with nothing in our logs to explain it — and nothing in the diff that introduced it to point at.

**Mitigation, one line.** Either keep App Proxy POST endpoints as resource routes (no default export), or set `allowedActionOrigins: ["caratforus.com", "*.myshopify.com"]` in `app/react-router.config.ts`.

#### Standing contract for a future React Router 8 upgrade

The RR7 build emits five `v8_*` future-flag warnings. None are enabled and none should be enabled now. Four are inert for us (`v8_passThroughRequests` preserves bytes either way — both paths pass the body as a stream reference rather than reading and re-encoding it; `v8_trailingSlashAwareDataRequests` affects only `.data` URLs, which we have none of; `v8_splitRouteModules` and `v8_viteEnvironmentApi` are build-time only).

**`v8_middleware` is the one that can break us, and the breakage will not be visible in the diff that enables it.**

> **No middleware may consume the request body.** A single global middleware calling `request.text()` or `request.formData()` makes `receiveShopifyWebhook`'s own `request.text()` (`app/app/shopify/webhooks/receive.server.ts`) throw on an already-read body. Every webhook then fails, every delivery burns Shopify retries, and the fault sits in framework plumbing rather than in our code — so it will not look like a webhook bug to whoever debugs it.

Enabling `v8_middleware` also changes `context` from `{}` to a `RouterContextProvider`, a breaking signature change that the slice 2 Shopify library is untested against.

#### Configuration gaps to close in slice 2

Slice 0's React Router configuration is complete and correct **for slice 0**. Three items are deliberately absent and become live the moment the Shopify library lands. Tracked as **F-23, F-24 and F-25** in `docs/specs/SLICE-0-FINDINGS.md`; summarised here so the slice 2 spec author does not need a second lookup.

- **`allowedActionOrigins` is unset** (F-23). See R-1 above. Note that unset does not mean disabled: the key defaults to `false`, which the runtime coerces to an *empty allowlist*, so the guard runs with no exemptions.
- **No route typegen** (F-24). `app/tsconfig.json` excludes `.react-router` and sets no `rootDirs`, and nothing runs `react-router typegen`. That is correct today, because our route modules use `LoaderFunctionArgs`/`ActionFunctionArgs`. Shopify's React Router template instead uses generated `+types/*` route types, which require `"rootDirs": [".", "./.react-router/types"]` plus a typegen step ahead of `tsc --noEmit`. Slice 2 must either wire that up or deliberately reject the template's typed-route style — the failure mode otherwise is a half-adopted template whose type errors look like a broken install.
- **Vite major bump likely needed** (F-25). We run `vite@5.4.21`, comfortably inside `@react-router/dev@7.18.3`'s peer range (`^5.1.0 || ^6 || ^7 || ^8`), so nothing is broken now. But Vite 5 has no `server.allowedHosts`, which the tunnel used by `shopify app dev` generally needs. Budget a Vite major in slice 2 rather than meeting it as a surprise on the day the development store is first connected.

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

**Route ownership under D13.** Topic *subscription* is declared in `shopify.app.toml`. Topic *delivery* is handled by our own route calling `receiveShopifyWebhook` — **not** by `@shopify/shopify-app-react-router`'s `authenticate.webhook`, and not by any webhook route the React Router app template scaffolds. When slice 2 installs the library, delete or bypass any template-generated webhook route rather than wiring it up; §2.1 explains why. Admin and App Proxy routes are the opposite case: they use the library's authenticate helpers.

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
/app       Node + TypeScript + React Router 7 service (admin, proxy, webhooks, jobs, engines)
/theme     Shopify Online Store 2.0 theme
/docs      requirements and locked policies (existing)
```

**Environments**: Shopify **development store** (free) for all build and QA work; production store cut over at launch. App runs in two instances (staging/prod) against two databases.

**Local dev**: `shopify app dev` (tunnels the app, installs on the dev store) and `shopify theme dev` for the theme. Local Postgres via Docker. Seed script creates sample products, a campaign, and policy versions.

**Build and serve (D13).** React Router 7 framework mode builds through Vite to the same two-directory layout Remix v2 used — `build/client` (static assets) and `build/server` (the server bundle, entry `build/server/index.js`). The production process is `react-router-serve ./build/server/index.js` in place of `remix-serve`. **Nothing in the deployment model changes**: same single Node process, same single port, same container, same Fly configuration, same build-output path to copy into the image. The only deployment-visible edits are the serve binary in the start command and the dependency names. Fly's app-host sizing, region count and cost are unaffected.

**Node version.** The runtime image, CI and `engines` all stay on **Node 20**, which React Router 7.18.3 supports (`>=20.0.0`). See §2.1 — a React Router 8 upgrade would force Node 22 everywhere and is deliberately out of scope.

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

**Effect of D13 on this strategy: none in substance, one in sequencing.** Where the test value lives is unchanged — the business rules are pure functions over explicit inputs and import nothing from the web framework, so the unit suite is framework-agnostic by construction. The integration suite exercises real Postgres plus **our own** `receiveShopifyWebhook`, the append-only triggers and the idempotency wrapper, none of which the framework touches; keeping webhook receipt out of the Shopify library (§2.1) is also what keeps the highest-value tests independent of it. The migration's surface is imports (`@remix-run/*` → `react-router`), route-module type names, the Vite plugin and the serve binary — compile-time and boot-time concerns, which typecheck, build and the existing suite already cover.

The sequencing consequence: the framework migration **re-opens the slice 0 "Deferred verification" list** (`docs/specs/SLICE-0-FOUNDATION.md`). That list must pass on the React Router build, not only on the Remix build it was written against; a green run against the superseded shell does not carry over. This is verification of already-specified behaviour, not new test scope.

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

**Slice 2 carries the Shopify library adoption (D13).** Per §2.1, `@shopify/shopify-app-react-router@2.1.0` is installed in slice 2 — OAuth, Prisma session storage (the `session` model and its migration) and App Bridge. The slice-2 row above is written as theme-and-PDP work owned by Shopify Dev + Frontend; the library adoption is a **backend** task that must be added to the slice 2 feature spec with the Backend & Pricing Engineer (`sonnet`) as its owner, and it is the first thing in slice 2 that requires D1 (a real development store). Flagging rather than silently re-scoping the table: the slice 2 spec is not yet written, so this is an input to it.

That same backend task also owns the three React Router configuration gaps recorded in §2.1 — `allowedActionOrigins` (F-23), route typegen (F-24) and the likely Vite major bump (F-25). Two of them are cheap if done deliberately in slice 2 and expensive if discovered later: F-23 surfaces as silently-400ing customer forms in slices 3–10 (see R-1), and F-25 surfaces as a blocked `shopify app dev` on the day D1 is finally resolved.

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
| D1 | **OPEN.** Shopify development store + API credentials. **Owner will provide before slice 1 completion.** Does NOT block slice 1 pricing work — cost libraries, reference pricing, product-cost calculation, profiles, floors, overrides, payment-price derivation, snapshots and tests all proceed without it. It DOES gate slice 2 and all real Shopify integration. **Until credentials exist, Shopify synchronisation must not be represented as verified** | Owner to provide | Slice 2 |
| D2 | ~~Metal price source~~ **RESOLVED 2026-09-13: staff-entered in admin**, behind a `MetalPriceSource` adapter. Automated twice-daily feed is an explicit post-launch fast-follow, not MVP1 | — | — |
| D3 | ~~Hosting + Postgres provider~~ **RESOLVED 2026-09-13: Fly.io app + Fly managed Postgres, single region** | — | — |
| D4 | ~~Object storage + email provider~~ **RESOLVED 2026-09-13: Cloudflare R2 (private bucket) + Resend** | — | — |
| D5 | Merchandise-credit mechanism for RMA Days 8–30 | Shopify native store credit if available on the chosen plan; gift card as fallback. Needs verification against the selected plan | Slice 4 |
| D6 | Whether to add a Shopify cart/checkout validation Function to hard-block un-acknowledged Luxury Steal checkouts | Ship layered enforcement (§6.3) in MVP1; add the Function as a fast-follow once plan availability is confirmed | Slice 3 |
| D7 | **Tax treatment of the 50% restocking-fee refund and of merchandise credit.** `BUY-NOW-RETURNS` §14 expressly forbids inventing this | Owner/accountant must specify. I will not assume | Slice 4 completion |
| D8 | Group Buy cancellation: staff-approved (recommended) vs fully self-serve automatic refund before close | Staff-approved for MVP1; every money move reviewed | Slice 8 |
| D9 | ~~Payment methods and payment pricing~~ **RESOLVED 2026-09-17.** The authoritative base price is the **cash-equivalent** price (ACH, wire, Zelle, cheque). Credit-card price is **derived**: `credit_card_price = base_retail_price x (1 + payment_adjustment)`, MVP1 default **5%**, configurable and versioned. A cash price and a card price are never maintained independently. Checkout mechanics remain to be verified against Shopify and payment-network rules before customer-facing deployment; the pricing domain supports the rule without inventing checkout behaviour | — | — |
| D10 | Merchandise-credit expiration/transferability | `BUY-NOW-RETURNS` §14 leaves this unsettled — owner must lock it or confirm "no expiration" | Slice 4 |
| D11 | Legal review of customer-facing policy/acknowledgment copy | Out of engineering scope; recommend counsel review before launch | Slice 12 |
| D12 | ~~Shopify app library: official template vs. plain Remix~~ Resolved 2026-09-14 as a hybrid adoption of `@shopify/shopify-app-remix`. **SUPERSEDED 2026-09-15 by D13 — historical record only, do not implement.** The *hybrid boundary* it established survives in D13; only the framework and library names changed | — | — |
| D13 | ~~Web framework and Shopify app library~~ **RESOLVED 2026-09-15 (owner-directed): React Router 7 + `@shopify/shopify-app-react-router`.** Supersedes D12. Pin `react-router@7.18.3` (**not** 8.x — breaks the library's `^7.6.2` peer range and raises the Node floor to 22). `@shopify/shopify-app-react-router@2.1.0` is designated now and installed in **slice 2**, not slice 0. Hybrid boundary unchanged: library for OAuth/session/App Bridge; our `receiveShopifyWebhook`/`claimWebhookEventForProcessing` for inbound webhooks. Full rationale, version-pin reasoning and the "do not consolidate onto `authenticate.webhook`" warning are in §2.1 | — | — |
| D14-followups | **Architect follow-ups from the `ddb7641` review.** N1, N2 and N3 are DONE (`ec10743`, `2e1909a`): the margin model is now a registry so a third model never touches `engine.ts` (pinned by tests asserting the engine names no model and no model-specific rate); the round-then-end sequence is extracted so the cash and card prices cannot drift across the rounding boundary; and `price_override` now has explicit supersession and revocation, with a unique index preventing a forked history and a CHECK preventing a `set` with no price or a `revoke` with one. Remaining, carried into Slice 2: (4) **Slice 2 entry criterion:** split "may we publish automatically at all" from "at what threshold". Today they are one column, so the day the owner supplies a tolerance, automatic publication switches on as a side effect — possibly before D1 credentials exist. Automatic publication must become a separate enablement defaulted off | — | — |
| D14-tolerance | **RESOLVED 2026-09-17, owner: 200 bps (2%).** A recalculated price within 2% of the last published price may auto-apply; anything larger queues for a human. Symmetric — a 3% drop queues exactly as a 3% rise does. Calibration: a 1% move in landed cost produces a 100 bps move in price, so 2% absorbs ordinary daily metal movement while still catching a mistyped metal price. D14 is now fully resolved. **Note:** supplying the tolerance clears prices for publication but publishes nothing — no Shopify sync port exists (D1 open), and `auto_apply` yields an `approved` intent, never `synced` | — | — |
| D9-final | **FINAL SHAPE, owner-clarified 2026-09-17.** Two prices, one calculation. **INTERNAL:** the calculated price is the **CASH** price (PayPal, Venmo, ACH, wire, Zelle) — the real sale price, what the margin floors bind, what profit is measured on. **DISPLAYED:** the **CARD** price, cash x 1.05, is what the customer sees and what gets **published to Shopify**; cash is presented as a discount off it. Because the floors bind the LOWER price, both clear them by construction, and the discount-overrides-the-minimums carve-out of the intermediate revision is no longer needed. **Slice 2 must publish `cardPrice`, not the stored `price`** — publishing the stored cash price would undercharge every card customer by 5% silently. Presenting card as the headline is also the compliant framing: a cash discount is unrestricted, a card surcharge is capped at 3% by the networks and restricted in several states. **RESOLVED 2026-09-17, owner: NO DISCOUNT PERCENTAGE IS EVER ADVERTISED.** The storefront shows the card price and the cash price, and states no percentage. This closes a real trap rather than choosing a wording: a 5% uplift is the reciprocal of a 5% discount ($400 cash gives $420 card, and $400 is 4.76% off $420), and whole-dollar rounding makes the realised saving vary per item between roughly 4.76% and 4.95% — so no single percentage claim would be correct across the catalogue. Two absolute prices are exact by construction and cannot drift out of step with the rate. **Binding on Slice 2 storefront work:** render the two prices, never a percentage; if a saving must be shown, use the dollar difference. Nothing in `BuyNowPriceResult` exposes a percentage and nothing may start to. The uplift stays 0.05 | — | — |
| D14-impl | **D14 implementation status (2026-09-17).** Target markup 40% ON COST (`MARKUP_ON_COST_V1`: price = cost x 1.40 — deliberately NOT a 40% gross margin, which would be $166.67 on a $100 cost rather than $140), minimum gross margin 20% of price, minimum dollar profit $100, whole-dollar rounding UP (`WHOLE_DOLLAR_UP_V1`). All four live on `pricing_profile` v2 as configurable, versioned columns — none is hard-coded. **The auto-apply tolerance remains OPEN**, stored as NULL, which DISABLES automatic Shopify publication: every price change routes to manual approval. Manual owner overrides are implemented in `price_override` and may breach the floors deliberately, subject to a named warning, an explicit `--confirm-breach` confirmation, a required reason and an append-only audit row | — | — |
| D14 | ~~Buy Now pricing profile values~~ **PARTIALLY RESOLVED 2026-09-17.** Target **markup on total cost 40%** (`target_price = total_product_cost x 1.40`) — this is MARKUP ON COST, **not** gross margin. Minimum margin **20%**, a separate safety floor. Minimum dollar profit **$100**. Price rounding **whole dollars**. All four remain configurable and versioned, never hard-coded. **STILL OPEN: the automatic price-sync tolerance.** Until it is supplied, prices may be calculated and displayed, but automatic Shopify publication stays disabled — every change requires manual approval | Owner to supply tolerance | Automatic publication only |
| D15 | ~~Buy Now price recalculation cadence~~ **RESOLVED 2026-09-17: DAILY**, configurable via the platform scheduler — nothing in the code encodes "once a day". Staff may trigger an immediate run by POSTing `{trigger, triggeredBy, reason}` to the recalculation endpoint; a staff-triggered run without a named actor is refused before any price is written. **IMPLEMENTED:** `price_recalculation_run` records trigger, actor, reason, as-of, start/finish and counts; `price_sync_intent` records previous price, percentage change (`delta_bps`) and dollar change (`delta_minor_units`) alongside approval status; `price_calculation` records profile version, engine version, rounding/ending rule ids and a snapshot of every resolved input. **Group Buy frozen prices are never modified by a Buy Now recalculation** — enforced by a write-surface test that pins the tables the job may write and fails on any new one | — | — |

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
| A routine dependency bump raises React Router to 8, breaking the Shopify library's peer range and the Node 20 floor at once | Pin recorded with both reasons in §2.1 and repeated in the §2 stack table; a React Router major bump is an architecture amendment, not a maintenance change. Enforce in `/review-code` on any diff touching `app/package.json` |
| A later slice "consolidates" webhook receipt onto the Shopify library's `authenticate.webhook`, silently dropping dedup, failed-attempt replay and stale-claim reclaim | §2.1 states the three properties and the failure mode each prevents; the boundary rule survived the D12→D13 rewrite deliberately. Burden of proof is on the consolidating slice |

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

**Amendment 2026-09-15 (D13).** The verdict above stands unchanged. D13 swaps the web framework and the Shopify app library (Remix v2 → React Router 7; `@shopify/shopify-app-remix` → `@shopify/shopify-app-react-router`) without altering any boundary this review assessed: Shopify-native vs custom is untouched; no framework, queue, service or database is added; financial determinism and the money primitives are framework-independent; inbound webhook idempotency stays with our receiver by explicit decision (§2.1); authn/authz, privacy and scopes are unchanged; recurring cost is unchanged (§7 — same single process, same Fly configuration, same ~$50–110/mo). The re-verification obligation it creates is recorded in §9 and in the slice 0 spec's Deferred verification list.
