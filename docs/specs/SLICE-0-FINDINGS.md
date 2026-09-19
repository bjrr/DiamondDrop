# Slice 0 — Deferred Findings Register

## Status

Output of the **slice 0 acceptance review** (Principal Architect, 2026-09-14) against commit `81a5106` on `slice-0-foundation`, reviewed under `docs/specs/SLICE-0-FOUNDATION.md`.

Slice 0 verdict was **ACCEPT WITH CONDITIONS**. Three conditions (C-1, C-2, C-3) are being fixed now and are listed under "Resolved / in flight" below. **Slice 1 is cleared to begin.**

This document exists so that nothing deferred at slice 0 acceptance is lost. It is not a wish list: every item below is either a defect in shipped code or a contract a later slice must honour, and each carries an explicit gate. An item may only be closed by the slice that owns its gate, or by an architect decision recorded here.

## How to use this

- **Before a slice's feature spec is written**, read the section for that slice's gate and fold those items into the spec's acceptance criteria. They are inherited requirements, not optional extras.
- **Severity** reflects business/financial/privacy impact, not effort.
- **Real defect** = wrong behaviour or a missing guard in code that shipped. **Contract** = the code is correct today, but a later slice will break it unless it is told not to.
- Items are numbered F-n from the acceptance review. F-20 to F-22 were split out of the review's §4 ruling when this register was created; the numbering is otherwise the review's.

> **`file:line` references — note added 2026-09-15 (D13).** Every `Where` cell below was written against commit `81a5106`, before the Remix v2 → React Router 7 migration. React Router 7 framework mode keeps the `app/` route-module convention, so **file paths are expected to survive**; **line numbers may have shifted**, most likely in the route modules and the app entry/root files, and least likely in `domain/` (which imports nothing from the web framework). Treat a `file:line` reference as a pointer to the **named symbol**, and re-locate it if the line no longer matches. A line number that no longer lands on the described code is a stale citation, **not** evidence that the finding was fixed — an item is closed only by the slice that owns its gate, or by an architect decision recorded here. No finding in this register was resolved by the framework migration; the only entry D13 touches is A1, which was already closed.

---

## Gate: before slice 1 lands pricing code

Slice 1 is the cost libraries + Buy Now pricing engine. These four exist because slice 1 is the first code to do arithmetic that becomes a price.

| ID | Sev | Where | Item | Kind |
|---|---|---|---|---|
| F-1 | Medium | `app/scripts/check-money-safety.mjs:16`, `app/.eslintrc.cjs:30-38` | The money-safety scan does not satisfy acceptance criterion 6's first clause | Real defect |
| F-9 | Medium | `app/app/domain/money/money.ts:99-103` | `multiplyByDecimal` — the method the pricing engine will use for every margin application — has no test | Real defect |
| F-10 | Medium | `app/app/domain/evidence/canonicalJson.ts:61-71` | Evidence payloads accept JS `number`; slice 1/6 will put cost data in them | Contract |
| F-16 | Low | `app/prisma/schema.prisma` (header comment) | The BIGINT-minor-units + CHAR(3) money convention is described but never demonstrated | Contract |

