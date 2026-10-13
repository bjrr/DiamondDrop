# Slice 4 — Buy Now RMA Return-Policy Acknowledgment Copy (PROPOSAL)

## Status

**NOT APPROVED. Nothing here is pinned, shipped or rendered to any customer.**

Drafted 2026-09-26 by the Tech Lead, from `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md`
only. Every sentence below traces to a clause in that locked policy; no term
was invented, softened or extended. Where the policy is silent, this proposal
says so rather than filling the gap.

This exists because Slice 4's customer intake **cannot accept a single
submission until the owner approves this text**. `RmaRequest` carries a
NOT NULL `returnPolicyAcknowledgmentId`, and there is no approved RMA
return-policy copy anywhere in the repository. The intake route currently
fails closed with `503 acknowledgment_copy_pending_approval` rather than
invent binding language — inventing it was the available shortcut and would
have shipped looking finished and approved.

## How to read this document

Each section gives the **proposed text**, then the **clause it comes from**,
then any **judgement call** I made in compressing policy prose into something a
customer reads at the point of decision.

Approve, edit, or reject per section. Edited text is what gets pinned — I will
not "improve" an approved sentence afterwards. Once approved, the text is
pinned character-for-character with its policy version and affirmative-action
label, the same way the warranty acknowledgment was.

The warranty acknowledgment's approved affirmative-action label was
**`I Certify & Agree`**. A parallel label is proposed in §3; it is genuinely
your call whether the two should match for consistency or differ because the
customer is agreeing to something different in kind.

---

## 1. Acknowledgment body — the material terms

### Proposed text

> I am requesting a discretionary return. I understand and agree that:
>
> - CaratForUs must approve this return request before I send anything back.
> - I pay the cost of return shipping. My return must be tracked and insured
>   for the value of the merchandise, and I must follow the return
>   instructions CaratForUs provides.
> - Until CaratForUs receives the merchandise, the risk of loss or damage in
>   return transit is mine.
> - The merchandise must come back unworn beyond reasonable try-on, undamaged,
>   unaltered since delivery, and complete with its original packaging,
>   certificates, reports, accessories and documentation — and it must be the
>   same item and configuration that was shipped to me.
> - Any expedited or optional shipping I paid for on the original order is not
>   refunded on a discretionary return.
> - Engraved, resized, altered, personalized or otherwise customized
>   merchandise cannot be returned for a discretionary return.
> - If my request is about a defect, the wrong item or specification, shipping
>   damage, merchandise that is materially not as described, or a warranty
>   issue, that is handled under the applicable claim or warranty policy
>   instead of this one — and those rights are not affected by this
>   acknowledgment.

### Clause sources

