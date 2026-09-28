# Group Buy + Warranty storefront copy (PROPOSAL)

**NOT APPROVED. Nothing here is pinned or shipped.** Drafted 2026-09-28 from
`README.md`, `docs/BANK-CARD-PRICING.md`, `docs/WARRANTY-CLAIMS.md`,
`docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md` and
`docs/REQUIRED-CUSTOMER-ACCOUNTS.md`. Every material term traces to one of
those; where a document is silent, this proposal says so rather than
inventing a term.

## How to read this

Approve, edit or reject **per item**. Edited text is what gets pinned — I
will not "improve" an approved sentence afterwards.

**Already-approved language is reused verbatim and marked ♻.** Those items
need no decision from you; they are listed so you can see the whole surface
at once. Four sentences already carry your approval and appear across
multiple pages — the sign-in gate, the Bank Payment non-commitment
disclosure, the Bank Payment success message, and the Final Sale
acknowledgment. Reusing them is deliberate: a second variant of a material
term is a second thing to keep in sync, and they drift.

**Judgement calls are flagged** rather than buried. Where I chose brevity
over a legal qualifier, or omitted something you might expect, it says so.

---

# Part 1 — Group Buy

## 1.1 Campaign page headline and explanation

> ### Group Buy
> Join other CaratForUs customers to unlock a lower price on the same piece.
> As more pieces are ordered, the price drops for everyone — including
> everyone who already ordered.

**Judgement call.** "Including everyone who already ordered" is the single
most important sentence on this page and I would resist cutting it. It is
the thing that makes joining early safe, it is literally true because of the
refund ledger, and without it a customer's rational move is to wait — which
is exactly the behaviour that stops a campaign reaching its next tier.

## 1.2 Tier and progress explanation

> **{n} of {threshold} ordered** — {m} more to unlock {price}.
>
> Progress only ever moves forward. If someone later cancels, the price you
> unlocked together stays unlocked.

**Source:** README — progress is cumulative and monotonic; a later
cancellation never reduces the count or rolls back a tier.

**Judgement call.** The second sentence exists because monotonic progress is
an unusual promise and customers will not assume it. It also pre-empts the
support question "the number went down, did I lose my price?" — which cannot
happen, and saying so costs one line.

## 1.3 Payment type selection — Bank vs Card

Shown only after product options are chosen, as a required choice:

> **Payment Type** *(required)*
>
> ○ **Credit / Debit Card** — {card price}
> ○ **Bank Payment** — {bank price}
>
> Bank Payment (Zelle, ACH, bank transfer or wire) is available at a lower
> price. Choose one to continue.

Before a selection is made, the options table shows the Card price with:

> Lower pricing is available with Bank Payment.

**Sources:** `CLAUDE.md` rule 13 and the owner decisions doc §9 — Group Buy
defaults to one visible Regular/Card price with a note that lower pricing is
available; Payment Type is required before ordering; only one active price is
shown at a time. Eligible methods are electronic only (rule 14).

**Deliberately absent:** any percentage, and the words *card fee*,
*surcharge* or *cash discount*. A forbidden-terminology sweep already guards
this.

## 1.4 Campaign close and final price

> **When the campaign closes**
> Everyone pays the final unlocked price. If you paid more than the final
> price because you ordered before a tier unlocked, we refund you the
> difference to your original payment method. Refunds are processed after
> your piece ships.

**Sources:** README and `docs/ARCHITECTURE-MVP1.md` §6.1 — settlement at the
final unlocked tier, refunds held through production/QC and processed at
shipping, refund basis follows the original payment method.

**Judgement call — please confirm.** "Refunds are processed after your piece
ships" is accurate but is a commitment about timing. The policy says refunds
are held through production/QC and released at shipping; I have stated the
customer-visible consequence rather than the internal mechanism. If you would
rather promise nothing about timing, cut the last sentence — but I would
expect "when do I get my refund?" to become the top support question if we do.

## 1.5 Bank Payment timing

> **Paying by bank transfer**
> We'll email you payment instructions. You have **48 hours** to send
> payment; if you need longer we'll automatically extend it once, by a
> further 48 hours.
>
> Your order counts toward the group's progress straight away, and your price
> is locked from the moment you order.
>
> If payment hasn't arrived after 96 hours we'll set your order aside. While
> the campaign is still open you can email us to reactivate it — same order,
> same locked price.

**Sources:** README — 48 hours plus one automatic 48-hour extension; inactive
after 96 hours; email-requested reactivation reuses the same order at the
original locked price while the campaign remains open; a pending Bank Payment
order counts toward progress immediately.

**Judgement call.** "We'll set your order aside" in place of *inactive*.
Internally it is a status; to a customer, wording it as a deactivation reads
as punishment for a slow bank transfer, when the policy explicitly allows
reactivation at the same price.

## 1.6 Cancellation and Final Sale acknowledgment

♻ **Reuse the approved Final Sale acknowledgment verbatim** where a Group Buy
item is also a Luxury Steal:

> Final Sale — this item cannot be returned or exchanged. Please review our
> return policy

For ordinary Group Buy items, **I have drafted nothing**, and that is
deliberate. `README.md` says a placed Group Buy order is committed at close
with no discretionary cancellation, but I could not find an approved
customer-facing statement of what happens to a cancellation request *before*
close. Inventing one would be inventing policy. **This needs your decision
before the Group Buy flow can ship** — see Open Questions.

