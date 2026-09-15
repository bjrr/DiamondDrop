# Feature Spec — Slice 0: Foundation

## Status
**ARCHITECT-APPROVED. CLEARED FOR IMPLEMENTATION.**
Owner approved the architecture and Phase 1 on 2026-09-13.
Controlling architecture: `docs/ARCHITECTURE-MVP1.md`.
Assigned to: **Backend & Pricing Engineer (`sonnet`)**. Architect review required before slice 1 begins.

---

## Outcome

Establish the technical foundation that every later CaratForUs MVP1 slice depends on: the repository layout, the application service skeleton, the database with migrations, the money primitives, the versioned-evidence core (policy versions, acknowledgments, snapshots, audit events), the two safety edges that protect money (inbound webhook authenticity + deduplication, outbound operation idempotency), and CI. This slice ships **no customer-facing feature and no business rules** — it ships the primitives that make the business rules provably correct later. Its value is that slices 1–13 can then be implemented and tested without any of them re-inventing money handling, evidence retention, or idempotency.

## Authoritative requirements

| Rule | Source |
|---|---|
| Never use binary floating point for money; integer minor units or decimal | `CLAUDE.md` Engineering principles #6 |
| Financial calculations deterministic, auditable, versioned, test-protected | `CLAUDE.md` #5 |
| Verify Shopify webhook authenticity; make event processing idempotent | `CLAUDE.md` Security and privacy; `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §12 |
| Duplicate/retried refund, credit, warranty-remedy, or promotional-benefit processing must not create duplicate customer value | `README.md` §Customer Acknowledgment / Evidence Architecture; `docs/LUXURY-STEALS.md` §Evidence and Auditability; `docs/WARRANTY-CLAIMS.md` §11.10; `docs/LET-US-BEAT-YOUR-QUOTE-AMENDMENT.md` §3 |
| Acknowledgments: exact text, version, timestamp, affirmative action, references; never pre-checked or silently inferred | `docs/LUXURY-STEALS.md` §Required Customer Disclosure; `docs/LET-US-BEAT-YOUR-QUOTE.md` §Acknowledgment Evidence Requirements; `README.md` §Customer Acknowledgment |
| Later edits to live product/policy/design pages must not overwrite historical transaction evidence | `README.md` §Customer Acknowledgment / Evidence Architecture |
| Preserve exact policy/version applicable at purchase; immutable product/configuration snapshots | `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §12 |
| Least-privilege scopes; minimize PII; never expose admin-only cost/margin data to storefront | `CLAUDE.md` #10, Security and privacy |
| Never collect/store raw payment-card data | `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §12 |
| Stack, layout, providers, env vars | `docs/ARCHITECTURE-MVP1.md` §2, §4, §7 |

## Native Shopify vs custom boundary

**Native Shopify (not built here, not wrapped, not abstracted away):** cart, checkout, payments, taxes, customer accounts, orders, inventory, order notification emails, refund execution.

**Custom (built here):** the application service shell, persistence, money primitives, evidence core, webhook verification/dedup, outbound idempotency, CI.

**Explicitly not built here:** any pricing logic, any Group Buy logic, any RMA/warranty/quote logic, any storefront or theme code, any admin screens beyond a health/status page, any calls to the Shopify Admin API. Those belong to later slices. Build the primitives; do not anticipate the domains.

---

## Scope and deliverables

### 0.1 Repository layout
```
/app          Node 20 + TypeScript service (Remix, Shopify app template)
/theme        placeholder only this slice (README stub; slice 2 populates it)
/docs         existing requirements, policies, architecture, specs
```
Root `.gitignore` must cover `node_modules`, `.env`, `.env.*` (except `.env.example`), build output, and coverage. **Never commit secrets.**

### 0.2 Application skeleton
- Node 20, TypeScript strict mode, Remix via the official Shopify app template.
- Module layout inside `/app` separating `domain/` (pure functions, no I/O), `db/`, `shopify/`, `routes/`, `jobs/`, `lib/`.
- A health route returning service status and migration state. No other UI this slice.
- Structured logging (business events + references only — never secrets, never payment data, never cost/margin data).
- Server-side input validation with `zod` at every route boundary, including routes added later — provide the shared helper.

### 0.3 Database and migrations
- Prisma + Postgres, `prisma migrate` forward-only.
- Local Postgres via `docker-compose.yml`.
- Tables in this slice only: `policy_version`, `acknowledgment`, `snapshot`, `audit_event`, `webhook_event`, `idempotency_key`. Do **not** create the pricing, campaign, RMA, warranty, or quote tables — those ship with their own slices so their shape is driven by their own policy reading.
- Money columns, wherever they appear in later slices, use `BIGINT` minor units plus a `currency` CHAR(3). Establish the convention and a documented Prisma pattern here.

### 0.4 Money primitives (`domain/money`) — highest-value deliverable
- A `Money` representation of **integer minor units + currency**. Arithmetic is integer-only. No JavaScript `number` float arithmetic anywhere in the path.
- Cost-side intermediate math (e.g. metal price per gram × grams) uses `decimal.js` at a fixed, documented scale, converting to `Money` only at an explicit, named rounding boundary.
- **Rounding is centralized and versioned.** Provide a named rounding rule registry; MVP1 default is `HALF_UP` at the cent, identified by a stable rule id that later pricing profiles reference. No ad-hoc `Math.round` anywhere in the codebase.
- Guard rails: currency mismatch in any operation throws; division requires an explicit rounding rule argument; allocation/splitting must be remainder-exact (the parts sum to the whole with no lost or invented cents).
- Serialization to and from the database and JSON is lossless and never passes through a float.

### 0.5 Evidence core (`domain/evidence`)
- `policy_version`: slug, version, `effective_from`, full exact text, content hash.
- `acknowledgment`: exact displayed text, `policy_version_id`, timestamp, affirmative action label, and nullable reference columns (customer, order, cart, campaign, submission, product, variant). Writing an acknowledgment **requires** the exact text and a policy version — the API must make it impossible to record one without them. There is no "default true," no pre-checked state, and no inference: the write API takes an explicit affirmative action and refuses anything else.
- `snapshot`: typed kind, canonical JSON payload, content hash, created-at.
- `audit_event`: actor (staff id / system / customer ref), action, entity type + id, before/after, reason, timestamp.
- **Content hashing** uses SHA-256 over canonical JSON with stable key ordering, so an identical payload always hashes identically.
- **Append-only enforcement at the database level.** `policy_version`, `acknowledgment`, `snapshot`, and `audit_event` get a Postgres trigger that raises on `UPDATE` and `DELETE`. Application-level discipline alone is not sufficient — historical transaction evidence must survive a later bug or a careless migration. The repository layer exposes create and read methods only; no update, no delete.

### 0.6 Inbound edge — webhook authenticity and deduplication (`shopify/webhooks`)
- HMAC-SHA256 verification against the **raw, unparsed request body** using the app secret, compared with a timing-safe comparison. A route that parses the body before verifying is a defect.
- Failed verification: reject with 401, log the attempt, **never** process.
- Deduplication on the Shopify delivery id via a UNIQUE constraint on `webhook_event.shopify_event_id`. **Corrected 2026-09-13:** the header is `X-Shopify-Webhook-Id`, not `X-Shopify-Event-Id` as originally written here — Shopify documents `X-Shopify-Webhook-Id` as stable across retries of the same event, which is the property dedup requires. Keep it in a single named constant.
- Rely on the unique constraint, not a read-then-write check — concurrent delivery of the same event must not both pass.
- Persist the event before processing; record processed-at and any error so a failure is retryable and visible.
- **Dedup must key on successful processing, not mere existence.** A replayed delivery whose prior attempt *failed* must be reprocessed, not swallowed as a duplicate. Returning 500 on a handler error causes Shopify to retry; if that retry is then discarded because a row exists, the event is lost permanently. Only an event already marked processed may short-circuit.
- Register handler plumbing only. **No topic handlers with business logic** — later slices attach theirs.
- Implement the three mandatory Shopify compliance webhook topics (`customers/data_request`, `customers/redact`, `shop/redact`) as verified, audited, recorded stubs that acknowledge correctly.

### 0.7 Outbound edge — money-operation idempotency (`domain/idempotency`)
Per `docs/ARCHITECTURE-MVP1.md` §6.7, Shopify's `refundCreate` has no generic idempotency token, so idempotency is ours. Provide a reusable wrapper used by **every** future value-moving operation (refund, merchandise credit, discount/benefit issuance):
1. Commit a UNIQUE `idempotency_key` row **before** the external call.
2. Perform the operation.
3. Record the result against the key.
4. A retry with the same key returns the stored result and performs **no** second external call.
5. A key that exists but has no recorded result (crash mid-flight) surfaces as an explicit in-doubt state for staff review — it must never silently retry the money movement.
6. **A failure must distinguish "definitely did not happen" from "unknown".** A definitive rejection from the provider (validation error, explicit error response) may be recorded as `failed`. A network timeout, aborted connection, or ambiguous 5xx must be recorded as **`in_doubt`**, because the operation may have succeeded at the provider before the response was lost. Recording an ambiguous failure as `failed` invites staff to retry with a fresh key, which is precisely how duplicate customer value gets created.

This wrapper is the single most important safety property in the system. Build it generically, test it hard, and do not couple it to any one domain.

### 0.8 App Proxy signature verification (`shopify/proxy`)
Shared verifier for Shopify App Proxy requests (sorted query parameters, HMAC-SHA256, timing-safe compare), exposing the verified `logged_in_customer_id` when present. No proxy routes are added this slice — later slices use the verifier.

### 0.9 Configuration
- `.env.example` documenting every variable from `docs/ARCHITECTURE-MVP1.md` §7, with placeholder values only.
- Startup validation that fails fast and loudly on missing or malformed required configuration.
- Secrets are read from the environment only. Never hardcoded, never logged, never committed, never rendered into any response.

### 0.10 CI
GitHub Actions running, on every push and PR: install → typecheck → lint → unit tests → integration tests (against a Postgres service container) → build. All must pass.

---

## Acceptance criteria

**Money**
1. Adding, subtracting, multiplying and allocating `Money` values produces exact integer-minor-unit results with no floating-point drift.
2. Splitting an amount into N parts returns parts that sum **exactly** to the original — no lost cent, no invented cent.
3. An operation mixing two currencies throws rather than producing a result.
4. Division or conversion without an explicit rounding rule is a compile-time or runtime error, not a silent default.
5. The rounding rule is identified by a stable versioned id, and changing rules is a deliberate, visible act.
6. A repository-wide check finds no float arithmetic and no ad-hoc `Math.round` on monetary values.

**Evidence**
7. An acknowledgment cannot be written without exact text, a policy version, a timestamp, and an explicit affirmative action.
8. `UPDATE` or `DELETE` against `policy_version`, `acknowledgment`, `snapshot`, or `audit_event` fails **at the database level**, not merely in application code.
9. Editing a live policy creates a new `policy_version`; acknowledgments already recorded against the prior version still resolve to the exact text that was displayed at the time.
10. Identical snapshot payloads hash identically; any payload difference changes the hash.

**Webhooks**
11. A request with a valid HMAC over the raw body is accepted; an invalid or absent HMAC is rejected with 401 and never processed.
12. A body modified after signing fails verification.
13. Delivering the same `X-Shopify-Event-Id` twice processes it once; the second delivery is recorded as a duplicate and does no further work.
14. Two concurrent deliveries of the same event id result in exactly one processed record (unique-constraint enforced, not read-then-write).
15. The three mandatory compliance topics verify, record, audit, and acknowledge correctly.

**Idempotency**
16. Two calls with the same idempotency key perform the underlying operation once and return the same stored result.
17. A key committed with no recorded result surfaces as in-doubt for staff review and does **not** auto-retry the operation.
18. Concurrent calls with the same key do not both execute the operation.

**App Proxy**
19. A correctly signed proxy request verifies and exposes `logged_in_customer_id` when present; a tampered or unsigned request is rejected.

**Operational**
20. `docker-compose up` + migrate + seed + `dev` runs locally from a clean checkout following the README, with no Shopify credentials required.
21. Startup fails fast with a clear message when required configuration is missing.
22. CI passes end to end on a clean checkout.
23. No secret, cost, or margin value appears in any log line, response body, or committed file.

---

## Data / integration impact

- **Migrations:** initial Prisma migration creating the six tables in §0.3 plus the append-only triggers in §0.5.
- **Shopify API scopes:** none requested or exercised this slice. Scope configuration is written into `shopify.app.toml` per `docs/ARCHITECTURE-MVP1.md` §5 but not yet used.
- **Webhooks:** verification and dedup plumbing plus the three compliance topics. No business topics subscribed yet.
- **Metafields/metaobjects:** none.
- **Env vars:** the full set from `docs/ARCHITECTURE-MVP1.md` §7, documented in `.env.example`.
- **Manual Shopify setup:** deferred — see Open decisions.

## Security / evidence requirements

- Webhook verification precedes body parsing, always.
- All route input validated server-side with `zod` regardless of any client-side validation.
- Evidence tables append-only at the database level.
- No raw card data is accepted, stored, or logged — there is no code path that could.
- No supplier cost, margin, or admin-only data is exposed through any non-admin route (none exist yet; the boundary is established now).
- Logs carry business events and references only.
- PII minimized: reference Shopify customer/order IDs rather than duplicating customer profiles.

## Test plan (write these before or alongside the code)

- **Unit (Vitest):** money arithmetic, allocation remainder-exactness, currency mismatch, rounding-rule registry and versioning, canonical JSON hashing determinism, acknowledgment construction rules.
- **Integration (Vitest + real Postgres):** append-only trigger enforcement on all four evidence tables; webhook HMAC accept/reject with recorded fixtures carrying valid and invalid signatures; webhook replay dedup including a concurrent-delivery test; idempotency wrapper single-execution, stored-result replay, in-doubt state, and concurrent-call test; App Proxy signature accept/reject.
- **Fixtures:** recorded Shopify webhook payloads with valid and invalid HMACs, committed as test data (no real customer data).
- Coverage expectation: the money and idempotency modules are the ones that must be thoroughly covered. Do not pad coverage on the scaffold.

## Agent ownership

Sole owner this slice: **Backend & Pricing Engineer (`sonnet`)**. No other agent edits these files concurrently — slice 0 is serial per `docs/ARCHITECTURE-MVP1.md` §10. Tests are written by the same agent in this slice because they are inseparable from the primitives; the Test Engineer (`haiku`) takes over table-driven policy tests from slice 1 onward.

## Non-goals

No pricing logic. No Group Buy logic. No RMA, warranty, or quote logic. No theme or storefront code. No admin screens beyond health. No Shopify Admin API calls. No job queue, no Redis, no microservices. No Post-MVP features. No speculative abstraction for domains that have not been specified yet — build what this spec lists and stop.

## Open decisions

- **D1 — Shopify development store and API credentials are not yet provisioned.** This slice is deliberately scoped so that **all deliverables and all tests run without live Shopify credentials**: HMAC verification, proxy signature verification, and dedup are all exercised against fixtures. What is deferred is only the final dev-store install/smoke of the app shell, which is picked up at the start of slice 2. Do not block on D1, and do not invent credentials or call a live store.
- No locked-policy conflict affects this slice. (The `LET-US-BEAT-YOUR-QUOTE` conflict recorded as C1 in `docs/ARCHITECTURE-MVP1.md` §11 affects slice 10 only.)

## Deferred verification — must run before slice 0 is accepted

Slice 0 was implemented in an environment with no Node, npm, or Docker, so **nothing in it has ever compiled or executed**. The code is complete and reviewed; it is not validated. The following must actually run and pass before slice 0 is accepted and before slice 1 begins:

1. Full pipeline: `npm install` → typecheck → lint → `check:money-safety` → unit tests → `prisma migrate` → integration tests → build.
2. **Prisma migration drift.** All four migrations were hand-authored rather than generated by the Prisma CLI. Verify they apply cleanly to an empty database and match what Prisma would generate from `schema.prisma`.
3. **`app/tsconfig.json` `compilerOptions.types`.** Flagged as uncertain by the implementer (DOM vs Node global type resolution). First thing to check when typecheck can run.
4. **Concurrency behavior under real Postgres.** The webhook dedup race, the stale-reclaim race, and the idempotency single-execution guarantee are currently reasoned about, not observed. They depend on READ COMMITTED re-evaluating a conditional `UPDATE` predicate after the row lock releases — correct in principle, unverified in fact.
5. **Snapshot payload round-trip.** `snapshotRepository` and `auditEventRepository` write the raw payload to Prisma's `Json` column, while `contentHash` is computed by our own canonicalizer. Analysis says these agree — Prisma serializes via `JSON.stringify`, which honors `toJSON`, so a `Date` stores as its ISO string and a `Money` as `{amountMinorUnits, currency}`, and re-canonicalizing a value read back from `jsonb` reproduces the same hash. Prove it with an integration test that writes a snapshot containing both a `Date` and a `Money`, reads it back, re-hashes, and asserts the stored `contentHash` still matches. This is the property that makes a snapshot usable as dispute evidence, so it should be demonstrated rather than argued.
6. No lockfile is committed. The first real `npm install` must generate and commit one; CI should then move from `npm install` to `npm ci`.

## Required closing step

Finish with `/handoff`. Flag for architect review: the money primitives and rounding-rule design, the append-only enforcement mechanism, the webhook dedup concurrency behavior, and the idempotency wrapper's in-doubt state handling.
