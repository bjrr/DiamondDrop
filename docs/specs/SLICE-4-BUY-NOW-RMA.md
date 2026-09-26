# Slice 4 — Buy Now RMA (schema + pure domain)

## Status

**DRAFT — implementation authorized for this subset only.** Unblocked by the
owner's resolution of D5, D7 and D10 (`docs/ARCHITECTURE-MVP1.md`), which
`docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §14 had expressly reserved.
This task builds the schema and the pure domain layer only — no repository,
no route, no Shopify adapter. That mirrors how slice 5 task 5-1 and slice 11
were scoped, and for the same reason: the money-and-state-machine rules need
to exist and be tested before anything calls Shopify with them.

Depends on: slice 0 (closed) only.

## 1. Outcome

A customer who wants to return an eligible Buy Now item gets an honest,
policy-exact answer about their window, their remedy options, and what they
must do — before anything ships back. CaratForUs never issues return
instructions before an RMA is approved. The customer, not CaratForUs, chooses
between the two Days 8–30 remedies — the opposite of the warranty claim's
"CaratForUs alone selects the remedy" rule, and worth stating plainly because
a future maintainer familiar with that sibling slice could otherwise assume
the same restriction applies here. CaratForUs never computes tax; it computes
the merchandise-only remedy from locked policy and preserves whatever Shopify
says about tax, recording the two figures separately, and refuses to guess
when Shopify cannot represent the transaction cleanly. Merchandise credit is
Shopify's own Store Credit, tied to the customer's account, and never expires.

## 2. Authoritative sources

| Area | Source |
|---|---|
| Everything RMA | `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` — locked, read in full |
| D5 (store credit mechanism), D7 (tax boundary), D10 (credit terms) | `docs/ARCHITECTURE-MVP1.md` — resolved 2026-09-25 |
| RMA field set, independently | `docs/ARCHITECTURE-MVP1.md` §4: "`rma` — full field set from BUY-NOW-RETURNS §9, computed window state, remedy, deadlines, receipt, inspection, disposition." |
| Evidence, acknowledgment, append-only conventions | `docs/specs/SLICE-0-FOUNDATION.md` |
| The nearest sibling workflow (intake → authorization gate → receipt → decision → remedy → evidence) | `docs/specs/SLICE-5-WARRANTY-CLAIMS.md` and `app/app/domain/warranty/**` — called out explicitly wherever this spec mirrors it |
| The nearest sibling refund ledger (idempotent settlement, status machine, DB-level amount coherence) | `app/app/domain/groupbuy/refunds.ts`, `app/app/db/repositories/groupBuyRepository.server.ts` |
| Money, delegation, git discipline | `CLAUDE.md` |

## 3. The two rules this slice inverts relative to its nearest sibling

Both are stated here because they are the most likely source of a copy-paste
mistake from the warranty slice, which this spec otherwise mirrors closely.

1. **The customer selects the remedy in the Days 8–30 window** (policy §4:
   "the customer may choose"). Warranty criterion 162 forbids exactly this for
   warranty claims. Both are correct, for their own workflow.
2. **This domain never computes tax, in either direction** (D7). It is not
   merely "tax is out of scope" — it is an explicit refusal to reconstruct a
   third figure from the two it does compute, because a plausible-looking
   invented tax figure is indistinguishable from a correct one until an audit.

## 4. Acceptance criteria

Numbered continuing from slice 11 (last used: 179).

### 4.1 Intake

**180.** An RMA request captures every field policy §9 requires: order
number, purchaser email, customer id where available, item/line item,
product/variant/configuration snapshot, carrier-confirmed delivery date, RMA
request timestamp, calendar days since delivery, reason category and
explanation, requested remedy, condition confirmations (unworn beyond
reasonable inspection, undamaged, unaltered, original packaging/documentation
included), confirmation merchandise was not altered after delivery, the
applicable return-policy acknowledgment, and a generated RMA reference.

**181.** Server-side validation: an RMA referencing an order or line that
cannot be resolved is refused rather than stored against a guess (mirrors
warranty criterion 155).

**182.** Reason categories match §9's list exactly: buyer remorse, size/fit,
style preference, alleged defect, wrong item/specification, transit damage,
materially not as described, other. A pure function
(`requiresClaimWorkflow`) identifies which four of these route to the
applicable claim/warranty workflow instead of the discretionary path — they
never automatically receive a restocking-fee refund or credit.

**183.** Personalized, resized, altered or otherwise customized merchandise is
not eligible for a discretionary return unless a product-specific override is
explicitly recorded. This is checked before an RMA can be approved, not
merely stated in copy.

### 4.2 Window classification — computed once, kept as a historical fact

**184.** `calendarDaysSinceDelivery` is computed from the carrier-confirmed
delivery date and the request timestamp, and stored on the request at intake
as an immutable snapshot. It is never recomputed later against "today" —
the same discipline CLAUDE.md rule 7 states for Group Buy campaign pricing,
generalized here to an eligibility window: a rule change to the day
thresholds must never reclassify a request made under the old thresholds.

**185.** A pure function, `classifyReturnWindow(calendarDaysSinceDelivery)`,
returns exactly one of `"standard"` (≤7 days), `"late"` (8–30 days), or
`"ineligible"` (>30 days) — §3, §4, §5 of the policy, verbatim. An
`"ineligible"` result is refused before any RMA row is created; there is no
`denied` RMA that exists solely because of day count. `denied` is reserved for
every other refusal reason (personalization, claim-workflow routing, etc.),
so a stored RMA's status alone tells you whether day-count was ever the
issue.

**186.** In the standard window, the remedy is always a 100% refund to the
original payment method. There is no remedy choice — no field, anywhere,
lets a standard-window request carry one.

**187.** In the late window, the remedy is the **customer's** choice between
(a) a 50%-restocking-fee refund to the original payment method, or (b) a
100% merchandise credit — captured at intake, not decided by staff. See §3's
first inversion.

**188.** `requestedRemedyKind` is present if and only if the window is late —
a coherence rule enforced by a pure validator and mirrored by a database
CHECK constraint, the same coupling style as
`warranty_claim_remedy_refund_money_coherent` and
`price_override_kind_bank_payment_price_coherent`.

### 4.3 Remedy calculation — merchandise only

**189.** The 50% restocking fee is computed once, at the pricing engine's
single money-rounding boundary (`Money.multiplyByDecimal`, an explicit
`RoundingRuleId`), on integer minor units throughout. No floating-point
arithmetic anywhere in this calculation (CLAUDE.md rules 5–6).

**190.** The stored remedy amount is checked against its own recorded inputs
by a database CHECK constraint, independent of the domain function that
computed it — the same "belt and braces" reasoning as
`group_buy_refund_amount_matches_inputs`: a bug that computed correctly and
then wrote the wrong value would be invisible to every test of the
calculation itself, because the calculation would be right.

**191.** `merchandiseAmountMinorUnits + restockingFeeMinorUnits` always
equals the recorded eligible merchandise amount exactly — no invented or lost
minor unit, for either remedy choice.

### 4.4 The tax boundary — D7

**192.** This domain contains no tax rate, percentage, or table anywhere —
not as a constant, not as a fallback, not as a `TODO`. A grep-based fence
test enforces this over `app/app/domain/rma/**`, in the same spirit as
criterion 175's $100 fence, including a "guard the guard" assertion that the
fence actually fails against a synthetic violation (per the finding recorded
in `docs/specs/SLICE-5-WARRANTY-CLAIMS.md` §12 about a fence that proved
nothing).

**193.** The schema records three money figures **separately** and never
derives one from the other two within this task: the computed merchandise
remedy (this domain), Shopify's tax adjustment for the returned line(s)
(nullable here — populated only by the later Shopify-calling job this task
does not build), and the actual refund/credit total Shopify processed
(nullable here, for the same reason). Nothing in this task's code path
computes a tax figure from the other two, or vice versa.

**194.** A remedy status, `staff_review_required`, exists specifically for
D7's fail-closed instruction — "if Shopify cannot represent it... route to
staff review" — and is structurally distinct from `failed`. `failed` is a
normal, retryable processor rejection; `staff_review_required` means retrying
the identical operation would hit the same representability problem, so nei-
ther the pure transition table nor the database trigger route it back into
`processing` automatically the way `failed` is. A human resolves the
representability question first.

### 4.5 Merchandise credit — D5, D10

**195.** Merchandise credit is modeled as native Shopify Store Credit
(`RmaRemedyKind.merchandise_credit`) — no gift-card enum value, column, or
code path exists anywhere in this task.

**196.** Issuance idempotency is structural, not a read-then-write check: at
most one `RmaRemedy` row per RMA (`@@unique([rmaId])`), and once `issued`,
the row is immutable — the same terminal-state trigger design as
`group_buy_refund_issued_is_terminal`. A retried "issue this remedy" call, in
whatever job later executes it, cannot create a second credit or a second
refund.

**197.** No expiration field exists anywhere on the remedy/credit schema.
This is D10's decision, not an oversight — documented here and at the exact
point (`RmaRemedy` model's doc comment) a future implementer adding a
"credit valid until" column would look, so its absence reads as a decision on
first contact rather than something to "helpfully" complete. Non-
transferability is a fact about the Shopify customer record the credit is
attached to; this schema introduces no competing "transferable" concept that
could contradict it.

### 4.6 Customer-paid return shipping

**198.** Approved return instructions retain tracking, insurance reference,
and insured value (money — present together or absent together with its
currency, mirroring the `warranty_claim`'s inbound-shipping coherence
pattern) once the customer supplies them.

**199.** No return/shipping instruction may be produced before an RMA reaches
`approved`. A pure helper, `mayIssueReturnInstructions`, mirrors
`mayIssueInboundShippingInstructions` from the warranty domain — same
reasoning, same criterion-156-shaped guarantee, adapted to this workflow's
own gate.

### 4.7 Status machine and evidence

**200.** RMA statuses are modeled as a state machine with explicit legal
transitions (mirrors `app/app/domain/warranty/claimStatus.ts`'s discipline
exactly). An illegal transition is refused, not recorded, at two independent
layers: the pure function and a database trigger mirroring
`warranty_claim_guard`.

**201.** Every transition is appended to an immutable RMA event history —
who, when, from, to, why — append-only enforced by trigger, same convention
as every other evidence table in this schema.

**202.** A coverage-equivalent decision — here, the post-receipt condition
decision (`accepted`/`rejected`) — cannot precede a recorded receipt, and a
`rejected` decision requires a non-empty reason. Both are CHECK-constrained
independently of the transition table, mirroring
`warranty_claim_decision_requires_receipt` and
`warranty_claim_denial_requires_reason`.

**203.** The complete RMA record — request, every event, and its remedy — is
retrievable in one query, sufficient to defend a chargeback (policy §11/§12).

**204.** A duplicated or retried remedy-processing attempt cannot create
duplicate customer value (policy §13 criterion 11) — enforced by the
`@@unique([rmaId])` constraint and the issued-is-terminal trigger, not by a
read-then-write check anywhere in this task's domain.

## 5. Data model

| Model | Purpose |
|---|---|
| `RmaRequest` | The request itself: refs, snapshot, window, remedy choice, deadlines, receipt, condition decision, status (criteria 180–191, 198–199, 202–203) |
| `RmaEvent` | Append-only status transition and evidence history (criteria 200–201) |
| `RmaRemedy` | The remedy execution record: merchandise amount, restocking fee, Shopify tax adjustment and actual total (kept separate, criterion 193), processor/store-credit reference, status (criteria 192–197, 204) |

New enums: `RmaStatus`, `RmaReasonCategory`, `RmaWindowKind`, `RmaConditionDecision`,
`RmaRemedyKind`, `RmaRemedyStatus`. Reuses `ActorType` and `Acknowledgment`
unchanged, exactly as slice 5 did.

## 6. Native Shopify vs custom

| Capability | Owner |
|---|---|
| Order, line item, customer, refund execution, tax calculation and records | **Shopify** |
| Window/eligibility classification, remedy computation, state machine, evidence | **Custom** |
| Store-credit issuance, Shopify's suggested-refund/tax lookup | **Out of scope for this task** — a later job/repository task, same as slice 5's task 5-2 split |
| RMA intake form, staff review surface | **Out of scope for this task** — later route tasks |

## 7. Test plan

- Pure unit tests, no database, no clock (mirrors
  `app/app/domain/warranty/claimStatus.ts`'s discipline): window
  classification at every boundary (day 6/7/8/30/31), remedy computation for
  both late-window choices and the standard-window case, the state machine's
  legal and illegal transitions, the coherence validators.
- A grep-based fence test over `app/app/domain/rma/**` asserting no tax
  rate/percentage constant exists, with a "guard the guard" case proving the
  fence fails against a synthetic violation (criterion 192).
- Integration tests against a real, disposable database for: the append-only
  trigger on `RmaEvent`; the CHECK constraints (window/remedy coherence,
  amount-matches-inputs, condition-decision-requires-receipt,
  denial/rejection-requires-reason); the issued-is-terminal trigger; the
  `@@unique([rmaId])` idempotency constraint.
- Money in integer minor units throughout — no float, no `Number()` on an
  amount, verified by `npm run check:money-safety`.

## 8. Out of scope, explicitly

- `app/app/db/repositories/**`, `app/app/jobs/**`, any route, any theme file.
- Calling Shopify for anything — the suggested-refund/tax breakdown lookup,
  the actual refund, and the Store Credit issuance are later tasks. This
  task's `RmaRemedy` schema has the columns those tasks will populate, but
  populates none of them itself.
- `app/app/domain/warranty/**`, the warranty repositories, and
  `warrantyClaimRepository.server.ts` — another agent's concurrent slice.
- Deciding what happens to `resolved`/`closed` RMAs beyond the status itself
  (support tooling, notifications) — later task.
- The exact RMA-reference number format — mirrors
  `WarrantyClaim.claimReference`'s precedent: generated by the repository
  layer (a later task), not a database default.