## 1.7 "Bring It Back" / completed campaigns

**Not drafted — out of scope.** I checked: there is no Bring It Back surface
in the codebase, no route, no domain model, and no locked policy describing
its behaviour. Drafting copy for it would be designing the feature by writing
its marketing first. Flag it if you want it specified; it is not blocking
Slice 6.

---

# Part 2 — Warranty

## 2.1 Page intro

> ### Warranty claim
> If something has gone wrong with a CaratForUs piece, tell us what happened
> and we'll review it. Start by finding your order below.

## 2.2 What the 1-year limited warranty covers

> **What's covered**
> For one year from delivery, we cover manufacturing defects — problems with
> how your piece was made. That includes things like a stone coming loose
> from a setting that wasn't damaged, a clasp or finding that fails in normal
> wear, or a soldered joint separating.

## 2.3 What it does not cover

> **What isn't covered**
> - Normal wear — surface scratches, dulled polish, thinning over years of
>   daily wear
> - Damage from an impact, accident, or loss
> - Work done by another jeweller after delivery
> - Resizing, alteration or repair not carried out or authorised by us
> - Loss or theft
>
> If your piece isn't covered, we'll tell you what a repair would cost before
> doing anything.

**Judgement call — the last line.** `docs/WARRANTY-CLAIMS.md` does not
promise a repair quote for uncovered items. I have included it because
"not covered" as a dead end is the worst customer moment in this flow, and
a quote costs us nothing to offer. **If you'd rather not commit to it, cut
that sentence** — it is the only line in this section that is not directly
traceable to the policy.

## 2.4 Do not ship until authorised

> **Please don't send your item yet.**
> Wait until we've reviewed your claim and sent you shipping instructions.
> Items sent before we authorise an inspection can't be tracked against your
> claim and may be returned to you.

**Source:** `docs/WARRANTY-CLAIMS.md` §3 and criterion 156 — the confirmation
must carry no shipping instruction before authorisation. A render test
already asserts this notice appears in **both** the signed-in and signed-out
states, so the sign-in gate cannot accidentally suppress it.

## 2.5 Customer-paid tracked and insured inbound shipping

> **If we authorise an inspection**
> You arrange and pay for shipping to us, and it must be tracked and insured
> for the full value of the piece. We'll send exact instructions with your
> authorisation. Until your package reaches us, it's covered by your carrier
> and insurance rather than by us.

**Source:** `docs/WARRANTY-CLAIMS.md` — customer-paid tracked and
appropriately insured inbound shipping after authorisation.

**Judgement call.** The last sentence states risk-of-loss plainly and omits
the policy's "subject to applicable law" qualifier, which belongs on the full
policy page this links to. Same compression I flagged in the RMA
acknowledgment; same reasoning, and the same note that removing a legal hedge
is properly your counsel's call.

## 2.6 Submitting a claim is not coverage

♻ **Reuse the approved acknowledgment verbatim.** It already carries exactly
this term and is pinned:

> I certify that the information and files I submitted are accurate to the
> best of my knowledge. I understand that submitting this claim does not
> establish warranty coverage. …

Affirmative-action label: **I Certify & Agree** ♻

**No second variant.** A page-level paraphrase of "submitting isn't coverage"
would be a duplicate of a material term that already has your approval, and
the two would drift.

## 2.7 Sign-in requirement

♻ **Reuse the approved gate copy verbatim:**

> Please sign in or create a CaratForUs account to continue.

Supporting line (new, needs approval):

> Warranty claims are tied to the account that placed the order, so we can
> confirm the piece is yours.
>
> Can't access that account? Contact Customer Care and we'll verify you
> another way.

**Source:** `docs/REQUIRED-CUSTOMER-ACCOUNTS.md` §5 — a customer who cannot
access the purchasing account contacts Customer Care for manual verification.
That sentence matters: without it, losing an account login looks like losing
the warranty.

## 2.8 Confirmation / success

> **Claim received — reference {claimReference}**
> We've got it. We'll review what you've sent and email you at
> {purchaserEmail}, usually within a few business days.
>
> Please don't send your item yet — we'll tell you if and when an inspection
> is needed, and how to ship it.

**Judgement call — "usually within a few business days."** The policy sets no
response-time commitment. I included a soft expectation because a
confirmation with no timeframe generates a follow-up email within a day. It
is deliberately hedged and easy to meet. **Cut it if you'd rather promise
nothing** — that is a reasonable position and I'd rather you choose than have
me assume.

---

# Open questions — I need answers before these ship

1. **Group Buy cancellation before close (§1.6).** No approved language
   exists for a customer asking to cancel while a campaign is open. README
   establishes commitment at close; it does not describe pre-close
   cancellation to a customer. **Blocking** the Group Buy order flow.
2. **Group Buy refund timing (§1.4)** — state "after your piece ships", or
   promise nothing?
3. **Warranty repair quote for uncovered items (§2.3)** — offer it, or stay
   silent?
4. **Warranty response time (§2.8)** — keep the soft "few business days", or
   remove?
5. **Bring It Back (§1.7)** — is this in MVP1 at all? Nothing exists in the
   codebase and nothing is specified.

Items 2, 3 and 4 are each one sentence and block nothing; the pages read
fine without them. Item 1 is a genuine gap. Item 5 is a scope question.