Line by line: RMA required (§2); customer-paid, tracked, insured return
shipping and following approved instructions (§6); risk of loss in transit
(§6); condition and completeness requirements (§7); outbound expedited
shipping not refunded (§6, *Original/outbound shipping*); personalized and
altered merchandise ineligible (§8); non-discretionary claims routed elsewhere
(§6, §8, and §10's final bullet).

### Judgement calls

**The last bullet is doing real work and I recommend against cutting it for
length.** Every other bullet narrows what the customer gets. That one tells
them what this acknowledgment does *not* take away. The policy separates
discretionary returns from defect, warranty and fulfilment-error claims in
three separate places, which is a strong signal it matters — and an
acknowledgment that lists only restrictions invites a customer to believe they
have signed away a defect claim. It also mirrors the Luxury Steals principle
already locked: Final Sale must not automatically deny a legitimate covered
claim.

**"Risk of loss is mine" is stated plainly, without the policy's "subject to
applicable law and carrier/insurance rights" qualifier.** That qualifier is
legally meaningful and I did not delete it lightly — it belongs in the full
policy page, which this acknowledgment should link to. My reasoning is that a
customer skim-reading a checkbox is better served by the plain statement, and
the qualifier can only ever operate in their favour. **Flagging it explicitly
because it is the one place I compressed a legal hedge, and that is your call
and arguably your counsel's, not mine.**

**Deadlines are deliberately absent from this list** — see §2.

---

## 2. Window and remedy — shown, not acknowledged

### Recommendation

Do **not** put the deadlines and remedy figures inside the acknowledgment
checkbox. Display them on the form, computed for this specific order, above
the acknowledgment.

### Why

The customer's actual window depends on their carrier-confirmed delivery date.
A static sentence saying "request within 7 days" is wrong for anyone reading
it on day 9 — and the Days 8–30 path is a real option, not a failure state.
Asking someone to tick a box agreeing to a deadline that has already passed,
or that does not match the one the system will enforce, is how you manufacture
a dispute rather than defend against one.

### Proposed displayed text (standard window, days 0–7)

> Because your order was delivered on **{delivery date}**, you can return this
> item for a full refund of the merchandise price. We need to receive it by
> **{date}**.

### Proposed displayed text (late window, days 8–30)

> Your order was delivered on **{delivery date}**, so this is a late return.
> You can choose either a refund of the merchandise price less a 50%
> restocking fee, or 100% of the merchandise price as merchandise credit. If
> we approve your request, we need to receive the item within 10 days.

### Proposed displayed text (after day 30)

> Your order was delivered on **{delivery date}**, which is more than 30 days
> ago, so it is outside our discretionary return window. If your item is
> faulty, was not what you ordered, or arrived damaged, that is handled
> separately — please [start a claim] instead.

### Clause sources

§3 (7-day request, 14-day receipt), §4 (Days 8–30 options), §5 (no
discretionary return after Day 30), §10 (10 days after approval for late
returns), §10 (carrier-confirmed delivery is the authoritative anchor).

### Judgement call

The two receipt deadlines have **different anchors** and this is the single
easiest thing to get wrong: standard is 14 days from *delivery*, late is 10
days from *approval*. The wording above keeps them distinct on purpose. The
domain already implements them as separate formulas.

---

## 3. Affirmative-action label

### Proposed

> **I Agree & Request Return**

### Judgement call

The warranty acknowledgment uses `I Certify & Agree`, where "certify" is
apt because the customer is attesting to facts about an incident. Here they
are accepting terms and asking for something, so "certify" would be slightly
off. If you would rather the two match for consistency across the site, say
so and I will use `I Certify & Agree` — **this is a preference call and I have
no strong view.**

Whatever is approved is stored in `affirmativeActionLabel` alongside the
pinned text and policy version, as the warranty one is.

---

## What this proposal deliberately does not draft

- **The full return policy page.** This is a point-of-decision
  acknowledgment and should link to the authoritative page, not replace it.
- **The restocking-fee arithmetic in prose.** The system computes it; copy
  restating a formula is copy that can silently disagree with the code.
- **Refund-timing promises.** The policy sets no processing-time commitment
  and I will not invent one.
- **Anything about merchandise credit mechanics** beyond the policy's own
  words. D5/D10 settle that it is native Shopify Store Credit, does not
  expire, is non-transferable and has no cash value — but whether and how to
  say that to a customer at this moment is a separate copy decision I am not
  pre-empting.
- **Tax wording.** D7 is explicit that CaratForUs does not maintain its own
  tax formula; Shopify is authoritative. Copy implying a specific tax outcome
  would contradict that.

---

## How this gets adopted, once approved

This sequence exists because the mechanism that makes it safe is unavailable
until the copy exists, and it is easy to forget once the blocker clears. It is
also recorded in `docs/specs/SLICE-4-BUY-NOW-RMA.md`.

1. The approved text goes into a **migration**. **Never `prisma/seed.ts`** —
   the seed does not run in production, which is exactly how the Luxury Steals
   acknowledgment policy version came to be missing there, returning HTTP 500
   so that no customer could complete a purchase. It was caught by a live
   gate, not by any test.
2. In the **same change**, its slug, version and text are added to
   `REQUIRED_POLICY_VERSIONS`, so `/health` reports any environment missing
   it.
3. Confirm whether `requiredPolicyVersionsMigrationFence.test.ts` covers the
   new slug automatically or needs it added — do not assume it generalises.
4. The `503 acknowledgment_copy_pending_approval` branch in
   `apps.carat.rma-intake.tsx` then becomes unreachable in a correctly
   provisioned environment.