**F-1 detail.** Criterion 6 reads "finds no float arithmetic **and** no ad-hoc `Math.round` on monetary values." The scan is a text regex `/Math\.(round|floor|ceil)\s*\(/g` and satisfies only the second clause. It misses `Math.trunc`, `Math["round"](x)`, aliasing (`const r = Math.round`), `~~x` / `x|0` / `x>>0`, `.toFixed(2)`, `parseFloat`, unary `+`, `Number(bigint)` above 2^53 — and, most importantly, plain float arithmetic: `price * 1.08` and `total / 3` are invisible to it. It also skips every `*.test.ts` (line 31). The ESLint rule has the same blind spots plus one more: `[callee.object.name='Math']` does not match computed member access. Criterion 6's first clause *is* in fact satisfied — by `Money`'s bigint type boundary and decimal.js, not by the scan. Record it that way rather than crediting the scan.
**Fix:** add `toFixed(`, `parseFloat(`, `Math.trunc(`, `~~` to the pattern, allow-listing `app/app/domain/money/rounding.ts` (line 27 calls decimal.js's own exact `toFixed`, which is unrelated to `Number.prototype.toFixed`).
**D13 note (2026-09-15):** this is the one item in the register whose `Where` may change **file**, not just line — the React Router migration may move ESLint to a flat `eslint.config.js`. If `.eslintrc.cjs` no longer exists, the rule and its `[callee.object.name='Math']` blind spot moved with it; F-1 stays open either way. `check-money-safety.mjs` is framework-independent and should be unchanged. Slice 1 must confirm both guards still run in CI before relying on them.

**F-9 detail.** Also untested: `negate()`, `sumMoney`'s happy path, `fromDecimalMajorUnits` with a non-100 `minorUnitsPerMajorUnit`, and `allocate` with a zero weight among non-zero weights. (The zero-weight case is correct by construction — a zero weight always has remainder 0, and leftover is provably ≤ the count of non-zero remainders, so a zero-weight part can never receive a cent. Pin it with a test rather than leaving it as an unwritten proof.) The slice 0 spec named money and idempotency as the two modules that must be thoroughly covered; this is the one real gap in that promise.

**F-10 detail.** `canonicalJsonStringify` permits any finite JS `number`. Correct for counts, indices and tier numbers. But slice 6's `campaign_snapshot` freezes cost inputs, and a gram weight or a price-per-gram stored as a `number` reintroduces binary float into a money-adjacent evidence path that neither the scan (F-1) nor the `Money` type boundary can see, in a row that is append-only and will be used as refund evidence.
**Fix:** document the convention on `app/app/domain/evidence/snapshot.ts` — any decimal quantity in an evidence payload is a `Money` or a decimal **string**, never a `number` — and hold slice 1 and slice 6 to it in review.

**F-16 detail.** Nothing notes that Prisma maps `BigInt` to a JS `bigint` that `JSON.stringify` refuses. Slice 1 will copy whatever pattern it finds. Add a commented example model.

---

## Gate: before slice 3 (Luxury Steals)

| ID | Sev | Where | Item | Kind |
|---|---|---|---|---|
| F-6 | Medium | `app/app/domain/evidence/acknowledgment.ts` | Nothing relates `acknowledgment.exactText` to the referenced `policyVersion.text` | Contract |

A caller can record an acknowledgment citing a policy version whose text bears no relation to what was actually displayed. This is probably intentional — a Luxury Steals Final Sale modal shows a specific excerpt, not the whole policy — but it is undocumented, and slice 3's Final Sale evidence is the first thing to depend on the answer. Decide once, in the slice 3 spec: either `exactText` must be a substring of the referenced version's text (enforced), or the divergence is deliberate and staff review tooling must display both side by side. Do not let slice 3 settle it implicitly by whatever it happens to write.

---

## Gate: before slice 4 (Buy Now RMA — the first slice that moves money)

These four are the highest-value items in this register. Slice 4 is the first caller of `executeIdempotent` against a real value-moving operation.

| ID | Sev | Where | Item | Kind |
|---|---|---|---|---|
| F-5 | **High** | `app/app/domain/idempotency/executeIdempotent.ts:84` | The replay path returns a JSON-deserialized echo typed as `TResult` | Real defect |
| F-20 | Medium | `executeIdempotent.ts` (read-back branch), `app/app/db/repositories/idempotencyKeyRepository.server.ts:81-86` | In-flight and crashed pending keys are collapsed into one error type and one staff queue | Real defect |
| F-21 | Medium | `executeIdempotent.ts` (catch branch) | The "operation succeeded but `recordSuccess` threw" path is neither documented nor tested | Real defect |
| F-22 | **High** | `app/tests/integration/idempotency/idempotency.test.ts:20`, `app/app/domain/idempotency/executeIdempotent.test.ts:27-30` | No test in the suite can detect F-5 | Test gap |

**F-5 detail.** `return existing.resultPayload as TResult` returns whatever `jsonb` deserialized to, under the same static type the first call returned. *Failure scenario:* a slice 8 refund result carries a `Money`; the first call returns a real `Money`, the retry returns a prototype-less `{amountMinorUnits, currency}`, and `result.refund.add(...)` throws **only on the replay path** — the path that is hardest to test and only runs in production, during a retry, while moving money. Worse: a raw `bigint` anywhere in the result makes `recordSuccess` throw (`idempotencyKeyRepository.server.ts:41-50`) *after* the external call already succeeded, which is precisely the duplicate-value hazard the wrapper exists to prevent.
**Fix:** constrain `TResult` to a JSON-safe type, or take explicit `serialize` / `deserialize` functions on the wrapper.

**F-20 detail.** This is half 2 of the architect ruling now recorded in full in `executeIdempotent.ts`'s doc comment. Half 1 — never auto-retry a pending key, and no later slice may add an age threshold that re-executes one — is **upheld permanently and is not an open item**; it is stated here only so that closing F-20 is never mistaken for licence to change it. Required change: distinguish in-flight from crashed by the existing `createdAt` age; throw two distinct error types (in-flight = transient, caller may back off and re-poll, not surfaced to staff; in-doubt = crashed or classified `in_doubt`, staff review required); **neither executes the operation**; `findPendingIdempotencyKeys()` filters to `in_doubt` plus `pending` older than the threshold. *Why it matters:* two calls a second apart during a staff double-click currently enter the manual-review queue needing no review. Once slice 8 batches Group Buy equalization refunds across a whole campaign, that noise is what makes staff stop reading the queue — and the queue is where the genuinely in-doubt refunds live.

**F-21 detail.** If `recordSuccess` throws after the operation succeeded, the catch classifies the *persistence* error, defaults to `in_doubt`, and if `recordInDoubt` also fails the row stays `pending`. That is the correct safe direction — an unresolved key blocks rather than duplicates — but relying on undocumented, untested behaviour in the one function that guards every refund is not acceptable once real money flows. Document and test both sub-cases.

**F-22 detail.** `idempotency.test.ts:20` asserts `toEqual` on a plain `{refundId: string}`, which is already JSON-identical; the unit fake at `executeIdempotent.test.ts:27-30` stores the object by reference and so round-trips perfectly by construction. The entire F-5 problem is therefore invisible to the suite. This is the clearest instance in the codebase of a test that would pass against a broken implementation, and it sits on the most safety-critical function in the system.
**Fix:** an integration test whose result payload contains a `Date` and a `Money`, asserting the replayed value is *usable* (arithmetic on it succeeds), not merely structurally equal.

---

## Gate: slice 2 deploy task (operational, not code)

| ID | Sev | Where | Item | Kind |
|---|---|---|---|---|
| F-7 | Medium | `app/prisma/migrations/20260914000000_append_only_evidence_truncate_triggers/migration.sql`, `app/app/lib/env.server.ts:16` | The append-only triggers only bind if the runtime DB role is not the table owner | Contract |

The migration says so itself, correctly. But there is a single `DATABASE_URL`, and `prisma migrate deploy` needs DDL, so as configured on Fly the runtime role will be the table owner and can `DROP TRIGGER` and then `DELETE`. Today the append-only guarantee is documentation, not enforcement.
**Fix (deploy configuration, no code):** provision a separate migration role holding DDL; grant the runtime role `INSERT` and `SELECT` only on `policy_version`, `acknowledgment`, `snapshot` and `audit_event`. Must be in place before any production data exists.

---

## Gate: slice 2 React Router configuration (added 2026-09-15 from the D13 migration review)

Three configuration items are correct to omit for slice 0 and become live when `@shopify/shopify-app-react-router` lands. Full reasoning in `docs/ARCHITECTURE-MVP1.md` §2.1; the failure each one causes is recorded here because this register is what gets read before a slice starts.

| ID | Sev | Where | Item | Kind |
|---|---|---|---|---|
| F-23 | **High** | `app/react-router.config.ts` | `allowedActionOrigins` unset, so React Router 7's cross-origin action guard runs with an empty allowlist | Contract |
| F-24 | Low | `app/tsconfig.json:3` (`exclude`), `app/package.json` (`typecheck`) | No route typegen: `.react-router` excluded, no `rootDirs`, no `react-router typegen` step | Contract |
| F-25 | Low | `app/package.json` (`vite@5.4.21`) | Vite 5 has no `server.allowedHosts`, which the `shopify app dev` tunnel generally needs | Contract |

**F-23 detail.** This is the one with teeth, and it is the only genuinely new *behaviour* the Remix v2 → React Router 7 migration introduced. `throwIfPotentialCSRFAttack` rejects any mutation-method request to a route **with a default export** whose `Origin` host differs from `request.url`'s, returning 400 before the action runs. The config key defaults to `false`, which the runtime coerces to an empty array — **unset means "on with no exemptions", not "off"**. Resource routes (no default export) are exempt, which is the only reason slice 0's four routes are unaffected; nothing about slice 0 was designed around it. Slices 3, 4, 5, 9 and 10 all POST App Proxy forms from the storefront domain to the app host, so a form route that also renders UI will 400 **before any validation, before any evidence or acknowledgment row, and before any `logger` call of ours runs** — "warranty claims sometimes vanish and there is nothing in the logs", in a slice that handles money and legal acknowledgments.
**Fix:** per route, either keep the POST endpoint a resource route, or add `allowedActionOrigins: ["caratforus.com", "*.myshopify.com"]`. The choice must be explicit in the slice's feature spec — dev-server testing never triggers the guard, so "it worked locally" is not evidence.

**F-24 detail.** Current route modules use `LoaderFunctionArgs`/`ActionFunctionArgs` and typecheck cleanly, so this is not a defect. It matters only if slice 2 adopts Shopify's template style, which imports generated `+types/*` route types; those need `"rootDirs": [".", "./.react-router/types"]` and a typegen step ahead of `tsc --noEmit`. Decide deliberately. Half-adopting the template produces type errors that read like a broken install.

**F-25 detail.** `vite@5.4.21` is inside `@react-router/dev@7.18.3`'s peer range (`^5.1.0 || ^6 || ^7 || ^8`), so nothing is broken today. Flagged so the Vite major lands as planned slice 2 work rather than as a blocker discovered on the day D1 (development store) is resolved.

---

## Gate: before slice 2 wires the Shopify price sync

Added 2026-09-17 from the slice 1 QA review (T10). These are not slice 1
defects — slice 1 deliberately never calls Shopify — but each becomes live the
moment slice 2 does.

| ID | Sev | Where | Item | Kind |
|---|---|---|---|---|
| F-26 | High | `app/prisma/schema.prisma` (`master_variant.lastSyncedPriceCalculationId`), read at `app/app/jobs/pricing/runRecalculation.server.ts` | The compare-and-set anchor is declared and READ but never WRITTEN anywhere. Until slice 2 populates it, `decideSync` always sees `lastSyncedPrice: null` and always returns `needs_approval` — so the entire auto-apply path is dead code in production | Contract |
| F-27 | High | `app/app/jobs/pricing/ports.ts`, `runRecalculation.server.ts` | Nothing calls `ShopifyPriceSyncPort.applyVariantPrice`. An intent reaching `approved` is cleared for sync but no sync occurs. Slice 2 must move `approved -> syncing -> synced` on a real call, and must re-check `isPlaceholderProfile` immediately before the call rather than trusting the status alone | Contract |
| F-28 | Medium | `app/app/jobs/pricing/runRecalculation.server.ts` | A variant whose `bandId` does not resolve to one of its product's bands now throws, failing that variant every run. Correct — pricing off the wrong band is worse — but there is no operator surface to discover or repair such a variant. Slice 2's admin UI should surface persistently failing variants | Contract |

## Contracts created by slice 1

Folded in 2026-09-19 at slice 1 T11 from `docs/specs/SLICE-1-PRICING.md` §12,
which is now closed. **This register is the authoritative copy** — a later
slice's spec author is directed here, not to a closed slice spec.

These are not defects. Each is a promise slice 1 makes to a later slice, and
each becomes live the moment its gate slice starts.

| ID | Gate | Contract | Kind |
|---|---|---|---|
| C-S1 | **Slice 6** | Implement `OpenCampaignExclusionSource` so variants in an open campaign are excluded from Buy Now recalculation (R17). The no-op shipped in slice 1 is correct **only** while no campaign table is wired into the job | Contract |
| C-S2 | **Slice 2** | Implement `ShopifyPriceSyncPort` over `productVariantsBulkUpdate`; honour the `lastSyncedPriceCalculationId` compare-and-set; no JS `number` price anywhere between `Money` and the GraphQL variable. **Publish the final rounded Regular/Card Price.** See the three notes below — all three are money-consequential | Contract |
| C-S3 | **Slice 6** | A Group Buy `campaign_snapshot` must record `engineVersion`, `pricingProfileVersion`, `roundingRuleId`, `priceEndingRuleId` and `regularCardPriceRuleId` alongside the frozen prices, or a frozen price stops being reproducible — which defeats freezing it (`CLAUDE.md` #7). **No consumer may substitute today's active profile or a hardcoded rule id** | Contract |
| C-S4 | **Slices 4 and 8** | Refunds, restocking and merchandise credit are computed from **what the customer actually paid** — the Shopify order line and its purchase snapshot — never from `price_calculation`. `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §4's "eligible merchandise amount" is a historical fact about a transaction, not a current computation. A recalculated price must never reach a refund path | Contract |
| C-S5 | **Standing — every slice adding a price-bearing route** | No cost, margin, supplier or breakdown field on any metafield, Liquid, App Proxy JSON or log (R14). The card **tier rate** and the **rule id** are internal for the same reason (`docs/BANK-CARD-PRICING.md` §6): the storefront receives the two prices they produced, never the rule that produced them | Contract |
| C-S6 | **Standing — every slice adding a customer-facing price surface** | Follow `docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md`: Buy Now collection/search leads with `As low as` Bank Payment Price; Buy Now PDP uses `Add to Cart` + `Add to Cart with Bank Payment Discount`; cart has one payment mode and offers Card Checkout / Bank Payment Checkout; Group Buy defaults to one Regular/Card price and switches after required Payment Type selection | Contract |

**C-S2 note 1 — publish the card price, not the stored price.** `price_calculation`
stores the **Bank Payment Price**, the lower of the two. Publishing it would
undercharge every card customer by the uplift, on every item, silently. The port
parameter is named `regularCardPrice` so the wrong one does not typecheck; do
not widen it. "Final rounded" is load-bearing — the figure after the $5 ceiling,
never the preliminary uplift.

**C-S2 note 2 — derive from the calculation's OWN profile.** The card price is
deliberately not stored; it is a pure function of the stored bank price and the
rule that governed that calculation. Compute
`deriveRegularCardPrice(row.bankPaymentPriceMinorUnits, row.pricingProfile.fixedCardUpliftRate, row.pricingProfile.regularCardPriceRuleId)`.
Taking the rate or rule id from **today's active profile** would re-price a
historical calculation under a rule that did not exist when it was made — the
same failure C-S3 forbids for campaigns, on the Buy Now path.

**C-S2 note 3 — RESOLVED BY OWNER 2026-09-19.** The auto-apply delta remains
measured **bank-to-bank**. The owner explicitly accepts the small inverted
Regular/Card Price movement that can occur when a Bank Payment Price crosses one
of the locked tier thresholds. Example: bank `$999.99 -> $1,000.00` while
Regular/Card moves `$1,045 -> $1,040`. The Bank Payment Price is still below
its own card price; only the direction of change differs across versions.
Do **not** force manual approval solely because Bank Payment and Regular/Card
prices moved in opposite directions at a tier boundary. This is intentional
behavior of the locked tier schedule, not a defect.

**C-S2 note 4 — auto-publication enablement resolved 2026-09-19.**
Automatic publication remains a separate enablement from the 200 bps tolerance.
Enable it only after the real Shopify synchronization path passes money-critical
integration tests. Thereafter Bank Payment Price changes <=2% may auto-publish;
larger changes require human approval. Common-input batches may be bulk-approved.
Bulk reject is not allowed; item-level rejection requires an override price and
reason. Temporary overrides expire on the next material pricing recalculation
unless marked Never Expire.

**C-S2 note 5 — sync failure behavior resolved 2026-09-19.**
The currently published Shopify price remains authoritative during a failed
replacement sync. Retry automatically; notify by email + persistent admin alert;
do not mark synced before Shopify confirmation. After 48 hours unresolved, make
only the affected variant unavailable and restore it automatically after a
successful sync. A purchase at the live price during that window is valid and
does not receive an automatic retroactive refund merely because a lower price is
published later.

**C-S6 note — owner-updated 2026-09-19.** Price presentation is now
surface-specific. Buy Now collection/search cards may lead with the lowest
currently purchasable **Bank Payment Price** as `As low as $X` without showing
the card price on the card. Detailed Buy Now product/cart views show the exact
Regular/Card Price, Bank Payment Price, and merchandise-only savings. Group Buy
comparison/options tables show Regular/Card prices only plus a concise note that
lower pricing is available with Bank Payment; after product options are chosen,
Payment Type is required and the active displayed price switches to Bank Payment
Price only when Bank Payment is selected. Eligible methods are Zelle, ACH, bank
transfer and wire; no paper payments qualify. See
`docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md`.

## Gate: next migration that touches `webhook_event`

| ID | Sev | Where | Item | Kind |
|---|---|---|---|---|
| F-14 | Low | `app/prisma/schema.prisma` (`WebhookEvent.claimedAt`) | `claimed_at` is nullable, and the stale predicate `claimedAt < cutoff` never matches NULL | Real defect (latent) |

A row with a null `claimed_at` would be permanently unreclaimable — stuck in `in_progress` forever, answering 503 to every redelivery until Shopify gives up. No current code path can produce one (`claimWebhookEventForProcessing` always stamps it on insert) and migration `20260914010000` backfills existing rows, so this is latent rather than live. Close it cheaply the next time a migration touches the table: `NOT NULL DEFAULT now()`.

---

## Opportunistic — fix when nearby, do not schedule a slice for them

| ID | Sev | Where | Item | Kind |
|---|---|---|---|---|
| F-2 | Medium | `app/app/domain/evidence/canonicalJson.test.ts:161-181` | No pinned golden hash vector, and no unicode test | Test gap |
| F-3 | Medium | `app/app/db/repositories/snapshotRepository.server.ts:16`, `auditEventRepository.server.ts:20-21` | Evidence rows persist a different serialization than the one that was hashed | Contract |
| F-4 | Medium | `app/app/db/repositories/webhookEventRepository.server.ts:133-138` | `markWebhookEventFailed` can stamp an error onto an already-processed row | Real defect |
| F-8 | Low | `app/tests/integration/webhooks/dedup.test.ts`, `idempotency.test.ts` | Slice 0 spec deferred-verification item 4 is reasoned, not observed | Test gap |
| F-12 | Low | `app/app/lib/validateRequest.server.ts` | The shared zod route helper is unused and untested | Test gap |
| F-13 | Low | `app/app/db/repositories/webhookEventRepository.server.ts:54` | `DEFAULT_STALE_CLAIM_MS = 15 min` is defensible; 5 min is better | Tuning |
| F-15 | Low | `app/tests/integration/db/appendOnlyTriggers.test.ts:28-98` | Trigger tests assert bare `.toThrow()` with no error discrimination | Test gap |
| F-17 | Low | `app/app/shopify/webhooks/receive.server.ts:119-120` | A throw from `markWebhookEventFailed` swallows the handler's own error log | Real defect |
| F-18 | Low | `app/app/shopify/proxy/verify.ts` | The doc comment does not say the signature covers query parameters only, never the body | Contract |
| F-19 | Low | `app/app/db/migrationStatus.server.ts:20-30` | `getMigrationState` cannot report genuinely un-applied migrations | Real defect |

**F-2.** Every stored `content_hash` is meaningful only if `canonicalJsonStringify` never changes behaviour. A future edit to it would silently invalidate every historical hash and **nothing in the suite would fail**, because all existing tests compare two freshly-computed hashes to each other. Add one test asserting a fixed, committed SHA-256 digest for a fixed payload containing nested objects, an array, a `Date`, a `Money` and non-ASCII text. There is also no unicode test at all; add NFC-vs-NFD and a surrogate-pair case. Differing NFC/NFD hashes is *correct* — exact-text preservation is the point — but it should be asserted deliberately rather than left as an accident of `JSON.stringify`.

**F-3.** The hash is computed over the canonical form; the raw in-memory value is what gets written to `jsonb`. They agree today, but incidentally rather than structurally. Recommended fix: persist `JSON.parse(canonicalJsonStringify(payload))` so the stored document *is* the hashed document, and the question stops needing to be re-argued in every later slice. **Downgraded to opportunistic by two things:** the C-2 snapshot round-trip integration test now demonstrates the agreement for the `Date` + `Money` case rather than merely arguing it; and the compliance audit row no longer carries a payload at all — the owner-approved shape is `topic`, `shopDomain`, `shopId`, `customerId`, `orderIds`, `dataRequestId` and a sha256 of the **raw body**, which sidesteps canonicalization entirely for that path. F-3 therefore now applies only to `snapshot.payload` and to `audit_event.before`/`after` rows written by later slices carrying entity state.

**F-4.** *Scenario:* a handler exceeds the stale window; a retry reclaims and succeeds, setting `processedAt`; the original zombie then fails and writes `error` unconditionally. The row reads processed-and-errored. Traced consequence: **no event is lost** — `claimed_retry` requires `processedAt IS NULL` (line 93) and the `already_processed` branch (line 120) still answers 200 correctly. Evidence noise and operator confusion, not a correctness break. Fix is one word: `updateMany` with `processedAt: null` in the `where`.

**F-8.** The four rewritten concurrency tests genuinely prove exactly-once and are a real improvement on what they replaced — the exactly-once assertions now sit first where a later failure cannot mask them, and the latch makes the 503 path deterministic instead of hoping for a scheduling coincidence. The limit, stated precisely: they prove the **decision table** (given a row in state X, the claim function returns Y), because by the time the loser runs the winner's write has committed and the predicates evaluate unambiguously. They do not exercise two `UPDATE ... WHERE` statements contending for the same row lock simultaneously, which is the READ COMMITTED predicate re-evaluation the slice 0 spec's deferred item 4 named. That item is therefore reasoned, not observed — the same status the spec gave it. Closing it needs one test with two distinct Prisma clients and a `pg_sleep` barrier issuing simultaneous conditional UPDATEs.

**F-13.** Assessed and **accepted as defensible**; recorded for tuning, not as a defect. Reclaiming is safe *conditional on handlers being idempotent* — CLAUDE.md requires it but nothing enforces it, so that is a standing contract on every slice that attaches a topic handler. Counter-argument for 5 minutes: a React Router route handler behind Fly is killed by HTTP timeout in well under 60 seconds, so the realistic bound on a live handler is two orders of magnitude below 15 minutes, while a crashed claim currently burns roughly six of Shopify's nineteen retries before the window opens. It is a constant; owner-neutral.

**F-18.** `verify.ts` is correct — Shopify's App Proxy signature genuinely covers query parameters only. But slices 3, 4, 5, 9 and 10 all POST forms through the proxy, and the verified `logged_in_customer_id` is the only trustworthy identity on such a request; a body-supplied customer id must never be trusted. One sentence in the doc comment stops five slices rediscovering this independently. (The separately documented multi-value-parameter limitation at lines 16-20 is fail-safe: a repeated key produces a mismatched message and a rejection, never a false accept.)

**F-19.** The health route reports rows in `_prisma_migrations` with a null `finished_at` — failed or interrupted applications — not migrations present on disk but never applied. A deploy that skipped `migrate deploy` reports `status: "ok"`. The criterion is met in letter; the route will mislead during a deploy incident, which is the one moment anybody reads it.

---

## Resolved / in flight — do not re-open

| ID | Resolution |
|---|---|
| **A1** | **RESOLVED by owner 2026-09-14 (D12); RE-RESOLVED, UNCHANGED IN SUBSTANCE, 2026-09-15 (D13).** Hybrid: adopt **`@shopify/shopify-app-react-router@2.1.0`** — *not* the superseded `@shopify/shopify-app-remix` — for OAuth, session storage and App Bridge; keep `receiveShopifyWebhook` / `claimWebhookEventForProcessing` for inbound webhooks. Prisma `session` model ships in the slice 2 migration. Recorded as **D13** in `docs/ARCHITECTURE-MVP1.md` §2.1 and §12, including the reason the library's `authenticate.webhook` is deliberately not used — read §2.1 before proposing to consolidate onto it, and note that the rename from the Remix library to the React Router library changed nothing about `authenticate.webhook`'s behaviour or about that reasoning. A1 remains **closed**: the framework change altered which library is adopted, not whether the hybrid boundary holds. |
| **F-29** | **RESOLVED 2026-09-19 (verified at slice 1 T11).** Integration tests no longer touch `carat_dev`. `app/tests/integration/globalSetup.ts` creates a per-run disposable database named `carat_it_<pid>_<base36 timestamp>`, migrates it, and drops it `WITH (FORCE)` in teardown; `KEEP_TEST_DATABASE=1` retains it for inspection, and a failed drop warns rather than failing a green run. The accumulated `pricing_profile` rows that motivated the finding can no longer be created, so the D14 placeholder guard now demonstrates itself in `carat_dev` as intended. The finding as originally written is stale and must not be re-raised. |
| **C-1** | In flight. GDPR compliance handler no longer writes customer PII into the append-only `audit_event` table. Owner-approved row shape: `topic`, `shopDomain`, `shopId`, `customerId`, `orderIds`, `dataRequestId`, and a sha256 of the raw body — no payload. |
| **C-2** | In flight. `app/tests/integration/evidence/snapshotRoundTrip.test.ts` closes slice 0 spec deferred-verification item 5 (write a snapshot containing a `Date` and a `Money`, read it back, re-hash, assert `contentHash` still matches). This also gives `snapshotRepository` its first test coverage of any kind. |
| **C-3** | In flight. `/health` no longer echoes raw Prisma error text (which embeds DB host, port and user) on an unauthenticated route. |
| **F-11** | In flight. `logger.server.ts` redaction now traverses arrays, so `{items:[{apiKey:"…"}]}` is redacted. |

### Process guard — mutation testing against a shared tree

Recorded 2026-09-15 after it cost real time and produced a false alarm.

Falsifying a test by temporarily editing production code is a practice worth keeping — it is the only way to know a test can actually fail, and it is how `httpServer.test.ts` was shown to detect body re-encoding rather than merely passing. But while the mutation is applied, **the working tree is genuinely broken, not apparently broken**, and anyone observing it reaches a correct conclusion from incorrect premises.

Both failure modes occurred during the D13 migration, from a single mutation of `receive.server.ts:49`:

- The reviewing architect saw HMAC input mutated and 12 red integration tests covering webhook authentication, and escalated to stop the commit. That was the correct response to the evidence available — a reviewer should raise this loudly rather than assume a benign explanation.
- The operator who *applied* the mutation ran a gate sweep during the same window and misattributed the 12 failures to database lock contention, because a second agent's test run happened to be overlapping. This is the more insidious half: the window corrupts the signal of the person who created it.

**The guard:**

> Mutation testing that edits tracked source must be **announced before the edit and confirmed after the revert**, and must not overlap another agent's gate run against the same working tree or database. The sequence is: announce → mutate → observe → revert → re-run gates → confirm reverted.

A related hazard worth stating: the integration suite is **not safe to run concurrently against one database**. Two simultaneous runs contend on `webhook_event` row locks and surface as ~20s timeouts on precisely the concurrency tests, which looks identical to a genuine dedup defect.

### Verified, not defects — recorded so they are not re-derived

Findings from the D13 migration review (2026-09-15) that required no action. They are here because each is a property someone could reasonably doubt later, and re-establishing them costs more than reading this.

- **Boot-order fail-fast survives bundling (acceptance criterion 21).** `import "~/lib/assertEnvOnBoot.server"` being the first statement of `app/app/entry.server.tsx` is a *source* property; a bundler is free to reorder side effects, so criterion 21 is not self-evidently preserved by reading the file. Verified against the built artifact instead: in `app/build/server/index.js`, `loadEnv()` executes at **line 55**, while `new PrismaClient({…})` is at **line 169** and the route modules later still. Nothing meaningful runs before the env assertion. Re-check this if the bundler, its config, or the entry module's import graph changes — not on every build.
- **Raw-body integrity through the HTTP stack.** HMAC-over-raw-bytes is verified end to end, not only through directly-constructed `Request` objects. Two independent lines: `@react-router/express` hands the unread Node socket stream to `init.body` with `duplex: "half"` and `@react-router/serve` registers no body parser (only `compression`, `express.static` and `morgan`); and a live signed POST with a deliberately **multi-byte** body (195 bytes / 189 characters) returned 200 against both the built and dev servers. The multi-byte part is load-bearing: a valid HMAC over an **ASCII** body proves the body was not re-*parsed* but cannot detect a re-*encoding* bug, because ASCII round-trips through a UTF-8/latin1 confusion unchanged. Any future HTTP-level regression test must use a non-ASCII body for this reason.
- **`Response.json()` vs Remix's `json()`.** Assessed and accepted. Status codes and body shape are identical; `Response.json()` omits the `charset=utf-8` content-type parameter that Remix's helper set, which production regains from the express layer and the dev server does not. The parameter is undefined for `application/json`, so there is no client impact. Not a defect; recorded to stop it being re-reported.

### Corrections to the slice 0 spec itself

Recorded here because they are documentation debt created by this review, not code items:

- **Acceptance criterion 13** of `docs/specs/SLICE-0-FOUNDATION.md` names `X-Shopify-Event-Id`. Shopify does not document that header. The implementation correctly uses `X-Shopify-Webhook-Id`, which Shopify documents as stable across retries of the same event — the only property dedup can rely on. **The code is right and the criterion's wording is wrong.** `docs/ARCHITECTURE-MVP1.md` §5 has been corrected; the slice 0 spec's criterion 13 should be amended the next time that file is touched.
- **Acceptance criterion 20** (`docker-compose up` + migrate + seed + `dev` from a clean checkout) is **partially verified**: `app/README.md:19-50` documents both the Docker and no-Docker paths, but only the no-Docker path was ever exercised, because Docker Desktop requires the WSL2 backend which was unavailable on the build machine. The Docker path should be run once on a machine that has it, before it is relied on in onboarding. Do not record criterion 20 as fully verified until then.
- **Framework change, 2026-09-15 (D13).** `docs/specs/SLICE-0-FOUNDATION.md` §0.1 and §0.2 have been amended with a dated correction note: the shell is **React Router 7 (`react-router@7.18.3`)**, not Remix v2. No acceptance criterion changed — none names the framework. The spec's Deferred verification list gained **item 7**: items 1–6 must be re-proven on the React Router build, because a green Remix-era run does not carry over. **Nothing in this register is closed by that migration.** The two criterion-level caveats above (13 and 20) are both still outstanding and are unaffected by it.
