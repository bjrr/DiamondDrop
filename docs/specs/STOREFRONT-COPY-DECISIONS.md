# Storefront copy — OWNER DECISIONS (locked 2026-09-28)

Supersedes the approval queue in `STOREFRONT-COPY-FOR-APPROVAL.md`. These five
sentences were the only ones outstanding; all are now decided. Everything else
on those surfaces reuses already-locked wording and is not restated here.

**Use these exact strings.** Two are approved CONDITIONALLY and must not ship
until the condition is met — see the blocker note under each.

---

## §1.5 Group Buy — Bank Payment timing

**APPROVED, CONDITIONAL:**

> We'll email you payment instructions.

Appears on the Group Buy campaign page after a Bank Payment order is placed.

> ⛔ **BLOCKED — the condition is NOT met today.** The owner approved this
> "only because the Bank Payment workflow actually sends those instructions".
> It does not. `apps.carat.group-buy-bank-checkout.tsx` sends no email, and a
> whole-app audit found only four senders — `adminAlertDispatch.server.ts`,
> `guaranteeSweep.server.ts` (Buy Now cancellation/guarantee, not Group Buy
> instructions), and the two order-handler admin alerts. None sends a customer
> payment instruction.
>
> Do not publish this sentence until a Group Buy Bank Payment instruction
> email exists and is covered by live proof.

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

> ⛔ **BLOCKED — the condition is NOT met today.** The owner required that the
> notification "actually exists in the workflow before shipping this
> sentence". `apps.carat.warranty-claim.tsx` sends no email; the only
> occurrence of "email" in that route is the `purchaserEmail` field it stores.
>
> Do not publish this sentence until a warranty claim acknowledgement email
> exists and is covered by live proof.

---

## What remains true of the surrounding copy

No turnaround time, no refund timing, and no repair-quote promise appear
anywhere — the three sentences the owner struck earlier are gone and were not
replaced. No further copy needs owner review unless it introduces a new
material promise or changes locked policy.

## Open work created by these decisions

1. Group Buy Bank Payment instruction email (unblocks §1.5).
2. Warranty claim acknowledgement email (unblocks §2.8).
3. The customer-facing warranty claim page itself does not exist in this
   repository yet — only `app/domain/warranty/acknowledgmentText.ts`. When it
   is built, §2.2/§2.4/§2.5 above are the strings to use.
