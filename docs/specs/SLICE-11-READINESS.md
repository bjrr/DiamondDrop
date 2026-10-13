# Slice 11 Readiness — Shipping / Insurance / Signature Controls and Evidence

## Status

**ASSESSMENT ONLY — no code, no schema, not committed.** Written at the Tech
Lead's request to answer whether slice 11 is genuinely safe to start next
(architecture §10's at-most-two-concurrent-slices rule, with slice 4 blocked
on D5/D7/D10 and slice 5 in progress).

Sources read in full: `docs/ARCHITECTURE-MVP1.md` §3 (native-vs-custom
table), §4 (`shipment` model), §10 (slice table, row 11); `README.md`
"Shipping, Insurance & Signature — MVP1 Locked Direction" and "Customer
Acknowledgment / Evidence Architecture"; `docs/BUY-NOW-RETURNS-AND-DISPUTE-
EVIDENCE.md` §11 ("Fulfillment evidence"); `docs/WARRANTY-CLAIMS.md` §4
(inbound shipping, a related but distinct rule — see §4 below); `docs/
LUXURY-STEALS.md` (checked for any shipping-specific override; found none).
Also checked `prisma/schema.prisma`'s `CostComponentType` enum directly,
since README's shipping section makes a pricing claim that turned out to
already be implemented — see §1, R8.

## 1. What slice 11 actually requires

Nine concrete rules, drawn from `README.md`'s dedicated "Shipping, Insurance
& Signature — MVP1 Locked Direction" section plus the `shipment` model in
`ARCHITECTURE-MVP1.md` §4 and the "Fulfillment evidence" list in
`BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §11 (three independently-written
lists that agree on the same field set — a good sign the shape itself is
stable, whatever the open questions below turn out to be).

- **R1 — Always tracked.** "Every shipment has tracking." No condition, no
  threshold. Fully specified.
- **R2 — Always insured for the full order value.** "Every outbound customer
  shipment is insured for the full order value." Fully specified *as a
  rule*; what "order value" means as a dollar figure is not — see G1.
- **R3 — Signature required above $100, non-waivable.** "Any shipment with
  order value above $100 requires signature confirmation. Customers may not
  waive required signature above $100." The threshold number is specified.
  What it's measured against is the same open term as R2 — see G1.
- **R4 — Signature optional at or below $100, with a staff escape hatch.**
  "Orders at $100 or less may ship without signature unless CaratForUs
  requires stricter controls." The default is specified; the escape hatch's
  mechanism is not — see G4 (minor, non-blocking).
- **R5 — Ship to the checkout/payment-approved address unless a later
  change is explicitly reviewed and documented.** Specified as a rule; the
  review workflow's mechanics (who, how) are ordinary design questions
  answerable from this repo's existing `AuditEvent`/actor-identity
  conventions, not a business-rule invention — not a blocking gap.
- **R6 — Post-order address changes require audit history.** Same as R5:
  specified as a requirement, mechanics derivable from existing conventions.
