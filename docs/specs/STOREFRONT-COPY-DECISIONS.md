# Storefront copy — OWNER DECISIONS (locked 2026-09-28)

Supersedes the approval queue in `STOREFRONT-COPY-FOR-APPROVAL.md`. These five
sentences were the only ones outstanding; all are now decided. Everything else
on those surfaces reuses already-locked wording and is not restated here.

**Use these exact strings.** Two were approved conditionally on an email that
did not yet exist; both emails were built on 2026-09-29 and the conditions are
met — see the note under each for what remains operational rather than
editorial.

---

## §1.5 Group Buy — Bank Payment timing

**APPROVED, CONDITIONAL:**

> We'll email you payment instructions.

Appears on the Group Buy campaign page after a Bank Payment order is placed.

> ✅ **UNBLOCKED 2026-09-29 — condition met, pending secrets.** The email now
> exists: `app/domain/bankpayment/groupBuyPaymentInstructionsEmail.ts`, sent by
> `apps.carat.group-buy-bank-checkout.tsx` after the order is created. It
> carries the exact amount due, the order reference, both owner-approved
> methods (Zelle and domestic wire), the deadline taken from the same
> `groupBuyPaymentWindowDeadline` the inactivation sweep enforces, and the
> locked statement that payment is not confirmed until received and verified.
>
> ONE OPERATIONAL PRECONDITION REMAINS: the five `PAYMENT_*` Fly secrets must
> be set. Until they are, Group Buy Bank Payment checkout fails closed with
> 503 BEFORE creating any order — it will not produce an order it cannot tell
> the customer how to pay for. So this sentence is safe to publish the moment
> those secrets exist, and harmless before then, because no customer can reach
> a Bank Payment order at all.

## §2.2 Warranty — what's covered

**APPROVED AS REWRITTEN BY THE OWNER.** The drafted loose-stone example was
rejected for implying that any loose stone is automatically covered. Use:

> Examples may include defective solder joints, structural workmanship
> failures, setting defects, and defective clasps or mechanisms under normal
> use.

Appears under "What's covered" on the warranty claim page, after the locked
one-year manufacturing-defect statement.

## §2.4 Warranty — do not ship yet

**REJECTED, WITH NO REPLACEMENT.** The drafted consequence ("can't be tracked
against your claim and may be returned to you") is not used, and no other
consequence replaces it. Use ONLY the already-approved instruction:

> Do not send your jewelry until CaratForUs authorizes an inspection and
> provides shipping instructions.

Appears on the warranty claim page and on the confirmation screen. A render
test already asserts this notice appears in BOTH the signed-in and signed-out
states, so the sign-in gate cannot suppress it.

## §2.5 Warranty — inbound shipping

**REJECTED, WITH NO REPLACEMENT.** No risk-of-loss statement is made to the
customer. Keep only the locked rule:

> If we authorise an inspection, you arrange and pay for shipping to us, and
> it must be tracked and insured for the full value of the piece.

Nothing is said about who bears the risk while the package is in transit.
`docs/WARRANTY-CLAIMS.md` remains the authority, including its "subject to
applicable law" qualifier, which stays on the policy page rather than being
compressed onto a page a customer skims.

## §2.8 Warranty — confirmation

**APPROVED, CONDITIONAL:**

> We'll review what you've sent and email you at {purchaserEmail}.

Appears on the claim confirmation screen, above the §2.4 do-not-ship notice.

> ✅ **UNBLOCKED 2026-09-29 — condition met.** The email now exists:
> `app/domain/warranty/claimAcknowledgmentEmail.ts`, sent by
> `apps.carat.warranty-claim.tsx` after the claim is committed. Its copy was
> approved verbatim on 2026-09-29 and is pinned character-for-character,
> including a test that forbids any turnaround-time phrasing — the owner
> struck that twice and a future edit should fail loudly rather than quietly
> reintroduce it.
>
> The send is best-effort and deliberately cannot fail the claim: the claim is
> already committed and its upload destinations already spent, so turning a
> mail-provider outage into an error the customer would retry is strictly
> worse than an acknowledgement that arrives late.

---

## What remains true of the surrounding copy

No turnaround time, no refund timing, and no repair-quote promise appear
anywhere — the three sentences the owner struck earlier are gone and were not
replaced. No further copy needs owner review unless it introduces a new
material promise or changes locked policy.

## Open work created by these decisions

1. ~~Group Buy Bank Payment instruction email~~ — BUILT 2026-09-29. Needs the
   five `PAYMENT_*` Fly secrets set before Bank Payment checkout will accept
   an order at all.
2. ~~Warranty claim acknowledgement email~~ — BUILT 2026-09-29.
3. The customer-facing warranty claim page itself does not exist in this
   repository yet — only `app/domain/warranty/acknowledgmentText.ts`. When it
   is built, §2.2/§2.4/§2.5 above are the strings to use.
