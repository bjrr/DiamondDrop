# Slice 11 (subset) — Shipment Evidence Record

## Status

**DRAFT — implementation authorized for this subset only.** Scoped by the
Tech Lead directly from `docs/specs/SLICE-11-READINESS.md`'s split: the
portion of slice 11 that needs no owner answer. The two threshold-dependent
rules (R2/R3 there — "insured for full order value," "signature required
above $100") are explicitly **not** covered here; see §5.

Depends on: slice 0 (closed) only, same as the parent slice. Runs
concurrently with slice 5 (warranty claims) under architecture §10's
at-most-two rule; disjoint files — this task does not touch
`app/app/db/repositories/**` or `app/app/jobs/warranty/**`.

## 1. Outcome

Every outbound customer shipment gets one evidence row, recorded by staff at
the point they actually ship it: which carrier, what tracking number, when,
what was insured and how, whether a signature was arranged, and what the
carrier confirmed on delivery. If the shipping address changes after the
order was placed, that change is captured with who changed it, when, and
what it was before and after — never silently overwritten.

This is a recording layer, not a decision layer. Nothing here computes
whether a signature *should* be required, or whether an insured amount is
*enough* — those are the two owner questions from `SLICE-11-READINESS.md`
G1/G2, still open. What staff actually arranged for a given shipment is
recorded as a fact; whether policy required it is a separate, currently
unanswerable question this task must not quietly answer by writing code.

## 2. Authoritative sources

| Area | Source |
|---|---|
| The nine rules, and which three need owner input | `docs/specs/SLICE-11-READINESS.md` — read first |
| The locked rules this task DOES implement (R1, R5, R6, R7) | `README.md` "Shipping, Insurance & Signature — MVP1 Locked Direction" |
| The `shipment` model's field list | `docs/ARCHITECTURE-MVP1.md` §4 |
| The same field list, independently, as RMA dispute evidence | `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §11 "Fulfillment evidence" |
| Evidence/append-only/audit conventions | `docs/specs/SLICE-0-FOUNDATION.md`; migrations `20260913000100`, `20260914000000` |
| Money, delegation, git discipline | `CLAUDE.md` |

## 3. Acceptance criteria

Numbered continuing from slice 5 (last used: 170).

### 3.1 The shipment record

**171.** A shipment row captures carrier, service level, tracking number,
ship date, insured value (money, criterion 173), insurance reference,
whether a signature was arranged, and delivery confirmation evidence — the
field set independently stated in `ARCHITECTURE-MVP1.md` §4 and
`BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §11.

**172.** Tracking is unconditional (README: "every shipment has tracking" —
no threshold, no condition). A shipment row cannot exist without a tracking
number — enforced as a NOT NULL column, not merely a convention, since
nothing in the policy makes it optional.

**173.** Insured value is money: integer minor units plus an explicit
currency, never a float (CLAUDE.md rules 5-6). Present together or absent
together with its currency — a coherence rule, mirroring the pattern
`warranty_claim_remedy_refund_money_coherent` established in slice 5.

### 3.2 Signature: recorded, never derived

**174.** `signatureRequired` (and who decided it, and when) is a fact staff
records about what was actually arranged for a specific shipment. Nothing
in this codebase computes it from an amount. This is not an oversight to be
completed later in this task — it is the explicit boundary from
`SLICE-11-READINESS.md` G1: "order value" is undefined, so nothing can be
compared against it yet.

**175.** No $100 figure appears anywhere in this task's code, comments, or
tests — not as a constant, not as a `TODO: 100`, not as a default. A number
in the codebase becomes the de facto answer to an open owner question; the
absence must be legible as a decision, documented at the natural
enforcement point (§5), not discoverable only by its silence.

### 3.3 Address and its history

**176.** A shipment's address defaults to the checkout/payment-approved
address. This task represents that as a plain field the caller (a later
repository/route task) populates from the order; it does not fetch from
Shopify itself — no route, no repository, no HTTP client here, per this
task's scope boundary.

**177.** Any change to a shipment's address after it is first recorded is
captured, not overwritten: who changed it, when, and the address before and
after. Reason is retained when given, optional otherwise (mirrors
`AuditEvent.reason`'s existing optionality — this repo has never required a
reason to make an audit trail valid, only that one be captured when
offered).

**178.** The address-change history is append-only at the database level —
same trigger convention as every other evidence table in this schema
(migrations `20260913000100`/`20260914000000`), extended here rather than
re-invented.

### 3.4 Provenance

**179.** Every shipment row records which staff member entered it and when.
Nothing here is customer-facing input — a shipment row is staff's record of
what they arranged with a carrier, not a customer-submitted form.

## 4. Data model

| Model | Purpose |
|---|---|
| `Shipment` | One row per outbound package: carrier/tracking/insurance/signature/delivery, criteria 171-175, 179 |
| `ShipmentAddressChangeEvent` | Append-only history of address changes, criteria 176-178 |

No new enums beyond reusing `ActorType` (already in schema.prisma from
slice 0).

## 5. The enforcement boundary — read before touching `signatureRequired` or insured-value validation

`docs/specs/SLICE-11-READINESS.md` G1: "order value" (the denominator for
both the $100 signature threshold and "full order value" insurance) is
undefined in every document that governs this feature, and is now an open
question with the owner. Until it is answered:

- **Do not** add a function, computed column, or validation that derives
  `signatureRequired` from any amount.
- **Do not** validate `insuredValueMinorUnits` against an order total.
- **Do not** write `100` (in any currency-minor-unit form, e.g. `10000`)
  anywhere in this task's code, comments, seed data, or tests.

The natural point a future implementer would reach for this is the domain
module that validates a signature-requirement record before it's persisted
(`app/app/domain/shipping/signatureRequirement.ts`) — that module's header
comment states this boundary explicitly and cites this section and
`SLICE-11-READINESS.md` directly, so the absence reads as a decision on
first contact, not as something to "helpfully" complete.

## 6. Native Shopify vs custom

| Capability | Owner |
|---|---|
| Label purchase, carrier account, actual tracking/delivery events | **Shopify + carrier** |
| This evidence record (what was arranged, what the carrier confirmed) | **Custom** |
| Fetching the order's checkout-approved address, wiring a repository/route | **Out of scope for this task** — a later task (not yet assigned) |

## 7. Test plan

- Every criterion above gets a direct test: tracking NOT NULL rejected when
  absent (172); insured-value coherence CHECK, both directions (173);
  address-change append-only triggers, at the database level, bypassing the
  application (178).
- A fence test/assertion that no code path in `app/app/domain/shipping/**`
  derives `signatureRequired` from a monetary comparison, and that no
  literal `100` (or `10000` minor units) appears in that directory (175) —
  a grep-based test, same spirit as `metafieldEligibilityFence.test.ts`.
- Pure domain unit tests for the signature-requirement recorder, the
  insured-value coherence validator, and the address-change validator —
  no database, no clock, matching `app/app/domain/warranty/claimStatus.ts`'s
  discipline.
- Integration tests against a real database for the two append-only tables'
  triggers and the money/coherence CHECK constraints, following
  `tests/integration/warranty/warrantyClaimSchema.test.ts`'s convention of
  using `prisma.shipment.*` directly (no repository exists yet).

## 8. Out of scope, explicitly

- Any automated enforcement of the $100 signature threshold or "full order
  value" insurance (R2/R3 from `SLICE-11-READINESS.md`) — blocked on G1/G2.
- A shipping-damage/loss claim workflow — `SLICE-11-READINESS.md` G3 is
  still open; nothing here assumes an answer either way.
- `app/app/db/repositories/**`, `app/app/jobs/**`, any route, any theme
  file — concurrent slice 5 work owns adjacent repository/job directories;
  this task is schema + pure domain only, matching how slice 5 task 5-1 was
  scoped.
- Fetching or validating a Shopify order's address — the `Shipment.address*`
  fields are populated by whatever later task builds the repository/route;
  this task only defines the shape and the change-audit mechanics.