- **R7 — Capture, per shipment:** carrier, service level, tracking number,
  ship date, insured value, insurance reference, signature-required flag,
  delivery evidence (carrier-confirmed delivery / proof of signature),
  shipping address, address-change history, and claim/exception references.
  This exact field set is stated independently in three places (the
  architecture's `shipment` model, README's bullet list, and
  `BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §11's "Fulfillment evidence")
  and they agree — fully specified.
- **R8 — Shipping/insurance costs must be represented in pricing so they
  don't silently erode margin.** Already done, not new work: `prisma/
  schema.prisma`'s `CostComponentType` enum already has `shipping` and
  `insurance` members from slice 1. README's sentence describes a
  constraint slice 1 already satisfies; slice 11 does not need to touch
  pricing at all.
- **R9 — This evidence is a load-bearing input to slice 4's dispute
  packet**, not just slice 11's own concern:
  `BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §11's "Fulfillment evidence"
  list is word-for-word the same field set as R7. Worth naming even though
  it isn't a blocker: slice 4 (currently blocked on D5/D7/D10) will want
  this data once it unblocks, even though the architecture table doesn't
  draw a formal dependency edge from 4 to 11.

## 2. Specified vs. must-be-invented

### Specified — safe to build from directly

R1, R3's threshold number, R4's default, R5, R6, R7, R8 (already done). None
of these require picking a number or a policy that isn't already written
down.

### Must be invented if slice 11 started today — named explicitly, not filled in

**G1 — "Order value" is never defined.** R2 and R3 both key off it, and nothing
in `README.md`, `ARCHITECTURE-MVP1.md`, or any locked policy document says
whether it means the merchandise subtotal, or the total including tax,
shipping, duties, and discounts. This is not a trivial reading: elsewhere in
this codebase the identical-sounding question is answered explicitly and
deliberately narrowly — `CLAUDE.md` rule 15 and `docs/BANK-CARD-PRICING.md`
both say Bank Payment savings are "merchandise only," excluding tax/shipping.
Reusing that answer here, silently, would be inventing a default under a
different policy's authority for a section that never says so. **This single
term gates both R2 (the insured-value figure) and R3 (the signature
threshold comparison).** Owner input needed: one sentence defining "order
value" for this section.

**G2 — No insurance mechanism or provider is named for reaching "full order
value" on high-value pieces.** Standard carrier declared-value insurance
(USPS, UPS, FedEx) commonly caps well below what a fine-jewelry order can
cost. No document names a specialized high-value shipping insurer (the kind
jewelers typically use for this exact reason), nor does any document say
"best-effort up to the carrier's cap is acceptable." Without an answer,
"insured for the full order value" may not be achievable as literally
stated for an expensive order, and the technical shape of `insuranceRef` (a
carrier receipt number vs. a third-party policy number) depends on which
mechanism is actually used. Owner input needed: name the mechanism, or
explicitly say carrier-cap best-effort is acceptable for MVP1.

**G3 — Whether a shipping-damage/loss claim *workflow* (not just the
evidence record) is in scope for slice 11, or for MVP1 at all.**
"Shipping damage" / "transit damage" is named as a separate claim path in
three different locked documents (`BUY-NOW-RETURNS-AND-DISPUTE-
EVIDENCE.md` §§1, 5, 8; `LUXURY-STEALS.md`; `README.md` lines 226 and 338)
— but none of them, nor any other document, ever states that path's actual
rules: no eligibility window, no evidence requirements beyond "retain what
exists," no remedy options, no decision-maker. Contrast this with RMA and
Warranty, which both get a full dedicated locked-policy document. Three
pieces of evidence point toward "not in scope for MVP1, evidence-capture
only": the slice's own title says "controls and evidence," not "claims"
(unlike slice 4's "RMA" and slice 5's "Warranty claims"); slice 11's row
lists a single owner (Backend only — no Frontend/Shopify Dev, unlike every
slice that ships a customer-facing claim form); and README's "MVP1
Customer-Facing Scope" and "Required Internal Records" lists both mention
"tracked/insured shipping and signature controls" / evidence, but neither
lists a shipping-damage claim form or workflow anywhere, while RMA and
Warranty both get explicit line items. **I read this as: slice 11 stores the
evidence (R7's "claim/exception references" field, populated with a free
reference when something happens), and an actual damage/loss dispute is
handled manually by staff outside the app for MVP1** — consistent with
`BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §11's own "MVP1 may assemble
dispute packets manually" allowance. This is my reading, not a written rule,
and I am not building a claims workflow on the strength of an inference — it
should be confirmed or denied explicitly before or during the slice 11
feature spec, because if the answer turns out to be "yes, build it," there
is currently zero written policy to build it from and that would need its
own locked-policy document first, the same way RMA and Warranty each got
one.

**G4 — Minor, non-blocking.** R4's "unless CaratForUs requires stricter
controls" names no mechanism (a global setting? a per-product-category
flag? per-order staff discretion?). This doesn't block anything: it's a
purely permissive override on top of an already-fully-specified default, so
a design that lets staff mark any individual shipment signature-required
regardless of value satisfies the written rule without inventing a
restrictive number. Worth a design decision in the feature spec, not an
owner question.

**G5 — Minor, non-blocking, informational.** No carrier is named, and
neither is the mechanism by which tracking/insurance/signature data enters
the system (manual staff entry, a Shopify `fulfillments/*` webhook, or a
hybrid). Per `ARCHITECTURE-MVP1.md` §3's ownership table, carrier selection
and label purchase are explicitly Shopify-plus-carrier's job, not this
app's — "App stores signature/insurance flags and evidence references" is
the entire scope of what the app does here. So this is a normal
`/feature-spec` design question (and note that it will likely need the
`read_fulfillments` Shopify scope the architecture doc already lists as "a
roadmap, granted when the slice that reads it lands" — this would be that
slice), not a business-rule gap.

## 3. Recommendation: start a defined subset

Slice 11 is not one indivisible unit of risk. Split it:

**Safe to start immediately, no invented numbers required:**
- The `shipment` evidence schema (R7's full field set — carrier, service,
  tracking, ship date, insured value, insurance reference, signature flag,
  delivery evidence, address, claim/exception reference), following this
  repo's established money/evidence/audit conventions.
- R1 (always-tracked) — unconditional, nothing to gate.
- R5/R6 (checkout-approved address as the default; any change captured with
  full audit history) — the rule and the mechanics are both answerable from
  what's already written and from existing `AuditEvent`/actor conventions.
- The fields to hold `insuredValueMinorUnits`/`insuranceRef` and
  `signatureRequired` can exist and be populated per-shipment by staff
  entry from day one — recording what was actually arranged for a given
  shipment does not require G1/G2 to be answered first.

**Hold — do not implement until G1 is answered:**
- Any automated enforcement keyed to the $100 threshold (R3) or to "full
  order value" (R2) — i.e., a validation that blocks recording a shipment
  as fulfilled without a signature flag when the order qualifies, or that
  compares insured value against order value. Building this now means
  picking a definition of "order value" myself, which is exactly the
  invented default this assessment was asked not to produce.

**Ask the owner, in one short round, before finishing (not before starting)
the held portion:**
1. Define "order value" for this section — merchandise subtotal, or total
   including tax/shipping/duties? (G1 — this single answer unblocks both
   R2's and R3's enforcement.)
2. Name the insurance mechanism for reaching "full order value" coverage on
   high-value orders, or confirm carrier-cap best-effort is acceptable for
   MVP1. (G2.)
3. Confirm whether a shipping-damage/loss claim *workflow* is in scope for
   slice 11/MVP1, or whether — as I read the existing documents — it is
   evidence-capture only with disputes handled manually. (G3.)

None of these three questions requires new design work to answer — each is
a single decision the owner already has the context for. The schema/evidence
half of the work can proceed in parallel while they're asked, so the
concurrency slot isn't wasted waiting on them.
